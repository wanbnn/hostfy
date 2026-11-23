'use strict';

// ---------------------------------------------------------------------------
// Bancos de dados gerenciados por projeto
//
// Cada projeto pode ter o seu próprio banco dentro da MESMA instância do
// PostgreSQL que já roda no serviço "db" (postgres:17-alpine). Não criamos
// contêineres nem imagens extras: apenas um DATABASE e um ROLE por projeto.
//
// O nome do banco/role é derivado do projeto e guardado em
// "project_databases" — trocar o slug do projeto não renomeia o banco.
//
// O usuário do projeto (role) é sem privilégios: não é superuser, não cria
// databases e não cria roles. Assim o projeto só mexe no próprio banco.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const { Client } = require('pg');
const { pool } = require('./db');
const { encrypt, decrypt } = require('./secrets');

// Host/porta do PostgreSQL como vistos de dentro da rede do docker-compose.
const DB_HOST = process.env.PROJECT_DB_HOST || 'db';
const DB_PORT = Number(process.env.PROJECT_DB_PORT || 5432);
// Porta do Postgres publicada no host (127.0.0.1). Quando existe, o painel
// também mostra a URL para conectar de fora do contêiner (cliente SQL local).
const DB_HOST_PORT = Number(process.env.DB_HOST_PORT || 0);
// Tamanho (em MB) a partir do qual o Hostfy avisa o usuário. É apenas um
// alerta: nada é bloqueado, o usuário decide o que fazer com os dados.
const ALERT_MB = Number(process.env.PROJECT_DB_ALERT_MB || 200);
const ALERT_BYTES = ALERT_MB * 1024 * 1024;

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const SQL_TIMEOUT_MS = 15000;
const MAX_ROWS = 500;

// Instruções que o console SQL não executa (o role do projeto já é limitado,
// mas estas ainda podem derrubar o próprio banco do usuário).
const BLOCKED_SQL = [
  /\bdrop\s+database\b/i,
  /\bcreate\s+database\b/i,
  /\balter\s+database\b/i,
  /\b(create|alter|drop)\s+role\b/i,
  /\bpg_terminate_backend\b/i,
  /\bpg_reload_conf\b/i,
];

function slugFragment(slug) {
  const clean = String(slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (clean || 'projeto').slice(0, 40);
}

function databaseNameFor(slug, projectId) {
  const name = `hostfy_${slugFragment(slug)}_${projectId}`;
  return name.slice(0, 63);
}

function roleNameFor(projectId) {
  return `hostfy_u${projectId}`.slice(0, 63);
}

function randomPassword() {
  // Base62: sem aspas, barras ou caracteres especiais — seguro para
  // interpolar em SQL e em URL de conexão.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(40);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

function assertIdentifier(name) {
  if (!IDENT_RE.test(String(name))) throw new Error('Nome interno de banco inválido.');
  return name;
}

function connectionUrl({ db_name, role_name, password }) {
  return `postgres://${role_name}:${password}@${DB_HOST}:${DB_PORT}/${db_name}`;
}

// Mesma coisa, mas apontando para a porta publicada no host (acesso local).
function externalUrl({ db_name, role_name, password }) {
  if (!DB_HOST_PORT) return null;
  return `postgres://${role_name}:${password}@127.0.0.1:${DB_HOST_PORT}/${db_name}`;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function getDatabase(projectId) {
  const { rows } = await pool.query('SELECT * FROM project_databases WHERE project_id=$1', [projectId]);
  return rows[0] || null;
}

async function createDatabase(project) {
  const projectId = project.id;
  const existing = await getDatabase(projectId);
  if (existing) throw new Error('Este projeto já possui um banco de dados.');

  let userId = project.user_id;
  if (userId === undefined || userId === null) {
    const { rows } = await pool.query('SELECT user_id FROM projects WHERE id=$1', [projectId]);
    userId = rows[0] ? rows[0].user_id : null;
  }
  if (userId === null || userId === undefined) throw new Error('Projeto não encontrado.');

  const dbName = assertIdentifier(databaseNameFor(project.slug, projectId));
  const roleName = assertIdentifier(roleNameFor(projectId));
  const password = randomPassword();

  await pool.query(
    `CREATE ROLE ${roleName} LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT CONNECTION LIMIT 20`
  );
  try {
    await pool.query(`CREATE DATABASE ${dbName} OWNER ${roleName} TEMPLATE template0 ENCODING 'UTF8'`);
  } catch (e) {
    await pool.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => {});
    throw e;
  }

  const { rows } = await pool.query(
    `INSERT INTO project_databases(project_id,user_id,db_name,role_name,password_enc)
     VALUES($1,$2,$3,$4,$5)
     RETURNING project_id, db_name, role_name, status, size_bytes, created_at, updated_at`,
    [projectId, userId, dbName, roleName, encrypt(password)]
  );

  return describe(rows[0], password);
}

async function dropDatabase(record) {
  if (!record) return false;
  const dbName = assertIdentifier(record.db_name);
  const roleName = assertIdentifier(record.role_name);
  await pool
    .query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()', [dbName])
    .catch(() => {});
  await pool.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
  await pool.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => {});
  return true;
}

async function resetPassword(record) {
  if (!record) throw new Error('Banco de dados não encontrado.');
  const roleName = assertIdentifier(record.role_name);
  const password = randomPassword();
  await pool.query(`ALTER ROLE ${roleName} PASSWORD '${password}'`);
  await pool.query('UPDATE project_databases SET password_enc=$1, updated_at=NOW() WHERE project_id=$2', [
    encrypt(password),
    record.project_id,
  ]);
  return password;
}

async function databaseSize(dbName) {
  const { rows } = await pool.query('SELECT pg_database_size(oid) AS size FROM pg_database WHERE datname=$1', [dbName]);
  return rows[0] ? Number(rows[0].size) || 0 : 0;
}

// ---------------------------------------------------------------------------
// Conexão com o banco do projeto
// ---------------------------------------------------------------------------

function clientFor(record, password) {
  return new Client({
    host: DB_HOST,
    port: DB_PORT,
    database: record.db_name,
    user: record.role_name,
    password: password ?? decrypt(record.password_enc),
    connectionTimeoutMillis: 10000,
    statement_timeout: SQL_TIMEOUT_MS,
    application_name: 'hostfy-panel',
  });
}

async function withClient(record, fn) {
  if (!record) throw new Error('Banco de dados não encontrado.');
  const client = clientFor(record);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Console SQL
// ---------------------------------------------------------------------------

function assertSafeSql(sql) {
  const text = String(sql || '').trim();
  if (!text) throw new Error('Informe uma instrução SQL.');
  if (text.length > 20000) throw new Error('A instrução é longa demais (máximo de 20.000 caracteres).');
  if (BLOCKED_SQL.some(pattern => pattern.test(text)))
    throw new Error('Esta instrução não é permitida no console do projeto.');
  // Uma instrução por vez: evita lotes acidentais e resultados ambíguos.
  const withoutStrings = text.replace(/'[^']*'/g, "''");
  const parts = withoutStrings.split(';').map(part => part.trim()).filter(Boolean);
  if (parts.length > 1) throw new Error('Execute apenas uma instrução por vez.');
  return text;
}

async function runQuery(record, sql) {
  const text = assertSafeSql(sql);
  return withClient(record, async client => {
    const result = await client.query({ text, rowMode: 'array' });
    const single = Array.isArray(result) ? result[result.length - 1] : result;
    const fields = (single.fields || []).map(field => field.name);
    const rows = (single.rows || []).slice(0, MAX_ROWS);
    return {
      command: single.command || null,
      rowCount: single.rowCount ?? rows.length,
      fields,
      rows: rows.map(row => row.map(value => (value === null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value)))),
      truncated: (single.rowCount ?? rows.length) > rows.length,
    };
  });
}

async function listTables(record) {
  return withClient(record, async client => {
    const { rows } = await client.query(`
      SELECT c.relname AS name,
             CASE c.relkind
               WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view'
               WHEN 'm' THEN 'view' WHEN 'S' THEN 'sequence' ELSE c.relkind::text
             END AS kind,
             pg_total_relation_size(c.oid) AS bytes,
             GREATEST(c.reltuples, 0)::bigint AS approx_rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')
       ORDER BY c.relkind, c.relname`);
    return rows.map(row => ({
      name: row.name,
      kind: row.kind,
      bytes: Number(row.bytes) || 0,
      approxRows: Number(row.approx_rows) || 0,
    }));
  });
}

// ---------------------------------------------------------------------------
// Descrição para a API
// ---------------------------------------------------------------------------

function describe(record, password) {
  if (!record) return null;
  const plain = password ?? decrypt(record.password_enc);
  return {
    projectId: Number(record.project_id),
    name: record.db_name,
    role: record.role_name,
    status: record.status || 'ready',
    sizeBytes: Number(record.size_bytes) || 0,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    host: DB_HOST,
    port: DB_PORT,
    user: record.role_name,
    password: plain,
    url: plain ? connectionUrl({ db_name: record.db_name, role_name: record.role_name, password: plain }) : null,
    externalUrl: plain ? externalUrl({ db_name: record.db_name, role_name: record.role_name, password: plain }) : null,
    hostPort: DB_HOST_PORT || null,
    alertBytes: ALERT_BYTES,
  };
}

// Atualiza o tamanho guardado e avisa (notifica) quando passa do limite.
async function refreshSize(record, { notify } = {}) {
  if (!record) return null;
  const size = await databaseSize(record.db_name);
  await pool.query('UPDATE project_databases SET size_bytes=$1, updated_at=NOW() WHERE project_id=$2', [
    size,
    record.project_id,
  ]);
  const overAlert = size > ALERT_BYTES;
  if (overAlert && typeof notify === 'function') {
    await notify({
      level: 'warning',
      title: 'Banco de dados acima do limite sugerido',
      body: `O banco do projeto passou de ${ALERT_MB} MB (${(size / 1024 / 1024).toFixed(1)} MB). Considere limpar dados antigos.`,
      dedupeKey: `db-size-${record.project_id}`,
    });
  }
  return { ...record, size_bytes: size };
}

module.exports = {
  pool,
  DB_HOST,
  DB_PORT,
  ALERT_MB,
  ALERT_BYTES,
  createDatabase,
  getDatabase,
  dropDatabase,
  resetPassword,
  databaseSize,
  refreshSize,
  runQuery,
  listTables,
  describe,
  connectionUrl,
  externalUrl,
  withClient,
};
