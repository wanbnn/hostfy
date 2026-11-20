const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const STORAGE = process.env.STORAGE_DIR || '/data/projects';
app.disable('x-powered-by');
app.use(async (req,res,next) => {
  try {
    // O runner encaminha os subdomínios ({slug}.PROJECTS_DOMAIN) com o slug no
    // cabeçalho X-Hostfy-Slug; sem ele, o slug é o primeiro segmento do caminho.
    const headerSlug = String(req.headers['x-hostfy-slug'] || '').trim().toLowerCase();
    const parts = req.path.split('/').filter(Boolean);
    const slug = headerSlug || parts.shift();
    if (!slug || !/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/.test(slug)) return res.status(404).send('Projeto não encontrado.');
    const { rows } = await pool.query(
      'SELECT s.storage_key FROM projects p JOIN project_storage s ON s.project_id=p.id WHERE p.slug=$1', [slug]);
    if (!rows[0]) return res.status(404).send('Projeto não encontrado.');
    const base = path.resolve(STORAGE, rows[0].storage_key);
    const relative = parts.join('/') || 'index.html';
    const target = path.resolve(base, relative);
    if (target !== base && !target.startsWith(base + path.sep)) return res.status(403).send('Acesso negado.');
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return res.status(404).send('Arquivo não encontrado.');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.sendFile(target);
  } catch(e) { console.error(e); res.status(500).send('Erro ao carregar projeto.'); }
});
const port = Number(process.env.STATIC_PORT || 1592);
app.listen(port, () => console.log(`Hostfy static server listening on ${port}`));
