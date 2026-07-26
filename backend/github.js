// Wrapper fino sobre a API de conteúdo do GitHub. Usa sempre o token do
// servidor (GITHUB_TOKEN) - o cliente (admin.html) nunca vê esse token.
'use strict';

const GITHUB_API = 'https://api.github.com';

function authHeaders(extra) {
  return Object.assign(
    {
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'player-sinalizacao-backend'
    },
    extra || {}
  );
}

async function ghFetch(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error('GitHub API ' + res.status + ' em ' + url + ': ' + body);
    err.status = res.status;
    throw err;
  }
  return res;
}

// Lê um arquivo/pasta em um repositório. Retorna null em 404.
async function getContents(repo, path, branch) {
  const url = GITHUB_API + '/repos/' + repo + '/contents/' + path + '?ref=' + encodeURIComponent(branch);
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) { return null; }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('GitHub API ' + res.status + ' em ' + url + ': ' + body);
  }
  return res.json();
}

// content: Buffer ou string. Cria ou atualiza (se sha for passado) um arquivo.
async function putContents(repo, path, branch, content, message, sha) {
  const body = {
    message: message,
    content: Buffer.isBuffer(content) ? content.toString('base64') : Buffer.from(content, 'utf8').toString('base64'),
    branch: branch
  };
  if (sha) { body.sha = sha; }
  const url = GITHUB_API + '/repos/' + repo + '/contents/' + path;
  const res = await ghFetch(url, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
  return res.json();
}

async function deleteContents(repo, path, branch, sha, message) {
  const url = GITHUB_API + '/repos/' + repo + '/contents/' + path;
  await ghFetch(url, {
    method: 'DELETE',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message: message, sha: sha, branch: branch })
  });
}

async function downloadRaw(downloadUrl) {
  const res = await fetch(downloadUrl);
  if (!res.ok) { throw new Error('Falha ao baixar ' + downloadUrl + ' (HTTP ' + res.status + ')'); }
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { getContents, putContents, deleteContents, downloadRaw };
