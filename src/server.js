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
  const { rows } = await pool.query('SELECT id,name,slug,created_at FROM projects WHERE user_id=$1 ORDER BY created_at DESC', [req.user.sub]);
  res.json({ projects: rows, projectsOrigin: process.env.PROJECTS_ORIGIN || 'http://localhost:1592' });
});

async function extractZip(zipPath, destination) {
  await fs.mkdir(destination, { recursive: true });
  const directory = await unzipper.Open.file(zipPath);
  if (!directory.files.length || directory.files.length > 5000) throw new Error('O ZIP deve conter entre 1 e 5.000 arquivos.');
  let total = 0, hasIndex = false;
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
    if (normalized.toLowerCase() === 'index.html') hasIndex = true;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await new Promise((resolve,reject) => {
      const out = require('fs').createWriteStream(target, { flags: 'wx' });
      entry.stream().pipe(out).on('finish', resolve).on('error', reject);
    });
  }
  if (!hasIndex) throw new Error('O projeto precisa conter index.html na raiz do ZIP.');
}
app.post('/api/projects', requireAuth, upload.single('project'), async (req,res) => {
  const temp = req.file?.path;
  let finalDir;
  try {
    if (!req.file) return res.status(400).json({ error: 'Envie um arquivo ZIP.' });
    const name = safeName(req.body.name);
    const slug = String(req.body.slug || '').trim().toLowerCase();
    if (!name || !slugOk(slug)) return res.status(400).json({ error: 'Informe nome e slug válido (letras minúsculas, números e hífen).' });
    const exists = await pool.query('SELECT 1 FROM projects WHERE slug=$1', [slug]);
    if (exists.rowCount) return res.status(409).json({ error: 'Este slug já está em uso.' });
    const projectId = crypto.randomUUID();
    finalDir = path.join(STORAGE, projectId);
    req._hostlyStorageKey = projectId;
    await extractZip(temp, finalDir);
    const { rows } = await pool.query(
      'INSERT INTO projects(user_id,name,slug) VALUES($1,$2,$3) RETURNING id,name,slug,created_at',
      [req.user.sub,name,slug]);
    await pool.query('INSERT INTO project_storage(project_id,storage_key) VALUES($1,$2)', [rows[0].id, projectId]);
    res.status(201).json({ project: rows[0], url: `${process.env.PROJECTS_ORIGIN || 'http://localhost:1592'}/${slug}/` });
  } catch(e) {
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
      'SELECT p.id, s.storage_key FROM projects p LEFT JOIN project_storage s ON s.project_id=p.id WHERE p.id=$1 AND p.user_id=$2 FOR UPDATE',
      [req.params.id, req.user.sub]
    );
    if (!owned.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Projeto não encontrado.' }); }
    await client.query('DELETE FROM projects WHERE id=$1', [owned.rows[0].id]);
    await client.query('COMMIT');
    if (owned.rows[0].storage_key) await fs.rm(path.join(STORAGE, owned.rows[0].storage_key), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error(e); res.status(500).json({ error: 'Não foi possível excluir o projeto.' });
  } finally { client.release(); }
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
