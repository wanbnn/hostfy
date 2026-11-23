const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const unzipper = require('unzipper');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { pool, initDb } = require('./db');
const { sign, requireAuth, setSession, COOKIE } = require('./auth');
const { detectProjectType } = require('./project-detect');
const runner = require('./runner-client');
const github = require('./github');
const projectDb = require('./project-db');
const files = require('./files');
const { encrypt, decrypt } = require('./secrets');

const app = express();
const PORT = Number(process.env.PORT || 1591);
const STORAGE = process.env.STORAGE_DIR || path.join(__dirname, '..', 'data', 'projects');
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 100);
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const upload = multer({ dest: '/tmp/hostly-uploads', limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } });
// Upload de vários arquivos (gerenciador de arquivos do projeto).
const uploadFiles = multer({ dest: '/tmp/hostly-uploads', limits: { fileSize: MAX_MB * 1024 * 1024, files: 20 } });
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"]
}}}));
// O corpo do painel é pequeno; só a edição de arquivos aceita payloads maiores.
const jsonSmall = express.json({ limit: '128kb' });
const jsonLarge = express.json({ limit: '4mb' });
app.use((req, res, next) => (req.path.endsWith('/files/content') ? jsonLarge : jsonSmall)(req, res, next));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));

const emailOk = s => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const slugOk = s => typeof s === 'string' && /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/.test(s);
const safeName = s => String(s || '').trim().slice(0, 80);
const repoSegment = s => /^[\w.-]{1,100}$/.test(String(s || ''));

const staticOrigin = () => process.env.PROJECTS_ORIGIN || 'http://localhost:1592';
const projectsDomain = () => String(process.env.PROJECTS_DOMAIN || '').trim();
const projectsScheme = () => process.env.PROJECTS_SCHEME || 'https';

// Todos os projetos usam subdomínio ({slug}.PROJECTS_DOMAIN) quando o domínio está
// configurado. Sem domínio, o site estático ainda fica acessível pelo caminho
// (/slug/) no servidor de estáticos.
function projectUrl(type, slug) {
  const domain = projectsDomain();
  if (domain) return `${projectsScheme()}://${slug}.${domain}/`;
  return `${staticOrigin()}/${slug}/`;
}

function parseEnv(input) {
  let source = input;
  if (typeof source === 'string') {
    if (!source.trim()) return {};
    try {
      source = JSON.parse(source);
    } catch {
      return null;
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(source)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (count >= 100) break;
    out[key] = String(value).slice(0, 4000);
    count += 1;
  }
  return out;
}

const PROJECT_COLUMNS = `p.id, p.name, p.slug, p.type, p.status, p.runtime_port, p.created_at,
  p.updated_at, p.source, p.repo_full_name, p.repo_ref, p.compose_file, p.web_service,
  p.web_port, p.env_json, p.last_deploy_at`;

function projectView(p) {
  return {
    ...p,
    env: p.env_json || {},
    env_json: undefined,
    url: projectUrl(p.type, p.slug),
  };
}

// ---------------------------------------------------------------------------
// Capacidades do servidor (runner/Docker)
// ---------------------------------------------------------------------------
let capsCache = { at: 0, value: { runtime: false, docker: false, dockerVersion: null, cleanupGraceHours: 24 } };
async function capabilities() {
  if (!runner.enabled()) return { runtime: false, docker: false, dockerVersion: null, cleanupGraceHours: 24 };
  if (Date.now() - capsCache.at < 30000) return capsCache.value;
  try {
    const value = await runner.capabilities();
    capsCache = { at: Date.now(), value };
    return value;
  } catch {
    return { runtime: false, docker: false, dockerVersion: null, cleanupGraceHours: 24 };
  }
}

async function requireAdmin(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT is_admin FROM users WHERE id=$1', [req.user.sub]);
    if (!rows[0] || !rows[0].is_admin)
      return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao verificar permissões.' });
  }
}

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------
app.post('/api/register', rateLimit({ windowMs: 60*60*1000, limit: 10 }), async (req,res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = req.body.password;
    if (!emailOk(email) || typeof password !== 'string' || password.length < 10 || password.length > 72)
      return res.status(400).json({ error: 'Informe um e-mail válido e senha entre 10 e 72 caracteres.' });
    const hash = await bcrypt.hash(password, 12);
    const isAdmin = ADMIN_EMAILS.includes(email);
    const { rows } = await pool.query(
      'INSERT INTO users(email,password_hash,is_admin) VALUES($1,$2,$3) RETURNING id,email,is_admin',
      [email, hash, isAdmin]
    );
    setSession(res, sign(rows[0]));
    res.status(201).json({ user: { id: rows[0].id, email: rows[0].email, isAdmin: rows[0].is_admin } });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    console.error(e); res.status(500).json({ error: 'Não foi possível criar a conta.' });
  }
});

app.post('/api/login', rateLimit({ windowMs: 15*60*1000, limit: 20 }), async (req,res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows } = await pool.query('SELECT id,email,password_hash,is_admin FROM users WHERE email=$1', [email]);
  if (!rows[0] || !(await bcrypt.compare(String(req.body.password || ''), rows[0].password_hash)))
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  let isAdmin = rows[0].is_admin;
  if (!isAdmin && ADMIN_EMAILS.includes(email)) {
    await pool.query('UPDATE users SET is_admin=TRUE WHERE id=$1', [rows[0].id]);
    isAdmin = true;
  }
  setSession(res, sign(rows[0]));
  res.json({ user: { id: rows[0].id, email: rows[0].email, isAdmin } });
});

app.post('/api/logout', (req,res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });

app.get('/api/me', requireAuth, async (req,res) => {
  const { rows } = await pool.query('SELECT id,email,is_admin FROM users WHERE id=$1', [req.user.sub]);
  if (!rows[0]) return res.status(401).json({ error: 'Sessão inválida.' });
  res.json({ user: { id: rows[0].id, email: rows[0].email, isAdmin: rows[0].is_admin } });
});

// ---------------------------------------------------------------------------
// Projetos
// ---------------------------------------------------------------------------
app.get('/api/projects', requireAuth, async (req,res) => {
  const { rows } = await pool.query(
    `SELECT ${PROJECT_COLUMNS}, (d.project_id IS NOT NULL) AS has_database
       FROM projects p LEFT JOIN project_databases d ON d.project_id=p.id
      WHERE p.user_id=$1 ORDER BY p.created_at DESC`,
    [req.user.sub]);
  const caps = await capabilities();
  res.json({
    projects: rows.map(projectView),
    projectsOrigin: staticOrigin(),
    projectsDomain: projectsDomain(),
    projectsScheme: projectsScheme(),
    runtimeEnabled: caps.runtime,
    dockerEnabled: caps.docker,
    dockerVersion: caps.dockerVersion,
    cleanupGraceHours: caps.cleanupGraceHours,
  });
});

async function extractZip(zipPath, destination, { strip = 0 } = {}) {
  await fs.mkdir(destination, { recursive: true });
  const directory = await unzipper.Open.file(zipPath);
  if (!directory.files.length || directory.files.length > 5000) throw new Error('O ZIP deve conter entre 1 e 5.000 arquivos.');
  let total = 0;
  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    let normalized = entry.path.replace(/\\/g, '/');
    if (strip > 0) {
      const parts = normalized.split('/');
      normalized = parts.slice(strip).join('/');
      if (!normalized) continue;
    }
    if (normalized.startsWith('/') || normalized.split('/').some(p => p === '..' || p === '') || normalized.includes('\0'))
      throw new Error('O ZIP contém um caminho inválido.');
    if (entry.type !== 'File') throw new Error('Links simbólicos e entradas especiais não são permitidos.');
    total += entry.uncompressedSize || 0;
    if (total > 300 * 1024 * 1024) throw new Error('O conteúdo descompactado excede 300 MB.');
    const target = path.resolve(destination, normalized);
    if (!target.startsWith(path.resolve(destination) + path.sep)) throw new Error('Caminho inválido.');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await new Promise((resolve,reject) => {
      const out = require('fs').createWriteStream(target, { flags: 'wx' });
      entry.stream().pipe(out).on('finish', resolve).on('error', reject);
    });
  }
}

const COMPOSE_NAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
async function resolveComposeFile(dir, requested) {
  if (requested) {
    const clean = path.basename(String(requested));
    try {
      await fs.access(path.join(dir, clean));
      return clean;
    } catch {
      throw new Error(`Arquivo "${clean}" não encontrado no projeto.`);
    }
  }
  for (const name of COMPOSE_NAMES) {
    try {
      await fs.access(path.join(dir, name));
      return name;
    } catch {}
  }
  return null;
}

async function ownedProjectFull(req) {
  const { rows } = await pool.query(
    `SELECT ${PROJECT_COLUMNS}, p.user_id, s.storage_key
       FROM projects p LEFT JOIN project_storage s ON s.project_id=p.id
      WHERE p.id=$1 AND p.user_id=$2`,
    [req.params.id, req.user.sub]
  );
  return rows[0];
}

// Projeto do usuário + a pasta onde os arquivos ficam no volume.
async function ownedProjectDir(req) {
  const project = await ownedProjectFull(req);
  if (!project || !project.storage_key) return null;
  return { project, dir: path.join(STORAGE, project.storage_key) };
}

// Aviso no painel (usado pelos bancos de projeto e pelo gerenciador de arquivos).
async function notifyUser({ userId, projectId, level, title, body, dedupeKey }) {
  if (!userId) return;
  await pool.query(
    `INSERT INTO notifications (user_id, project_id, level, title, body, meta, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [userId, projectId || null, level || 'info', title, body || null, JSON.stringify({}), dedupeKey || null]
  );
}

// Envia um projeto dinâmico (PHP/Node/Docker) para o runner conforme o tipo.
async function runnerDeploy(project, storageKey) {
  const env = project.env_json || {};
  if (project.type === 'docker') {
    return runner.dockerDeploy({
      projectId: String(project.id),
      storageKey,
      slug: project.slug,
      composeFile: project.compose_file || null,
      webService: project.web_service || null,
      webPort: project.web_port || null,
      env,
    });
  }
  return runner.deploy({
    projectId: String(project.id),
    storageKey,
    slug: project.slug,
    type: project.type,
    docroot: project.docroot || '',
    startCommand: project.start_command || null,
    env,
    rebuild: true,
  });
}

async function applyDeployResult(projectId, result) {
  await pool.query(
    `UPDATE projects SET status=$1, runtime_port=$2, updated_at=NOW(), last_deploy_at=NOW() WHERE id=$3`,
    [result.status || 'running', result.port || null, projectId]
  );
}

// Publicação por upload de ZIP (estático/PHP/Node).
app.post('/api/projects', requireAuth, upload.single('project'), async (req,res) => {
  const temp = req.file?.path;
  let finalDir, insertedId;
  try {
    if (!req.file) return res.status(400).json({ error: 'Envie um arquivo ZIP.' });
    const name = safeName(req.body.name);
    const slug = String(req.body.slug || '').trim().toLowerCase();
    if (!name || !slugOk(slug)) return res.status(400).json({ error: 'Informe nome e slug válido (letras minúsculas, números e hífen).' });
    const exists = await pool.query('SELECT 1 FROM projects WHERE slug=$1', [slug]);
    if (exists.rowCount) return res.status(409).json({ error: 'Este slug já está em uso.' });

    const requested = ['auto','static','php','node'].includes(String(req.body.type)) ? String(req.body.type) : 'auto';
    const env = parseEnv(req.body.env) || {};
    const storageKey = crypto.randomUUID();
    finalDir = path.join(STORAGE, storageKey);
    await extractZip(temp, finalDir);

    const detected = detectProjectType(finalDir);
    const type = requested === 'auto' ? detected.type : requested;

    if (type === 'static' && !detected.hasIndexHtml)
      throw new Error('Projetos estáticos precisam conter index.html na raiz do ZIP.');
    if (type === 'php' && !detected.hasPhp)
      throw new Error('Nenhum arquivo PHP encontrado (ex.: index.php na raiz ou em public/).');
    if (type === 'node' && !detected.hasPackage)
      throw new Error('Projetos Node precisam conter package.json na raiz do ZIP.');
    if (type === 'node' && !detected.startCommand)
      throw new Error('package.json sem script "start" e sem arquivo de entrada (main/server.js/app.js/index.js).');
    if (type !== 'static' && !runner.enabled())
      throw new Error('Execução de PHP/Node não está habilitada neste servidor (runner não configurado).');

    const { rows } = await pool.query(
      `INSERT INTO projects(user_id,name,slug,type,docroot,start_command,status,source,env_json)
       VALUES($1,$2,$3,$4,$5,$6,$7,'upload',$8)
       RETURNING ${PROJECT_COLUMNS.replace(/p\./g, '')}`,
      [req.user.sub, name, slug, type, detected.docroot || null, detected.startCommand || null, type === 'static' ? 'running' : 'deploying', JSON.stringify(env)]
    );
    insertedId = rows[0].id;
    await pool.query('INSERT INTO project_storage(project_id,storage_key) VALUES($1,$2)', [insertedId, storageKey]);

    let project = { ...rows[0], storage_key: storageKey, env_json: env };
    if (type !== 'static') {
      const result = await runnerDeploy(project, storageKey);
      await applyDeployResult(insertedId, result);
      project.status = result.status || 'running';
      project.runtime_port = result.port || null;
    }

    res.status(201).json({ project: projectView(project), url: projectUrl(type, slug) });
  } catch(e) {
    if (insertedId) {
      await runner.remove(String(insertedId)).catch(() => {});
      await pool.query('DELETE FROM projects WHERE id=$1', [insertedId]).catch(() => {});
    }
    if (finalDir) await fs.rm(finalDir, { recursive: true, force: true }).catch(()=>{});
    if (e.code === '23505') return res.status(409).json({ error: 'Este slug já está em uso.' });
    console.error(e); res.status(400).json({ error: e.message || 'Falha ao publicar projeto.' });
  } finally { if (temp) await fs.rm(temp, { force: true }).catch(()=>{}); }
});

// Publicação de projeto Docker a partir de ZIP.
app.post('/api/projects/docker', requireAuth, upload.single('project'), async (req,res) => {
  const temp = req.file?.path;
  let finalDir, insertedId;
  try {
    if (!req.file) return res.status(400).json({ error: 'Envie um ZIP com o docker-compose.yml.' });
    const name = safeName(req.body.name);
    const slug = String(req.body.slug || '').trim().toLowerCase();
    if (!name || !slugOk(slug)) return res.status(400).json({ error: 'Informe nome e slug válido.' });
    const exists = await pool.query('SELECT 1 FROM projects WHERE slug=$1', [slug]);
    if (exists.rowCount) return res.status(409).json({ error: 'Este slug já está em uso.' });
    const caps = await capabilities();
    if (!caps.docker) return res.status(400).json({ error: 'Execução de projetos Docker não está habilitada neste servidor.' });
    const env = parseEnv(req.body.env);
    if (env === null) return res.status(400).json({ error: 'Variáveis de ambiente inválidas (envie um objeto JSON).' });

    const storageKey = crypto.randomUUID();
    finalDir = path.join(STORAGE, storageKey);
    await extractZip(temp, finalDir);
    const composeFile = await resolveComposeFile(finalDir, req.body.compose_file);
    if (!composeFile) throw new Error('Não encontrei docker-compose.yml (ou compose.yaml) no ZIP.');

    const webService = safeName(req.body.web_service) || null;
    const webPort = Number(req.body.web_port) || null;
    const { rows } = await pool.query(
      `INSERT INTO projects(user_id,name,slug,type,status,source,compose_file,web_service,web_port,env_json)
       VALUES($1,$2,$3,'docker','deploying','upload',$4,$5,$6,$7)
       RETURNING ${PROJECT_COLUMNS.replace(/p\./g, '')}`,
      [req.user.sub, name, slug, composeFile, webService, webPort, JSON.stringify(env)]
    );
    insertedId = rows[0].id;
    await pool.query('INSERT INTO project_storage(project_id,storage_key) VALUES($1,$2)', [insertedId, storageKey]);

    const result = await runnerDeploy({ ...rows[0], storage_key: storageKey, env_json: env }, storageKey);
    await pool.query(
      `UPDATE projects SET status=$1, runtime_port=$2, web_service=$3, web_port=$4, updated_at=NOW(), last_deploy_at=NOW() WHERE id=$5`,
      [result.status || 'running', result.port || null, result.service || webService, result.port || webPort, insertedId]
    );
    res.status(201).json({
      project: projectView({ ...rows[0], status: result.status || 'running', runtime_port: result.port || null, web_service: result.service || webService, web_port: result.port || webPort, env_json: env }),
      url: projectUrl('docker', slug),
    });
  } catch(e) {
    if (insertedId) {
      await runner.remove(String(insertedId)).catch(() => {});
      await pool.query('DELETE FROM projects WHERE id=$1', [insertedId]).catch(() => {});
    }
    if (finalDir) await fs.rm(finalDir, { recursive: true, force: true }).catch(()=>{});
    if (e.code === '23505') return res.status(409).json({ error: 'Este slug já está em uso.' });
    console.error(e); res.status(400).json({ error: e.message || 'Falha ao publicar projeto Docker.' });
  } finally { if (temp) await fs.rm(temp, { force: true }).catch(()=>{}); }
});

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------
async function githubToken(userId) {
  const { rows } = await pool.query('SELECT token_enc FROM github_accounts WHERE user_id=$1', [userId]);
  if (!rows[0]) return null;
  return decrypt(rows[0].token_enc);
}

app.get('/api/github', requireAuth, async (req,res) => {
  const { rows } = await pool.query('SELECT login, avatar_url, scopes, created_at FROM github_accounts WHERE user_id=$1', [req.user.sub]);
  if (!rows[0]) return res.json({ connected: false });
  res.json({ connected: true, login: rows[0].login, avatarUrl: rows[0].avatar_url, scopes: rows[0].scopes, connectedAt: rows[0].created_at });
});

app.post('/api/github/connect', requireAuth, async (req,res) => {
  try {
    const token = String(req.body.token || '').trim();
    if (!token || token.length > 255) return res.status(400).json({ error: 'Informe um Personal Access Token válido.' });
    const user = await github.getUser(token);
    await pool.query(
      `INSERT INTO github_accounts(user_id, login, token_enc, avatar_url, scopes, updated_at)
       VALUES($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (user_id) DO UPDATE SET login=EXCLUDED.login, token_enc=EXCLUDED.token_enc,
         avatar_url=EXCLUDED.avatar_url, scopes=EXCLUDED.scopes, updated_at=NOW()`,
      [req.user.sub, user.login, encrypt(token), user.avatarUrl, user.scopes]
    );
    res.json({ connected: true, login: user.login, avatarUrl: user.avatarUrl, scopes: user.scopes });
  } catch (e) {
    const message = e.status === 401 ? 'Token inválido ou expirado.' : e.message;
    res.status(400).json({ error: message || 'Não foi possível validar o token do GitHub.' });
  }
});

app.delete('/api/github', requireAuth, async (req,res) => {
  await pool.query('DELETE FROM github_accounts WHERE user_id=$1', [req.user.sub]);
  res.json({ ok: true });
});

app.get('/api/github/repos', requireAuth, async (req,res) => {
  const token = await githubToken(req.user.sub);
  if (!token) return res.status(400).json({ error: 'Conecte sua conta do GitHub primeiro.' });
  try {
    const repos = await github.listRepos(token, req.query.page || 1);
    res.json({ repos });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/github/repos/:owner/:repo/branches', requireAuth, async (req,res) => {
  const token = await githubToken(req.user.sub);
  if (!token) return res.status(400).json({ error: 'Conecte sua conta do GitHub primeiro.' });
  if (!repoSegment(req.params.owner) || !repoSegment(req.params.repo))
    return res.status(400).json({ error: 'Repositório inválido.' });
  try {
    const branches = await github.listBranches(token, `${req.params.owner}/${req.params.repo}`);
    res.json({ branches });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Publicação de projeto Docker a partir de um repositório do GitHub.
app.post('/api/projects/docker/github', requireAuth, async (req,res) => {
  let finalDir, insertedId, temp;
  try {
    const name = safeName(req.body.name);
    const slug = String(req.body.slug || '').trim().toLowerCase();
    const owner = String(req.body.owner || '').trim();
    const repo = String(req.body.repo || '').trim();
    const ref = String(req.body.ref || '').trim().slice(0, 120);
    if (!name || !slugOk(slug)) return res.status(400).json({ error: 'Informe nome e slug válido.' });
    if (!repoSegment(owner) || !repoSegment(repo)) return res.status(400).json({ error: 'Repositório inválido.' });
    const exists = await pool.query('SELECT 1 FROM projects WHERE slug=$1', [slug]);
    if (exists.rowCount) return res.status(409).json({ error: 'Este slug já está em uso.' });
    const caps = await capabilities();
    if (!caps.docker) return res.status(400).json({ error: 'Execução de projetos Docker não está habilitada neste servidor.' });
    const env = parseEnv(req.body.env);
    if (env === null) return res.status(400).json({ error: 'Variáveis de ambiente inválidas.' });

    const token = await githubToken(req.user.sub);
    const fullName = `${owner}/${repo}`;
    let buffer;
    try {
      buffer = await github.downloadZip(token, fullName, ref || null);
    } catch (e) {
      if (!token) throw new Error('Para repositórios privados, conecte sua conta do GitHub.');
      throw e;
    }
    temp = path.join('/tmp/hostly-uploads', `gh-${crypto.randomUUID()}.zip`);
    await fs.writeFile(temp, buffer);

    const storageKey = crypto.randomUUID();
    finalDir = path.join(STORAGE, storageKey);
    await extractZip(temp, finalDir, { strip: 1 });
    const composeFile = await resolveComposeFile(finalDir, req.body.compose_file);
    if (!composeFile) throw new Error('Não encontrei docker-compose.yml (ou compose.yaml) no repositório.');

    const webService = safeName(req.body.web_service) || null;
    const webPort = Number(req.body.web_port) || null;
    const { rows } = await pool.query(
      `INSERT INTO projects(user_id,name,slug,type,status,source,repo_full_name,repo_ref,compose_file,web_service,web_port,env_json)
       VALUES($1,$2,$3,'docker','deploying','github',$4,$5,$6,$7,$8,$9)
       RETURNING ${PROJECT_COLUMNS.replace(/p\./g, '')}`,
      [req.user.sub, name, slug, fullName, ref || null, composeFile, webService, webPort, JSON.stringify(env)]
    );
    insertedId = rows[0].id;
    await pool.query('INSERT INTO project_storage(project_id,storage_key) VALUES($1,$2)', [insertedId, storageKey]);

    const result = await runnerDeploy({ ...rows[0], storage_key: storageKey, env_json: env }, storageKey);
    await pool.query(
      `UPDATE projects SET status=$1, runtime_port=$2, web_service=$3, web_port=$4, updated_at=NOW(), last_deploy_at=NOW() WHERE id=$5`,
      [result.status || 'running', result.port || null, result.service || webService, result.port || webPort, insertedId]
    );
    res.status(201).json({
      project: projectView({ ...rows[0], status: result.status || 'running', runtime_port: result.port || null, web_service: result.service || webService, web_port: result.port || webPort, env_json: env }),
      url: projectUrl('docker', slug),
    });
  } catch(e) {
    if (insertedId) {
      await runner.remove(String(insertedId)).catch(() => {});
      await pool.query('DELETE FROM projects WHERE id=$1', [insertedId]).catch(() => {});
    }
    if (finalDir) await fs.rm(finalDir, { recursive: true, force: true }).catch(()=>{});
    if (e.code === '23505') return res.status(409).json({ error: 'Este slug já está em uso.' });
    console.error(e); res.status(400).json({ error: e.message || 'Falha ao publicar projeto do GitHub.' });
  } finally { if (temp) await fs.rm(temp, { force: true }).catch(()=>{}); }
});

// ---------------------------------------------------------------------------
// Edição e ciclo de vida dos projetos
// ---------------------------------------------------------------------------
app.patch('/api/projects/:id', requireAuth, async (req,res) => {
  try {
    const project = await ownedProjectFull(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });

    const sets = [];
    const vals = [];
    let i = 1;
    const push = (col, value) => { sets.push(`${col}=$${i++}`); vals.push(value); };
    let mayNeedRedeploy = false;

    if (req.body.name !== undefined) {
      const name = safeName(req.body.name);
      if (!name) return res.status(400).json({ error: 'Nome inválido.' });
      push('name', name);
    }
    if (req.body.slug !== undefined) {
      const slug = String(req.body.slug).trim().toLowerCase();
      if (!slugOk(slug)) return res.status(400).json({ error: 'Slug inválido.' });
      if (slug !== project.slug) {
        const dup = await pool.query('SELECT 1 FROM projects WHERE slug=$1 AND id<>$2', [slug, project.id]);
        if (dup.rowCount) return res.status(409).json({ error: 'Este slug já está em uso.' });
        push('slug', slug);
        mayNeedRedeploy = true;
      }
    }
    if (req.body.env !== undefined) {
      const env = parseEnv(req.body.env);
      if (env === null) return res.status(400).json({ error: 'Variáveis de ambiente inválidas.' });
      push('env_json', JSON.stringify(env));
      mayNeedRedeploy = true;
    }
    if (req.body.docroot !== undefined && (project.type === 'php' || project.type === 'node')) {
      push('docroot', req.body.docroot ? path.basename(String(req.body.docroot)) : null);
      mayNeedRedeploy = true;
    }
    if (req.body.web_service !== undefined && project.type === 'docker') {
      push('web_service', safeName(req.body.web_service) || null);
      mayNeedRedeploy = true;
    }
    if (req.body.web_port !== undefined && project.type === 'docker') {
      push('web_port', Number(req.body.web_port) || null);
      mayNeedRedeploy = true;
    }

    if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar.' });

    sets.push('updated_at=NOW()');
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE projects SET ${sets.join(', ')} WHERE id=$${i} RETURNING ${PROJECT_COLUMNS.replace(/p\./g, '')}`,
      vals
    );
    let updated = rows[0];

    if (mayNeedRedeploy && project.type !== 'static' && runner.enabled()) {
      const merged = { ...project, ...updated, storage_key: project.storage_key, env_json: parseEnv(project.env_json) || updated.env_json };
      try {
        const result = await runnerDeploy({ ...merged, env_json: updated.env_json }, project.storage_key);
        await applyDeployResult(project.id, result);
        updated.status = result.status || 'running';
        updated.runtime_port = result.port || null;
      } catch (e) {
        updated.status = 'error';
        await pool.query(`UPDATE projects SET status='error', updated_at=NOW() WHERE id=$1`, [project.id]);
        console.error(e);
      }
    }

    res.json({ project: projectView({ ...updated, env_json: updated.env_json }), url: projectUrl(updated.type, updated.slug) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Não foi possível atualizar o projeto.' });
  }
});

// Redeploy: baixa novamente do GitHub (se for o caso) e sobe de novo.
app.post('/api/projects/:id/deploy', requireAuth, async (req,res) => {
  try {
    const project = await ownedProjectFull(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    if (project.type === 'static') return res.status(400).json({ error: 'Sites estáticos não precisam de redeploy.' });
    if (!runner.enabled()) return res.status(400).json({ error: 'Runner não configurado.' });

    if (project.source === 'github' && project.repo_full_name) {
      const token = await githubToken(req.user.sub);
      const buffer = await github.downloadZip(token, project.repo_full_name, project.repo_ref);
      const temp = path.join('/tmp/hostly-uploads', `gh-${crypto.randomUUID()}.zip`);
      await fs.writeFile(temp, buffer);
      const dir = path.join(STORAGE, project.storage_key);
      await fs.rm(dir, { recursive: true, force: true });
      await extractZip(temp, dir, { strip: 1 });
      await fs.rm(temp, { force: true }).catch(()=>{});
    }

    await pool.query(`UPDATE projects SET status='deploying', updated_at=NOW() WHERE id=$1`, [project.id]);
    const result = await runnerDeploy(project, project.storage_key);
    await applyDeployResult(project.id, result);
    res.json({ ok: true, status: result.status || 'running', url: projectUrl(project.type, project.slug) });
  } catch (e) {
    await pool.query(`UPDATE projects SET status='error', updated_at=NOW() WHERE id=$1`, [req.params.id]).catch(()=>{});
    console.error(e);
    res.status(502).json({ error: e.message || 'Não foi possível refazer o deploy.' });
  }
});

app.get('/api/projects/:id/logs', requireAuth, async (req,res) => {
  try {
    const project = await ownedProjectFull(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    if (project.type === 'static' || !runner.enabled()) return res.json({ logs: [] });
    res.json(await runner.logs(String(project.id)));
  } catch (e) { res.status(502).json({ error: e.message || 'Não foi possível obter os logs.' }); }
});

app.get('/api/projects/:id/stats', requireAuth, async (req,res) => {
  try {
    const project = await ownedProjectFull(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    if (project.type === 'static' || !runner.enabled()) return res.json({ status: 'running', cpuPercent: 0, memBytes: 0, containers: 0 });
    res.json(await runner.stats(String(project.id)));
  } catch (e) { res.status(502).json({ error: e.message || 'Não foi possível obter as métricas.' }); }
});

app.post('/api/projects/:id/restart', requireAuth, async (req,res) => {
  try {
    const project = await ownedProjectFull(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    if (project.type === 'static' || !runner.enabled())
      return res.status(400).json({ error: 'Somente projetos PHP/Node/Docker podem ser reiniciados.' });
    const result = await runner.restart(String(project.id));
    await applyDeployResult(project.id, result);
    res.json({ ok: true, status: result.status });
  } catch (e) { res.status(502).json({ error: e.message || 'Não foi possível reiniciar o projeto.' }); }
});

app.post('/api/projects/:id/stop', requireAuth, async (req,res) => {
  try {
    const project = await ownedProjectFull(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    if (project.type === 'static' || !runner.enabled())
      return res.status(400).json({ error: 'Somente projetos PHP/Node/Docker podem ser parados.' });
    await runner.stop(String(project.id));
    await pool.query('UPDATE projects SET status=$1, updated_at=NOW() WHERE id=$2', ['stopped', project.id]);
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message || 'Não foi possível parar o projeto.' }); }
});

app.delete('/api/projects/:id', requireAuth, async (req,res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      'SELECT p.id, p.type, s.storage_key FROM projects p LEFT JOIN project_storage s ON s.project_id=p.id WHERE p.id=$1 AND p.user_id=$2 FOR UPDATE OF p',
      [req.params.id, req.user.sub]
    );
    if (!owned.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Projeto não encontrado.' }); }
    const { id, type, storage_key } = owned.rows[0];
    if (type !== 'static' && runner.enabled()) await runner.remove(String(id)).catch(() => {});
    // O banco do projeto sai junto — guardamos os dados antes do DELETE (o
    // ON DELETE CASCADE apagaria o registro de project_databases).
    const database = await client.query('SELECT * FROM project_databases WHERE project_id=$1', [id]);
    await client.query('DELETE FROM projects WHERE id=$1', [id]);
    await client.query('COMMIT');
    if (database.rows[0]) await projectDb.dropDatabase(database.rows[0]).catch(() => {});
    if (storage_key) await fs.rm(path.join(STORAGE, storage_key), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error(e); res.status(500).json({ error: 'Não foi possível excluir o projeto.' });
  } finally { client.release(); }
});

// ---------------------------------------------------------------------------
// Banco de dados do projeto
//
// Cada projeto tem no máximo um banco (garantido pelo PRIMARY KEY de
// project_databases). O banco vive na mesma instância do PostgreSQL do
// serviço "db" — nenhum contêiner ou imagem extra é criado.
// ---------------------------------------------------------------------------

// Escreve as variáveis de conexão no projeto e reinicia o app (quando existe).
async function applyDatabaseEnv(project, database) {
  const env = parseEnv(project.env_json) || {};
  env.DATABASE_URL = database.url;
  env.DB_HOST = database.host;
  env.DB_PORT = String(database.port);
  env.DB_NAME = database.name;
  env.DB_USER = database.user;
  env.DB_PASSWORD = database.password;
  await pool.query('UPDATE projects SET env_json=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(env), project.id]);
  if (project.type === 'static' || !runner.enabled() || !project.storage_key) return env;
  try {
    const result = await runnerDeploy({ ...project, env_json: env }, project.storage_key);
    await applyDeployResult(project.id, result);
  } catch (e) {
    console.error('Falha ao reiniciar o projeto após criar o banco:', e.message);
  }
  return env;
}

async function removeDatabaseEnv(project) {
  const env = parseEnv(project.env_json) || {};
  for (const key of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) delete env[key];
  await pool.query('UPDATE projects SET env_json=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(env), project.id]);
  if (project.type === 'static' || !runner.enabled() || !project.storage_key) return env;
  try {
    const result = await runnerDeploy({ ...project, env_json: env }, project.storage_key);
    await applyDeployResult(project.id, result);
  } catch (e) {
    console.error('Falha ao reiniciar o projeto após remover o banco:', e.message);
  }
  return env;
}

app.get('/api/projects/:id/database', requireAuth, async (req,res) => {
  try {
    const project = await ownedProjectFull(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const record = await projectDb.getDatabase(project.id);
    if (!record) return res.json({ database: null, alertBytes: projectDb.ALERT_BYTES, alertMb: projectDb.ALERT_MB });
    const refreshed = await projectDb
      .refreshSize(record, {
        notify: payload => notifyUser({ userId: req.user.sub, projectId: project.id, ...payload }),
      })
      .catch(() => record);
    res.json({ database: projectDb.describe(refreshed), alertBytes: projectDb.ALERT_BYTES, alertMb: projectDb.ALERT_MB });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Não foi possível consultar o banco do projeto.' });
  }
});

app.post('/api/projects/:id/database', requireAuth, async (req,res) => {
  try {
    const project = await ownedProjectFull(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const database = await projectDb.createDatabase(project);
    await applyDatabaseEnv(project, database);
    res.status(201).json({ database });
  } catch (e) {
    console.error(e);
    const conflict = /já possui um banco/i.test(e.message);
    res.status(conflict ? 409 : 500).json({ error: e.message || 'Não foi possível criar o banco de dados.' });
  }
});

app.post('/api/projects/:id/database/password', requireAuth, async (req,res) => {
  try {
    const project = await ownedProjectFull(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const record = await projectDb.getDatabase(project.id);
    if (!record) return res.status(404).json({ error: 'Este projeto ainda não tem banco de dados.' });
    await projectDb.resetPassword(record);
    const updated = await projectDb.getDatabase(project.id);
    const database = projectDb.describe(updated);
    await applyDatabaseEnv(project, database);
    res.json({ database });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Não foi possível redefinir a senha.' });
  }
});

app.delete('/api/projects/:id/database', requireAuth, async (req,res) => {
  try {
    const project = await ownedProjectFull(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const record = await projectDb.getDatabase(project.id);
    if (!record) return res.status(404).json({ error: 'Este projeto não tem banco de dados.' });
    await projectDb.dropDatabase(record);
    await pool.query('DELETE FROM project_databases WHERE project_id=$1', [project.id]);
    await removeDatabaseEnv(project);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Não foi possível excluir o banco de dados.' });
  }
});

app.get('/api/projects/:id/database/tables', requireAuth, async (req,res) => {
  try {
    const project = await ownedProjectFull(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const record = await projectDb.getDatabase(project.id);
    if (!record) return res.status(404).json({ error: 'Este projeto ainda não tem banco de dados.' });
    res.json({ tables: await projectDb.listTables(record) });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message || 'Não foi possível listar as tabelas.' });
  }
});

app.post('/api/projects/:id/database/query', requireAuth, async (req,res) => {
  try {
    const project = await ownedProjectFull(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const record = await projectDb.getDatabase(project.id);
    if (!record) return res.status(404).json({ error: 'Este projeto ainda não tem banco de dados.' });
    res.json(await projectDb.runQuery(record, req.body.sql));
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || 'Não foi possível executar a instrução.' });
  }
});

// ---------------------------------------------------------------------------
// Gerenciador de arquivos do projeto
//
// Permite listar, criar, editar, renomear, enviar e excluir arquivos sem
// precisar apagar e republicar o projeto.
// ---------------------------------------------------------------------------

function safeUploadName(original) {
  const base = path.basename(String(original || '').replace(/\\/g, '/'));
  const clean = base.replace(/[^A-Za-z0-9._\- ]+/g, '_').replace(/^\.+/, '').trim();
  return clean || 'arquivo';
}

app.get('/api/projects/:id/files', requireAuth, async (req,res) => {
  try {
    const ctx = await ownedProjectDir(req);
    if (!ctx) return res.status(404).json({ error: 'Projeto não encontrado.' });
    res.json(await files.listDirectory(ctx.dir, req.query.path || ''));
  } catch (e) {
    res.status(400).json({ error: e.message || 'Não foi possível listar a pasta.' });
  }
});

app.get('/api/projects/:id/files/content', requireAuth, async (req,res) => {
  try {
    const ctx = await ownedProjectDir(req);
    if (!ctx) return res.status(404).json({ error: 'Projeto não encontrado.' });
    res.json(await files.readTextFile(ctx.dir, req.query.path || ''));
  } catch (e) {
    res.status(400).json({ error: e.message || 'Não foi possível abrir o arquivo.' });
  }
});

app.get('/api/projects/:id/files/download', requireAuth, async (req,res) => {
  try {
    const ctx = await ownedProjectDir(req);
    if (!ctx) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const target = files.resolveInside(ctx.dir, req.query.path || '');
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat || !stat.isFile()) return res.status(404).json({ error: 'Arquivo não encontrado.' });
    res.download(target, path.basename(target));
  } catch (e) {
    res.status(400).json({ error: e.message || 'Não foi possível baixar o arquivo.' });
  }
});

app.put('/api/projects/:id/files/content', requireAuth, async (req,res) => {
  try {
    const ctx = await ownedProjectDir(req);
    if (!ctx) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const file = await files.writeTextFile(ctx.dir, req.body.path, req.body.content);
    res.json({ file });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Não foi possível salvar o arquivo.' });
  }
});

app.post('/api/projects/:id/files/dir', requireAuth, async (req,res) => {
  try {
    const ctx = await ownedProjectDir(req);
    if (!ctx) return res.status(404).json({ error: 'Projeto não encontrado.' });
    res.json(await files.createDirectory(ctx.dir, req.body.path));
  } catch (e) {
    res.status(400).json({ error: e.message || 'Não foi possível criar a pasta.' });
  }
});

app.post('/api/projects/:id/files/rename', requireAuth, async (req,res) => {
  try {
    const ctx = await ownedProjectDir(req);
    if (!ctx) return res.status(404).json({ error: 'Projeto não encontrado.' });
    res.json(await files.renameEntry(ctx.dir, req.body.from, req.body.to));
  } catch (e) {
    res.status(400).json({ error: e.message || 'Não foi possível renomear.' });
  }
});

app.delete('/api/projects/:id/files', requireAuth, async (req,res) => {
  try {
    const ctx = await ownedProjectDir(req);
    if (!ctx) return res.status(404).json({ error: 'Projeto não encontrado.' });
    const target = req.query.path !== undefined ? req.query.path : req.body.path;
    res.json(await files.removeEntry(ctx.dir, target));
  } catch (e) {
    res.status(400).json({ error: e.message || 'Não foi possível excluir.' });
  }
});

app.post(
  '/api/projects/:id/files/upload',
  requireAuth,
  uploadFiles.fields([{ name: 'files', maxCount: 20 }, { name: 'file', maxCount: 1 }]),
  async (req,res) => {
    const uploaded = req.files || {};
    const list = [...(uploaded.files || []), ...(uploaded.file || [])];
    try {
      const ctx = await ownedProjectDir(req);
      if (!ctx) return res.status(404).json({ error: 'Projeto não encontrado.' });
      if (!list.length) return res.status(400).json({ error: 'Selecione ao menos um arquivo.' });
      const folder = files.normalizeRelative(req.body.path || '');
      const saved = [];
      for (const file of list) {
        const name = safeUploadName(file.originalname);
        saved.push(await files.saveUploadedFile(ctx.dir, files.joinRelative(folder, name), file.path));
      }
      res.status(201).json({ files: saved });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Não foi possível enviar os arquivos.' });
    } finally {
      for (const file of list) await fs.rm(file.path, { force: true }).catch(() => {});
    }
  }
);

// ---------------------------------------------------------------------------
// Notificações
// ---------------------------------------------------------------------------
app.get('/api/notifications', requireAuth, async (req,res) => {
  const { rows } = await pool.query(
    `SELECT id, project_id, level, title, body, action, meta, created_at, read_at
       FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [req.user.sub]
  );
  res.json({ notifications: rows, unread: rows.filter(r => !r.read_at).length });
});

app.post('/api/notifications/read-all', requireAuth, async (req,res) => {
  await pool.query('UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL', [req.user.sub]);
  res.json({ ok: true });
});

app.post('/api/notifications/:id/read', requireAuth, async (req,res) => {
  await pool.query('UPDATE notifications SET read_at=NOW() WHERE id=$1 AND user_id=$2', [req.params.id, req.user.sub]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Sistema / manutenção Docker (administrador)
// ---------------------------------------------------------------------------
app.get('/api/system/docker', requireAuth, requireAdmin, async (req,res) => {
  try {
    const caps = await capabilities();
    let df = [];
    let containers = [];
    if (caps.docker && runner.enabled()) {
      const data = await runner.dockerDf().catch(() => ({ df: [], containers: [] }));
      df = data.df || [];
      containers = data.containers || [];
    }
    const { rows: candidates } = await pool.query(
      `SELECT id, kind, name, project_id, owner_id, reason, size_bytes, scheduled_for, status, discovered_at
         FROM cleanup_candidates WHERE status NOT IN ('executed','skipped')
        ORDER BY scheduled_for ASC NULLS LAST LIMIT 200`
    );
    const { rows: cleanupProjects } = await pool.query(
      `SELECT id, name, slug, status FROM projects WHERE type='docker' ORDER BY created_at DESC`
    );
    res.json({ dockerEnabled: caps.docker, dockerVersion: caps.dockerVersion, graceHours: caps.cleanupGraceHours, df, containers, candidates, dockerProjects: cleanupProjects });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Não foi possível consultar o Docker.' });
  }
});

app.post('/api/system/cleanup/scan', requireAuth, requireAdmin, async (req,res) => {
  try {
    if (!runner.enabled()) return res.status(400).json({ error: 'Runner não configurado.' });
    res.json(await runner.cleanupScan());
  } catch (e) { res.status(502).json({ error: e.message || 'Falha ao analisar o Docker.' }); }
});

app.post('/api/system/cleanup/run', requireAuth, requireAdmin, async (req,res) => {
  try {
    if (!runner.enabled()) return res.status(400).json({ error: 'Runner não configurado.' });
    res.json(await runner.cleanupRun());
  } catch (e) { res.status(502).json({ error: e.message || 'Falha ao executar a limpeza.' }); }
});

app.post('/api/system/prune', requireAuth, requireAdmin, async (req,res) => {
  try {
    if (!runner.enabled()) return res.status(400).json({ error: 'Runner não configurado.' });
    const force = Boolean(req.body.force);
    const volumes = Boolean(req.body.volumes);
    res.json(await runner.dockerPrune({ force, volumes }));
  } catch (e) { res.status(502).json({ error: e.message || 'Falha ao executar o prune.' }); }
});

// ---------------------------------------------------------------------------
// Fallback SPA (rotas do painel) e erros
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path === '/api' || req.path.startsWith('/api/') || path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err,req,res,next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Arquivo maior que ${MAX_MB} MB.` : 'Falha no upload.' });
  res.status(500).json({ error: 'Erro interno.' });
});

(async () => {
  await fs.mkdir(STORAGE, { recursive: true });
  await initDb();
  const server = app.listen(PORT, () => console.log(`Hostfy app listening on ${PORT}`));
  // Deploys de Docker Compose podem levar vários minutos (build).
  server.requestTimeout = 0;
  server.headersTimeout = 60 * 60 * 1000;
  server.keepAliveTimeout = 60 * 1000;
})().catch(e => { console.error(e); process.exit(1); });