'use strict';

// Cliente mínimo da API REST do GitHub. Usado pelo painel para validar o
// Personal Access Token do usuário, listar repositórios (públicos e privados)
// e baixar o código de um repositório para publicar como projeto Docker.

const GITHUB_API = 'https://api.github.com';

function headers(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Hostfy',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function request(token, pathname, options = {}) {
  const response = await fetch(`${GITHUB_API}${pathname}`, {
    ...options,
    headers: {
      ...headers(token),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data && data.message ? data.message : `GitHub respondeu ${response.status}.`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return { data, response };
}

async function getUser(token) {
  const { data, response } = await request(token, '/user');
  return {
    login: data.login,
    name: data.name || data.login,
    avatarUrl: data.avatar_url || null,
    scopes: response.headers.get('x-oauth-scopes') || '',
  };
}

function repoShape(repo) {
  return {
    id: repo.id,
    fullName: repo.full_name,
    name: repo.name,
    owner: repo.owner ? repo.owner.login : null,
    private: Boolean(repo.private),
    defaultBranch: repo.default_branch || 'main',
    description: repo.description || '',
    updatedAt: repo.updated_at || null,
    language: repo.language || null,
    url: repo.html_url || null,
  };
}

async function listRepos(token, page = 1) {
  const parsedPage = Number(page);
  const currentPage = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const { data, response } = await request(
    token,
    `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${currentPage}`,
    { signal: AbortSignal.timeout(15000) }
  );
  const hasNext = /;\s*rel="next"/.test(response.headers.get('link') || '');
  return {
    repos: Array.isArray(data) ? data.map(repoShape) : [],
    nextPage: hasNext ? currentPage + 1 : null,
  };
}

async function listBranches(token, fullName, page = 1) {
  const { data } = await request(
    token,
    `/repos/${fullName}/branches?per_page=100&page=${Number(page) || 1}`
  );
  return Array.isArray(data) ? data.map(b => ({ name: b.name, protected: Boolean(b.protected) })) : [];
}

async function getRepo(token, fullName) {
  const { data } = await request(token, `/repos/${fullName}`);
  return repoShape(data);
}

// Baixa o ZIP do repositório (branch ou ref). Trata o redirect para
// codeload.github.com manualmente porque o `fetch` remove o cabeçalho de
// autorização em redirecionamentos entre domínios — necessário para repos privados.
async function downloadZip(token, fullName, ref) {
  const url = `${GITHUB_API}/repos/${fullName}/zipball/${encodeURIComponent(ref || 'HEAD')}`;
  let response = await fetch(url, { headers: headers(token), redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new Error('GitHub não retornou o endereço do arquivo.');
    response = await fetch(location, { headers: headers(token) });
  }
  if (!response.ok) {
    if (response.status === 404) throw new Error('Repositório ou referência não encontrados.');
    if (response.status === 401 || response.status === 403)
      throw new Error('O token do GitHub não tem acesso a este repositório.');
    throw new Error(`Não foi possível baixar o repositório (${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

module.exports = { getUser, listRepos, listBranches, getRepo, downloadZip };
