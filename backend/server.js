'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const gh = require('./github');
const ffmpeg = require('./ffmpeg');

const {
  GITHUB_TOKEN,
  MEDIA_REPO,
  MEDIA_BRANCH = 'main',
  PRIVATE_REPO,
  PRIVATE_BRANCH = 'main',
  JWT_SECRET,
  INVITE_CODE,
  ALLOWED_ORIGIN,
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
const VIDEO_EXT = ['mp4', 'webm', 'ogg', 'mov', 'mkv'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac'];
const MUSIC_FOLDER = 'musica';
const DEFAULT_IMAGE_DURATION = 60; // segundos - geração simplificada

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
    // O painel (GitHub Pages) e o backend (Render) são domínios diferentes,
    // então toda chamada de API é "cross-site". SameSite=None é obrigatório
    // pra o navegador aceitar enviar esse cookie de volta nessas chamadas -
    // e isso exige Secure=true (só funciona em HTTPS, que é o nosso caso).
    secure: true,
    sameSite: 'none',
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

// ---------- biblioteca de música (repositório público, pasta /musica) ----------
app.get('/api/music', requireAuth, async (req, res) => {
  try {
    const list = await gh.getContents(MEDIA_REPO, MUSIC_FOLDER, MEDIA_BRANCH);
    const items = (list || [])
      .filter((it) => it.type === 'file' && AUDIO_EXT.includes(extOf(it.name)))
      .map((it) => ({ name: it.name, sha: it.sha, url: it.download_url }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    res.json({ music: items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao listar músicas: ' + e.message });
  }
});

app.post('/api/music/upload', requireAuth, upload.array('files', 20), async (req, res) => {
  try {
    for (const file of req.files || []) {
      await gh.putContents(
        MEDIA_REPO, MUSIC_FOLDER + '/' + file.originalname, MEDIA_BRANCH,
        file.buffer, req.gpid + ' adicionou música: ' + file.originalname
      );
    }
    res.json({ ok: true, count: (req.files || []).length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao enviar música: ' + e.message });
  }
});

app.delete('/api/music/:name', requireAuth, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const list = await gh.getContents(MEDIA_REPO, MUSIC_FOLDER, MEDIA_BRANCH);
    const item = (list || []).find((it) => it.name === name);
    if (!item) { return res.status(404).json({ error: 'Música não encontrada.' }); }
    await gh.deleteContents(MEDIA_REPO, MUSIC_FOLDER + '/' + name, MEDIA_BRANCH, item.sha, req.gpid + ' excluiu música: ' + name);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao excluir música: ' + e.message });
  }
});

// ---------- etapa de processamento: gerador de vídeo + estabilizador de volume ----------
// Isto é o que separa "processamento" de "manipulação": nenhum arquivo bruto
// enviado aqui entra em /media diretamente. Ele só vira mídia da TV depois de
// passar pelo ffmpeg (virar vídeo com duração/música definidas, ou ter seu
// volume normalizado), e é só o resultado processado que é gravado no
// repositório público.

function safeBaseName(originalName) {
  const noExt = originalName.replace(/\.[^./\\]+$/, '');
  return noExt.replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'midia';
}

async function pickRandomMusic() {
  const list = await gh.getContents(MEDIA_REPO, MUSIC_FOLDER, MEDIA_BRANCH);
  const tracks = (list || []).filter((it) => it.type === 'file' && AUDIO_EXT.includes(extOf(it.name)));
  if (tracks.length === 0) { return null; }
  return tracks[Math.floor(Math.random() * tracks.length)];
}

async function findMusicByName(name) {
  const list = await gh.getContents(MEDIA_REPO, MUSIC_FOLDER, MEDIA_BRANCH);
  return (list || []).find((it) => it.name === name) || null;
}

async function withTempDir(fn) {
  const dir = path.join(os.tmpdir(), 'proc-' + crypto.randomUUID());
  await fs.mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function uniqueMediaName(baseName, ext) {
  const list = await gh.getContents(MEDIA_REPO, 'media', MEDIA_BRANCH);
  const existing = new Set((list || []).map((it) => it.name));
  let candidate = baseName + '.' + ext;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = baseName + '-' + n + '.' + ext;
    n += 1;
  }
  return candidate;
}

// body multipart: file (obrigatório). Sem mais campos - tudo automático.
app.post('/api/process/simple', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) { return res.status(400).json({ error: 'Envie um arquivo.' }); }
  const ext = extOf(req.file.originalname);
  if (ext === 'pdf') {
    return res.status(400).json({ error: 'PDF ainda não é suportado. Envie como imagem por enquanto.' });
  }
  const isImage = IMAGE_EXT.includes(ext);
  const isVideo = VIDEO_EXT.includes(ext);
  if (!isImage && !isVideo) { return res.status(400).json({ error: 'Formato não reconhecido como imagem ou vídeo.' }); }

  try {
    await withTempDir(async (dir) => {
      const inputPath = path.join(dir, 'input.' + ext);
      await fs.writeFile(inputPath, req.file.buffer);
      const outputPath = path.join(dir, 'output.mp4');
      const music = await pickRandomMusic();

      if (isImage) {
        let musicPath = null;
        if (music) {
          musicPath = path.join(dir, 'music.' + extOf(music.name));
          await fs.writeFile(musicPath, await gh.downloadRaw(music.download_url));
        }
        await ffmpeg.imageToVideo(inputPath, musicPath, DEFAULT_IMAGE_DURATION, outputPath);
      } else {
        // vídeo: mantém a duração original, silencia e aplica música automática
        if (music) {
          const musicPath = path.join(dir, 'music.' + extOf(music.name));
          await fs.writeFile(musicPath, await gh.downloadRaw(music.download_url));
          await ffmpeg.replaceVideoAudioWithMusic(inputPath, musicPath, outputPath);
        } else {
          await ffmpeg.muteVideo(inputPath, outputPath);
        }
      }

      const outputBuffer = await fs.readFile(outputPath);
      const finalName = await uniqueMediaName(safeBaseName(req.file.originalname), 'mp4');
      await gh.putContents(MEDIA_REPO, 'media/' + finalName, MEDIA_BRANCH, outputBuffer,
        req.gpid + ' gerou mídia (modo simples): ' + finalName);
      res.json({ ok: true, name: finalName, usedMusic: !!music });
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao gerar mídia: ' + e.message });
  }
});

// body multipart: file (obrigatório), durationSeconds (imagem), musicName
// ("" ou omitido = nenhuma música), keepOriginalAudio ("true"/"false", vídeo)
app.post('/api/process/detailed', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) { return res.status(400).json({ error: 'Envie um arquivo.' }); }
  const ext = extOf(req.file.originalname);
  if (ext === 'pdf') {
    return res.status(400).json({ error: 'PDF ainda não é suportado. Envie como imagem por enquanto.' });
  }
  const isImage = IMAGE_EXT.includes(ext);
  const isVideo = VIDEO_EXT.includes(ext);
  if (!isImage && !isVideo) { return res.status(400).json({ error: 'Formato não reconhecido como imagem ou vídeo.' }); }

  const durationSeconds = Number(req.body.durationSeconds) || DEFAULT_IMAGE_DURATION;
  const musicName = (req.body.musicName || '').trim();
  const keepOriginalAudio = req.body.keepOriginalAudio === 'true';

  try {
    await withTempDir(async (dir) => {
      const inputPath = path.join(dir, 'input.' + ext);
      await fs.writeFile(inputPath, req.file.buffer);
      const outputPath = path.join(dir, 'output.mp4');

      let music = null;
      if (musicName) {
        music = await findMusicByName(musicName);
        if (!music) { throw new Error('Música "' + musicName + '" não encontrada na biblioteca.'); }
      }

      if (isImage) {
        let musicPath = null;
        if (music) {
          musicPath = path.join(dir, 'music.' + extOf(music.name));
          await fs.writeFile(musicPath, await gh.downloadRaw(music.download_url));
        }
        await ffmpeg.imageToVideo(inputPath, musicPath, durationSeconds, outputPath);
      } else if (keepOriginalAudio) {
        await ffmpeg.normalizeVideoAudio(inputPath, outputPath);
      } else if (music) {
        const musicPath = path.join(dir, 'music.' + extOf(music.name));
        await fs.writeFile(musicPath, await gh.downloadRaw(music.download_url));
        await ffmpeg.replaceVideoAudioWithMusic(inputPath, musicPath, outputPath);
      } else {
        await ffmpeg.muteVideo(inputPath, outputPath);
      }

      const outputBuffer = await fs.readFile(outputPath);
      const finalName = await uniqueMediaName(safeBaseName(req.file.originalname), 'mp4');
      await gh.putContents(MEDIA_REPO, 'media/' + finalName, MEDIA_BRANCH, outputBuffer,
        req.gpid + ' gerou mídia (modo detalhado): ' + finalName);
      res.json({ ok: true, name: finalName });
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao gerar mídia: ' + e.message });
  }
});



app.listen(PORT, () => console.log('Backend rodando na porta ' + PORT));
