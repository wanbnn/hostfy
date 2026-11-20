'use strict';

// ---------------------------------------------------------------------------
// Runtime Docker (projetos docker compose + manutenção do host Docker)
//
// Encapsula todas as interações com o CLI do Docker. O runner importa este
// módulo; nenhuma outra parte do app fala com o Docker diretamente.
//
// Convenções:
//   - Cada projeto usa um projeto Compose próprio: "hostfy-<slug>".
//   - Os usuários NÃO publicam portas no host: o runner conecta-se à rede
//     criada pelo Compose e faz proxy direto para o contêiner do serviço web.
//   - Os arquivos ficam em STORAGE/<storageKey>/.
// ---------------------------------------------------------------------------

const os = require('os');
const { execFile } = require('child_process');

const DOCKER_BIN = process.env.DOCKER_BIN || 'docker';
const COMPOSE_TIMEOUT = Number(process.env.DOCKER_TIMEOUT_MS || 20 * 60 * 1000);
const QUICK_TIMEOUT = Number(process.env.DOCKER_QUICK_TIMEOUT_MS || 60 * 1000);

function envFor(extra) {
  const env = { ...process.env, ...(extra || {}) };
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
  return env;
}

function exec(args, { cwd, env, timeout = COMPOSE_TIMEOUT, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(DOCKER_BIN, args, { cwd, env: envFor(env), timeout, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout || '');
        error.stderr = String(stderr || '');
        return reject(error);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const quick = args => exec(args, { timeout: QUICK_TIMEOUT });

let cachedAvailability = null;

async function available() {
  if (cachedAvailability !== null) return cachedAvailability;
  try {
    await quick(['version', '--format', '{{.Server.Version}}']);
    cachedAvailability = true;
  } catch {
    cachedAvailability = false;
  }
  return cachedAvailability;
}

async function serverVersion() {
  try {
    const { stdout } = await quick(['version', '--format', '{{.Server.Version}}']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers de parsing
// ---------------------------------------------------------------------------

function parsePercent(value) {
  const n = parseFloat(String(value || '').replace('%', '').trim());
  return Number.isFinite(n) ? n : 0;
}

function parseBytes(value) {
  const first = String(value || '').split('/')[0].trim();
  const match = /^([\d.]+)\s*([a-zA-Z]*)/.exec(first);
  if (!match) return 0;
  const n = parseFloat(match[1]);
  const unit = (match[2] || 'B').toLowerCase();
  const table = {
    b: 1,
    kb: 1024,
    kib: 1024,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };
  return Math.round((n || 0) * (table[unit] || 1));
}

function parsePort(entry) {
  const clean = String(entry).split('/')[0];
  const parts = clean.split(':');
  const port = Number(parts[parts.length - 1]);
  return Number.isFinite(port) ? port : null;
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

const COMPOSE_CANDIDATES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];

const fsp = require('fs/promises');
const path = require('path');

async function findComposeFile(dir) {
  for (const candidate of COMPOSE_CANDIDATES) {
    try {
      await fsp.access(path.join(dir, candidate));
      return candidate;
    } catch {}
  }
  return null;
}

function projectNameFor(slug) {
  const safe = String(slug || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return `hostfy-${safe}`;
}

function composeCmd(projectName, composeFile, args) {
  return ['compose', '--project-name', projectName, '-f', composeFile, ...args];
}

function composeConfig(projectName, dir, composeFile) {
  return exec(composeCmd(projectName, composeFile, ['config', '--format', 'json']), { cwd: dir }).then(
    ({ stdout }) => JSON.parse(stdout)
  );
}

function detectWebService(config) {
  const services = (config && config.services) || {};
  const names = Object.keys(services);
  if (!names.length) return null;
  const score = name => {
    const svc = services[name] || {};
    if (Array.isArray(svc.ports) && svc.ports.length) return 3;
    if (Array.isArray(svc.expose) && svc.expose.length) return 2;
    return 1;
  };
  names.sort((a, b) => score(b) - score(a));
  const service = names[0];
  const svc = services[service] || {};
  const ports = (Array.isArray(svc.ports) && svc.ports.length ? svc.ports : svc.expose) || [];
  const port = ports.length ? parsePort(ports[0]) : 80;
  return { service, port: port || 80 };
}

async function composeUp({ projectName, dir, composeFile, env }) {
  await exec(composeCmd(projectName, composeFile, ['up', '-d', '--build', '--remove-orphans']), {
    cwd: dir,
    env,
  });
}

async function composeStop({ projectName, dir, composeFile }) {
  await exec(composeCmd(projectName, composeFile, ['stop']), { cwd: dir });
}

async function composeStart({ projectName, dir, composeFile }) {
  // `up -d` garante que contêineres ausentes sejam recriados.
  await exec(composeCmd(projectName, composeFile, ['up', '-d', '--remove-orphans']), { cwd: dir });
}

async function composeRestart({ projectName, dir, composeFile }) {
  await exec(composeCmd(projectName, composeFile, ['restart']), { cwd: dir });
}

async function composeDown({ projectName, dir, composeFile, removeVolumes }) {
  const args = ['down', '--remove-orphans'];
  if (removeVolumes) args.push('-v');
  try {
    await exec(composeCmd(projectName, composeFile, args), { cwd: dir });
  } catch {
    // Sem compose file (projeto excluído) ainda assim limpamos pelos labels.
    await removeProjectResources(projectName);
  }
}

async function composeLogs({ projectName, dir, composeFile, tail = 200 }) {
  const { stdout } = await exec(
    composeCmd(projectName, composeFile, ['logs', '--no-color', '--tail', String(tail)]),
    { cwd: dir, timeout: QUICK_TIMEOUT }
  );
  return stdout;
}

// Remoção por labels — funciona mesmo sem o compose file.
async function removeProjectResources(projectName) {
  const filter = `label=com.docker.compose.project=${projectName}`;
  try {
    const { stdout } = await quick(['ps', '-aq', '--filter', filter]);
    const ids = stdout.split('\n').map(s => s.trim()).filter(Boolean);
    if (ids.length) await quick(['rm', '-f', ...ids]);
  } catch {}
  try {
    const { stdout } = await quick(['volume', 'ls', '-q', '--filter', filter]);
    const vols = stdout.split('\n').map(s => s.trim()).filter(Boolean);
    for (const v of vols) {
      try {
        await quick(['volume', 'rm', v]);
      } catch {}
    }
  } catch {}
  try {
    const { stdout } = await quick(['network', 'ls', '-q', '--filter', filter]);
    const nets = stdout.split('\n').map(s => s.trim()).filter(Boolean);
    for (const n of nets) {
      try {
        await quick(['network', 'rm', n]);
      } catch {}
    }
  } catch {}
}

// Descobre o alvo do proxy: contêiner do serviço web + porta interna.
async function resolveWebTarget({ projectName, dir, composeFile, webService, webPort }) {
  let config = null;
  try {
    config = await composeConfig(projectName, dir, composeFile);
  } catch {}
  const detected = config ? detectWebService(config) : null;
  const service = webService || (detected && detected.service);
  const port = Number(webPort) || (detected && detected.port) || 80;
  if (!service) {
    throw new Error(
      'Não foi possível detectar o serviço web no docker-compose. Informe o serviço (web_service) e a porta (web_port).'
    );
  }
  const { stdout } = await exec(composeCmd(projectName, composeFile, ['ps', '-q', service]), { cwd: dir });
  const containerId = stdout.split('\n').map(s => s.trim()).filter(Boolean)[0];
  if (!containerId) throw new Error(`O serviço "${service}" não está em execução.`);

  let containerName = null;
  try {
    const { stdout: nameOut } = await quick(['inspect', '-f', '{{.Name}}', containerId]);
    containerName = nameOut.trim().replace(/^\//, '');
  } catch {}

  let network = null;
  try {
    const { stdout: netOut } = await quick(['inspect', '-f', '{{json .NetworkSettings.Networks}}', containerId]);
    const networks = JSON.parse(netOut.trim() || '{}');
    const keys = Object.keys(networks);
    network = keys.find(k => k.endsWith('_default')) || keys[0] || null;
  } catch {}

  let host = containerName;
  if (network) {
    try {
      await quick(['network', 'connect', network, os.hostname()]);
    } catch {}
    try {
      const { stdout: ipOut } = await quick([
        'inspect',
        '-f',
        `{{ (index .NetworkSettings.Networks "${network}").IPAddress }}`,
        containerId,
      ]);
      const ip = ipOut.trim();
      if (ip) host = ip; // endereço IP é mais previsível que a resolução DNS
    } catch {}
  }
  if (!host) throw new Error('Não foi possível determinar o endereço interno do serviço web.');
  return { host, port, network, containerId, service };
}

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------

async function stats(projectName) {
  let ids = [];
  try {
    const { stdout } = await quick(['ps', '-a', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.ID}}']);
    ids = stdout.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return { cpuPercent: 0, memBytes: 0, containers: 0 };
  }
  if (!ids.length) return { cpuPercent: 0, memBytes: 0, containers: 0 };
  let cpu = 0;
  let mem = 0;
  try {
    const { stdout } = await exec(['stats', '--no-stream', '--format', '{{json .}}', ...ids], { timeout: QUICK_TIMEOUT });
    for (const line of stdout.split('\n').filter(Boolean)) {
      try {
        const row = JSON.parse(line);
        cpu += parsePercent(row.CPUPerc);
        mem += parseBytes(row.MemUsage);
      } catch {}
    }
  } catch {}
  return { cpuPercent: Math.round(cpu * 100) / 100, memBytes: mem, containers: ids.length };
}

async function diskUsage() {
  try {
    const { stdout } = await quick(['system', 'df', '--format', 'json']);
    return stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function listContainers() {
  try {
    const { stdout } = await exec(
      ['ps', '-a', '--format', '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Labels}}', '--no-trunc'],
      { timeout: QUICK_TIMEOUT }
    );
    return stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [id, name, image, state, status, labels] = line.split('|');
        const labelMap = {};
        for (const pair of String(labels || '').split(',')) {
          const idx = pair.indexOf('=');
          if (idx > 0) labelMap[pair.slice(0, idx)] = pair.slice(idx + 1);
        }
        return {
          id: id.slice(0, 12),
          name,
          image,
          state,
          status,
          project: labelMap['com.docker.compose.project'] || null,
          service: labelMap['com.docker.compose.service'] || null,
        };
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Manutenção / limpeza
// ---------------------------------------------------------------------------

async function stoppedContainers() {
  let ids = [];
  try {
    const { stdout } = await quick([
      'ps', '-a',
      '--filter', 'status=exited',
      '--filter', 'status=created',
      '--filter', 'status=dead',
      '--format', '{{.ID}}',
    ]);
    ids = stdout.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
  if (!ids.length) return [];
  try {
    const { stdout } = await exec(['inspect', ...ids], { timeout: QUICK_TIMEOUT });
    const arr = JSON.parse(stdout);
    return arr.map(c => {
      const labels = (c.Config && c.Config.Labels) || {};
      const finishedAt = c.State && c.State.FinishedAt;
      return {
        id: String(c.Id).slice(0, 12),
        name: String(c.Name || '').replace(/^\//, ''),
        image: c.Config && c.Config.Image,
        state: c.State && c.State.Status,
        finishedAt: finishedAt && !String(finishedAt).startsWith('0001') ? finishedAt : null,
        project: labels['com.docker.compose.project'] || null,
        service: labels['com.docker.compose.service'] || null,
      };
    });
  } catch {
    return [];
  }
}

async function unusedImages() {
  let usedIds = new Set();
  try {
    const { stdout: psOut } = await quick(['ps', '-aq']);
    const cids = psOut.split('\n').map(s => s.trim()).filter(Boolean);
    if (cids.length) {
      const { stdout } = await exec(['inspect', '-f', '{{.Image}}', ...cids], { timeout: QUICK_TIMEOUT });
      usedIds = new Set(stdout.split('\n').map(s => s.trim()).filter(Boolean));
    }
  } catch {}
  let list = [];
  try {
    const { stdout } = await exec(
      ['images', '--no-trunc', '--format', '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}|{{.CreatedAt}}'],
      { timeout: QUICK_TIMEOUT }
    );
    list = stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [id, repo, tag, size, createdAt] = line.split('|');
        return { id, name: `${repo}:${tag}`, bytes: parseBytes(size), createdAt };
      })
      .filter(img => !usedIds.has(img.id));
  } catch {}
  return list;
}

async function unusedVolumes() {
  let names = [];
  try {
    const { stdout } = await quick(['volume', 'ls', '-q', '--filter', 'dangling=true']);
    names = stdout.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    let info = { name, project: null, createdAt: null };
    try {
      const { stdout } = await exec(['volume', 'inspect', name], { timeout: QUICK_TIMEOUT });
      const [v] = JSON.parse(stdout);
      const labels = v.Labels || {};
      info = {
        name,
        project: labels['com.docker.compose.project'] || null,
        createdAt: v.CreatedAt || null,
      };
    } catch {}
    out.push(info);
  }
  return out;
}

async function removeContainer(id) {
  await quick(['rm', '-f', id]);
}
async function removeImage(id) {
  await quick(['rmi', '-f', id]);
}
async function removeVolume(name) {
  await quick(['volume', 'rm', name]);
}

async function prune({ volumes = false } = {}) {
  const args = ['system', 'prune', '-a', '-f'];
  if (volumes) args.push('--volumes');
  const { stdout } = await exec(args, { timeout: 30 * 60 * 1000 });
  return stdout;
}

module.exports = {
  available,
  serverVersion,
  findComposeFile,
  projectNameFor,
  composeConfig,
  detectWebService,
  composeUp,
  composeStop,
  composeStart,
  composeRestart,
  composeDown,
  composeLogs,
  removeProjectResources,
  resolveWebTarget,
  stats,
  diskUsage,
  listContainers,
  stoppedContainers,
  unusedImages,
  unusedVolumes,
  removeContainer,
  removeImage,
  removeVolume,
  prune,
  parseBytes,
};