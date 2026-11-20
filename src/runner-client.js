'use strict';

// Cliente HTTP usado pelo app (painel/API) para conversar com o runner.
// O runner é quem de fato sobe os processos PHP/Node e os projetos Docker,
// além de coletar métricas e executar a limpeza do Docker do host.

function baseUrl() {
  return process.env.RUNNER_URL || '';
}

function enabled() {
  return Boolean(baseUrl());
}

async function call(pathname, options = {}) {
  const base = baseUrl();
  if (!base) throw new Error('Runner não configurado (RUNNER_URL ausente).');
  let response;
  try {
    response = await fetch(`${base}${pathname}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RUNNER_TOKEN || ''}`,
        ...(options.headers || {}),
      },
    });
  } catch (e) {
    throw new Error('Não foi possível contatar o runner de aplicações.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Runner respondeu ${response.status}.`);
  return data;
}

const post = (pathname, body = {}) =>
  call(pathname, { method: 'POST', body: JSON.stringify(body) });

const deploy = payload => post('/deploy', payload);
const stop = projectId => post('/stop', { projectId });
const remove = projectId => post('/remove', { projectId });
const restart = projectId => post('/restart', { projectId });
const logs = projectId => call(`/logs/${encodeURIComponent(projectId)}`);
const status = projectId => call(`/status/${encodeURIComponent(projectId)}`);

// Métricas de recursos (CPU/memória).
const stats = projectId => call(`/stats/${encodeURIComponent(projectId)}`);
const allStats = () => call('/stats');

// Capacidades e projetos Docker.
const capabilities = () => call('/capabilities');
const dockerDeploy = payload => post('/docker/deploy', payload);
const dockerDown = projectId => post('/docker/down', { projectId });
const dockerRestart = projectId => post('/docker/restart', { projectId });

// Manutenção do Docker do host.
const dockerDf = () => call('/docker/df');
const dockerContainers = () => call('/docker/containers');
const cleanupScan = () => post('/cleanup/scan');
const cleanupRun = () => post('/cleanup/run');
const dockerPrune = ({ force, volumes } = {}) => post('/docker/prune', { force, volumes });

module.exports = {
  enabled,
  deploy,
  stop,
  remove,
  restart,
  logs,
  status,
  stats,
  allStats,
  capabilities,
  dockerDeploy,
  dockerDown,
  dockerRestart,
  dockerDf,
  dockerContainers,
  cleanupScan,
  cleanupRun,
  dockerPrune,
};