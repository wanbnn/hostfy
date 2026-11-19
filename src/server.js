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

const app = express();
const PORT = Number(process.env.PORT || 1591);
const STORAGE = process.env.STORAGE_DIR || path.join(__dirname, '..', 'data', 'projects');
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 100);
const upload = multer({ dest: '/tmp/hostly-uploads', limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } });
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"]
}}}));
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));

const emailOk = s => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const slugOk = s => typeof s === 'string' && /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/.test(s);
const safeName = s => String(s || '').trim().slice(0, 80);

const staticOrigin = () => process.env.PROJECTS_ORIGIN || 'http://localhost:1592';
const projectsDomain = () => String(process.env.PROJECTS_DOMAIN || '').trim();
const projectsScheme = () => process.env.PROJECTS_SCHEME || 'https';

// Projetos estáticos seguem no endereço por caminho; PHP/Node usam subdomínio.
function projectUrl(type, slug) {
  const domain = projectsDomain();
  if (type === 'static' || !domain) return `${staticOrigin()}/${slug}/`;
  return `${projectsScheme()}://${slug}.${domain}/`;
}

app.post('/api/register', rateLimit({ windowMs: 60*60*1000, limit: 10 }), async (req,res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = req.body.password;
    if (!emailOk(email) || typeof password !== 'string' || password.length < 10 || password.length > 72)
      return res.status(400).json({ error: 'Informe um e-mail válido e senha entre 10 e 72 caracteres.' });
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email', [email,hash]);
    setSession(res, sign(rows[0]));
    res.status(201).json({ user: rows[0] });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    console.error(e); res.status(500).json({ error: 'Não foi possível criar a conta.' });
  }
});
app.post('/api/login', rateLimit({ windowMs: 15*60*1000, limit: 20 }), async (req,res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows } = await pool.query('SELECT id,email,password_hash FROM users WHERE email=$1', [email]);
  if (!rows[0] || !(await bcrypt.compare(String(req.body.password || ''), rows[0].password_hash)))
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  setSession(res, sign(rows[0])); res.json({ user: { id: rows[0].id, email: rows[0].email } });
});
app.post('/api/logout', (req,res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });
app.get('/api/me', requireAuth, (req,res) => res.json({ user: { id: req.user.sub, email: req.user.email } }));
app.get('/api/projects', requireAuth, async (req,res) => {
  const { rows } = await pool.query(
    'SELECT id,name,slug,type,status,runtime_port,created_at FROM projects WHERE user_id=$1 ORDER BY created_at DESC',
    [req.user.sub]);
  const projects = rows.map(p => ({ ...p, url: projectUrl(p.type, p.slug) }));
  res.json({
    projects,
    projectsOrigin: staticOrigin(),
    projectsDomain: projectsDomain(),
    projectsScheme: projectsScheme(),
    runtimeEnabled: runner.enabled(),
  });
});

async function extractZip(zipPath, destination) {
  await fs.mkdir(destination, { recursive: true });
  const directory = await unzipper.Open.file(zipPath);
  if (!directory.files.length || directory.files.length > 5000) throw new Error('O ZIP deve conter entre 1 e 5.000 arquivos.');
  let total = 0;
  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    const normalized = entry.path.replace(/\\/g, '/');
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
      `INSERT INTO projects(user_id,name,slug,type,docroot,start_command,status)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,slug,type,status,created_at`,
      [req.user.sub, name, slug, type, detected.docroot || null, detected.startCommand || null, type === 'static' ? 'running' : 'deploying']
    );
    insertedId = rows[0].id;
    await pool.query('INSERT INTO project_storage(project_id,storage_key) VALUES($1,$2)', [insertedId, storageKey]);

    if (type !== 'static') {
      const result = await runner.deploy({
        projectId: String(insertedId),
        storageKey,
        slug,
        type,
        docroot: detected.docroot || '',
        startCommand: detected.startCommand || null,
        hasBuild: detected.hasBuild,
        rebuild: true,
      });
      rows[0].status = result.status || 'running';
      await pool.query('UPDATE projects SET status=$1, runtime_port=$2, updated_at=NOW() WHERE id=$3',
        [rows[0].status, result.port || null, insertedId]);
    }

    res.status(201).json({ project: rows[0], url: projectUrl(type, slug) });
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
    await client.query('DELETE FROM projects WHERE id=$1', [id]);
    await client.query('COMMIT');
    if (storage_key) await fs.rm(path.join(STORAGE, storage_key), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error(e); res.status(500).json({ error: 'Não foi possível excluir o projeto.' });
  } finally { client.release(); }
});

async function ownedProject(req) {
  const { rows } = await pool.query(
    'SELECT p.id, p.type, p.slug, s.storage_key FROM projects p LEFT JOIN project_storage s ON s.project_id=p.id WHERE p.id=$1 AND p.user_id=$2',
    [req.params.id, req.user.sub]
  );
  return rows[0];
}

app.get('/api/projects/:id/logs', requireAuth, async (req,res) => {
  try {
    const project = await ownedProject(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    if (project.type === 'static' || !runner.enabled()) return res.json({ logs: [] });
    res.json(await runner.logs(String(project.id)));
  } catch (e) { res.status(502).json({ error: e.message || 'Não foi possível obter os logs.' }); }
});

app.post('/api/projects/:id/restart', requireAuth, async (req,res) => {
  try {
    const project = await ownedProject(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    if (project.type === 'static' || !runner.enabled())
      return res.status(400).json({ error: 'Somente projetos PHP/Node podem ser reiniciados.' });
    const result = await runner.restart(String(project.id));
    await pool.query('UPDATE projects SET status=$1, runtime_port=$2, updated_at=NOW() WHERE id=$3',
      [result.status || 'running', result.port || null, project.id]);
    res.json({ ok: true, status: result.status });
  } catch (e) { res.status(502).json({ error: e.message || 'Não foi possível reiniciar o projeto.' }); }
});

app.post('/api/projects/:id/stop', requireAuth, async (req,res) => {
  try {
    const project = await ownedProject(req);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
    if (project.type === 'static' || !runner.enabled())
      return res.status(400).json({ error: 'Somente projetos PHP/Node podem ser parados.' });
    await runner.stop(String(project.id));
    await pool.query('UPDATE projects SET status=$1, updated_at=NOW() WHERE id=$2', ['stopped', project.id]);
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message || 'Não foi possível parar o projeto.' }); }
});
app.use((err,req,res,next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Arquivo maior que ${MAX_MB} MB.` : 'Falha no upload.' });
  res.status(500).json({ error: 'Erro interno.' });
});

(async () => {
  await fs.mkdir(STORAGE, { recursive: true });
  await initDb();
  await pool.query(`CREATE TABLE IF NOT EXISTS project_storage (
    project_id BIGINT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL UNIQUE
  )`);
  app.listen(PORT, () => console.log(`Hostfy app listening on ${PORT}`));
})().catch(e => { console.error(e); process.exit(1); });
