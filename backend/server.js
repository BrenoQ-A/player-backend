'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const gh = require('./github');

const {
  GITHUB_TOKEN,
  MEDIA_REPO,
  MEDIA_BRANCH = 'main',
  PRIVATE_REPO,
  PRIVATE_BRANCH = 'main',
  JWT_SECRET,
  INVITE_CODE,
  ALLOWED_ORIGIN,
  COOKIE_SECURE = 'true',
  PORT = 3000
} = process.env;

for (const [name, val] of Object.entries({ GITHUB_TOKEN, MEDIA_REPO, PRIVATE_REPO, JWT_SECRET, INVITE_CODE })) {
  if (!val) {
    console.error('Variável de ambiente obrigatória ausente: ' + name);
    process.exit(1);
  }
}

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const USERS_PATH = 'users.json';
const SESSION_DAYS = 30;
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const VIDEO_EXT = ['mp4', 'webm', 'ogg'];

function extOf(name) {
  const parts = name.split('.');
  return parts.length < 2 ? '' : parts[parts.length - 1].toLowerCase();
}

// ---------- armazenamento de usuários (repo privado) ----------
async function loadUsers() {
  const file = await gh.getContents(PRIVATE_REPO, USERS_PATH, PRIVATE_BRANCH);
  if (!file) { return { users: [], sha: null }; }
  const decoded = Buffer.from(file.content, 'base64').toString('utf8');
  return { users: JSON.parse(decoded), sha: file.sha };
}

async function saveUsers(users, sha, message) {
  const result = await gh.putContents(
    PRIVATE_REPO, USERS_PATH, PRIVATE_BRANCH,
    JSON.stringify(users, null, 2), message, sha || undefined
  );
  return result.content.sha;
}

// ---------- autenticação ----------
function issueToken(res, gpid) {
  const token = jwt.sign({ gpid: gpid }, JWT_SECRET, { expiresIn: SESSION_DAYS + 'd' });
  res.cookie('session', token, {
    httpOnly: true,
    secure: COOKIE_SECURE === 'true',
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.session;
  if (!token) { return res.status(401).json({ error: 'Não autenticado.' }); }
  try {
    req.gpid = jwt.verify(token, JWT_SECRET).gpid;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Sessão expirada, faça login novamente.' });
  }
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { gpid, password, inviteCode } = req.body || {};
    if (!gpid || !password) { return res.status(400).json({ error: 'GPID e senha são obrigatórios.' }); }
    if (password.length < 8) { return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' }); }
    if (inviteCode !== INVITE_CODE) { return res.status(403).json({ error: 'Código de convite do time inválido.' }); }

    const { users, sha } = await loadUsers();
    const gpidNorm = String(gpid).trim().toUpperCase();
    if (users.find((u) => u.gpid === gpidNorm)) {
      return res.status(409).json({ error: 'Esse GPID já tem cadastro. Faça login.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    users.push({ gpid: gpidNorm, passwordHash: passwordHash, createdAt: new Date().toISOString() });
    await saveUsers(users, sha, 'Novo usuário: ' + gpidNorm);

    issueToken(res, gpidNorm);
    res.json({ gpid: gpidNorm });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao cadastrar: ' + e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { gpid, password } = req.body || {};
    if (!gpid || !password) { return res.status(400).json({ error: 'GPID e senha são obrigatórios.' }); }
    const gpidNorm = String(gpid).trim().toUpperCase();
    const { users } = await loadUsers();
    const user = users.find((u) => u.gpid === gpidNorm);
    if (!user) { return res.status(401).json({ error: 'GPID ou senha incorretos.' }); }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) { return res.status(401).json({ error: 'GPID ou senha incorretos.' }); }
    issueToken(res, gpidNorm);
    res.json({ gpid: gpidNorm });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao entrar: ' + e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/auth/session', requireAuth, (req, res) => {
  res.json({ gpid: req.gpid });
});

// ---------- mídias (repositório público que serve a TV) ----------
app.get('/api/media', requireAuth, async (req, res) => {
  try {
    const list = await gh.getContents(MEDIA_REPO, 'media', MEDIA_BRANCH);
    const items = (list || [])
      .filter((it) => it.type === 'file')
      .map((it) => {
        const ext = extOf(it.name);
        const type = IMAGE_EXT.includes(ext) ? 'image' : (VIDEO_EXT.includes(ext) ? 'video' : 'other');
        return { name: it.name, sha: it.sha, url: it.download_url, type };
      })
      .filter((it) => it.type !== 'other')
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    res.json({ media: items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao listar mídias: ' + e.message });
  }
});

app.post('/api/media/upload', requireAuth, upload.array('files', 20), async (req, res) => {
  try {
    for (const file of req.files || []) {
      await gh.putContents(
        MEDIA_REPO, 'media/' + file.originalname, MEDIA_BRANCH,
        file.buffer, req.gpid + ' adicionou mídia: ' + file.originalname
      );
    }
    res.json({ ok: true, count: (req.files || []).length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao enviar: ' + e.message });
  }
});

app.delete('/api/media/:name', requireAuth, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const list = await gh.getContents(MEDIA_REPO, 'media', MEDIA_BRANCH);
    const item = (list || []).find((it) => it.name === name);
    if (!item) { return res.status(404).json({ error: 'Mídia não encontrada.' }); }
    await gh.deleteContents(MEDIA_REPO, 'media/' + name, MEDIA_BRANCH, item.sha, req.gpid + ' excluiu mídia: ' + name);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao excluir: ' + e.message });
  }
});

// body: { order: ["nome-atual-1.png", "nome-atual-2.mp4", ...] } na ordem desejada
app.post('/api/media/reorder', requireAuth, async (req, res) => {
  try {
    const order = (req.body && req.body.order) || [];
    const list = await gh.getContents(MEDIA_REPO, 'media', MEDIA_BRANCH);
    const byName = {};
    (list || []).forEach((it) => { byName[it.name] = it; });

    for (let i = 0; i < order.length; i++) {
      const currentName = order[i];
      const item = byName[currentName];
      if (!item) { continue; }
      const baseName = currentName.replace(/^\d+[-_ ]+/, '');
      const targetName = String(i + 1).padStart(2, '0') + '-' + baseName;
      if (targetName === currentName) { continue; }

      const content = await gh.downloadRaw(item.download_url);
      await gh.putContents(MEDIA_REPO, 'media/' + targetName, MEDIA_BRANCH, content,
        req.gpid + ' reordenou: ' + currentName + ' -> ' + targetName);
      await gh.deleteContents(MEDIA_REPO, 'media/' + currentName, MEDIA_BRANCH, item.sha,
        req.gpid + ' removeu nome antigo: ' + currentName);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao reordenar: ' + e.message });
  }
});

// ---------- configurações (config.json no repositório público) ----------
app.get('/api/config', requireAuth, async (req, res) => {
  try {
    const file = await gh.getContents(MEDIA_REPO, 'config.json', MEDIA_BRANCH);
    if (!file) { return res.json({ config: null }); }
    const config = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    res.json({ config });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao ler configurações: ' + e.message });
  }
});

app.put('/api/config', requireAuth, async (req, res) => {
  try {
    const existing = await gh.getContents(MEDIA_REPO, 'config.json', MEDIA_BRANCH);
    await gh.putContents(
      MEDIA_REPO, 'config.json', MEDIA_BRANCH,
      JSON.stringify(req.body || {}, null, 2),
      req.gpid + ' atualizou config.json',
      existing ? existing.sha : undefined
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao salvar configurações: ' + e.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log('Backend rodando na porta ' + PORT));
