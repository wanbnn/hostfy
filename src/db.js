const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS projects (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS projects_user_id_idx ON projects(user_id);

    ALTER TABLE projects ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'static';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS docroot TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS start_command TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'running';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime_port INTEGER;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'upload';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_full_name TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_ref TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS compose_file TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS web_service TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS web_port INTEGER;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS env_json JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_deploy_at TIMESTAMPTZ;

    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS project_storage (
      project_id BIGINT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL UNIQUE
    );

    -- Um banco por projeto (um por linha: a chave primária garante 1:1).
    CREATE TABLE IF NOT EXISTS project_databases (
      project_id BIGINT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      db_name TEXT NOT NULL UNIQUE,
      role_name TEXT NOT NULL UNIQUE,
      password_enc TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS project_databases_user_idx ON project_databases(user_id);

    CREATE TABLE IF NOT EXISTS github_accounts (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      login TEXT NOT NULL,
      token_enc TEXT NOT NULL,
      avatar_url TEXT,
      scopes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
      level TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      body TEXT,
      action TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      dedupe_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx
      ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS cleanup_candidates (
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      name TEXT,
      project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
      owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      size_bytes BIGINT,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      scheduled_for TIMESTAMPTZ,
      notified_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cleanup_candidates_active_idx
      ON cleanup_candidates(kind, resource_id) WHERE status NOT IN ('executed','skipped');
    CREATE INDEX IF NOT EXISTS cleanup_candidates_due_idx
      ON cleanup_candidates(status, scheduled_for);
  `);
}

module.exports = { pool, initDb };