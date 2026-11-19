'use strict';

// Cliente HTTP usado pelo app (painel/API) para conversar com o runner.
// O runner é quem de fato sobe os processos de PHP/Node.

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

const deploy = payload => call('/deploy', { method: 'POST', body: JSON.stringify(payload) });
const stop = projectId => call('/stop', { method: 'POST', body: JSON.stringify({ projectId }) });
const remove = projectId => call('/remove', { method: 'POST', body: JSON.stringify({ projectId }) });
const restart = projectId => call('/restart', { method: 'POST', body: JSON.stringify({ projectId }) });
const logs = projectId => call(`/logs/${encodeURIComponent(projectId)}`);
const status = projectId => call(`/status/${encodeURIComponent(projectId)}`);

module.exports = { enabled, deploy, stop, remove, restart, logs, status };