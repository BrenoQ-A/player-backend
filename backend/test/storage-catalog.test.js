'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { createStorage } = require('../storage');
const { createCatalog } = require('../catalog');

test('armazenamento local e catálogo mantêm playlist ordenada', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'player-storage-test-'));
  try {
    const storage = createStorage({
      driver: 'local',
      localDir: dir,
      publicBaseUrl: 'https://media.example.test'
    });
    const catalog = createCatalog(storage);

    await storage.putBuffer('media/a.mp4', Buffer.from('a'), 'video/mp4');
    await storage.putBuffer('media/b.mp4', Buffer.from('b'), 'video/mp4');
    const downloaded = path.join(dir, 'downloaded.mp4');
    assert.equal(await storage.getFile('media/a.mp4', downloaded), true);
    assert.equal(await fs.readFile(downloaded, 'utf8'), 'a');
    assert.equal(await storage.getFile('media/missing.mp4', downloaded), false);
    const uploaded = path.join(dir, 'uploaded.mp4');
    await fs.writeFile(uploaded, 'streamed');
    const uploadProgress = [];
    await storage.putFile(
      'media/streamed.mp4',
      uploaded,
      'video/mp4',
      'no-cache',
      (progress) => uploadProgress.push(progress.percent)
    );
    assert.deepEqual(uploadProgress, [100]);

    const first = await catalog.addMedia({
      name: 'A.mp4',
      key: 'media/a.mp4',
      type: 'video'
    });
    const second = await catalog.addMedia({
      name: 'B.mp4',
      key: 'media/b.mp4',
      type: 'video'
    });

    let playlist = await catalog.getPlaylist();
    assert.equal(playlist.items.length, 2);
    assert.equal(playlist.items[0].url, 'https://media.example.test/media/a.mp4');

    await catalog.reorderMedia([second.id, first.id]);
    playlist = await catalog.getPlaylist();
    assert.deepEqual(
      playlist.items.map((item) => item.id),
      [second.id, first.id]
    );
    assert.deepEqual(
      playlist.items.map((item) => item.order),
      [1, 2]
    );

    const removed = await catalog.removeMedia(first.id);
    assert.equal(removed.id, first.id);
    playlist = await catalog.getPlaylist();
    assert.equal(playlist.items.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('armazenamento rejeita chaves que escapam da pasta', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'player-storage-test-'));
  try {
    const storage = createStorage({
      driver: 'local',
      localDir: dir,
      publicBaseUrl: 'https://media.example.test'
    });
    await assert.rejects(
      storage.putBuffer('../segredo.txt', Buffer.from('x')),
      /inválida/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('catálogo impede novos duplicados e limpa duplicados antigos', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'player-catalog-dedup-test-'));
  try {
    const storage = createStorage({
      driver: 'local',
      localDir: dir,
      publicBaseUrl: 'https://media.example.test'
    });
    const catalog = createCatalog(storage);
    const base = {
      originalName: 'Campanha.mp4',
      name: 'Campanha.mp4',
      type: 'video',
      sizeBytes: 123456,
      durationSeconds: 30
    };

    const first = await catalog.addMedia({
      ...base,
      key: 'media/primeiro.mp4',
      contentHash: 'hash-a'
    });
    await assert.rejects(
      catalog.addMedia({
        ...base,
        key: 'media/duplicado.mp4',
        contentHash: 'hash-a'
      }),
      (error) => error.code === 'MEDIA_DUPLICATE' && error.media.id === first.id
    );

    const playlist = await catalog.getPlaylist();
    playlist.items.push({
      ...base,
      id: 'duplicado-legado',
      key: 'media/duplicado-legado.mp4',
      order: 2,
      url: 'https://media.example.test/media/duplicado-legado.mp4'
    });
    await storage.putJson('playlist.json', playlist);

    const result = await catalog.deduplicateMedia();
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0].id, 'duplicado-legado');
    assert.deepEqual(result.playlist.items.map((item) => item.id), [first.id]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('catálogo substitui o arquivo preservando identidade e ordem', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'player-catalog-replace-test-'));
  try {
    const storage = createStorage({
      driver: 'local',
      localDir: dir,
      publicBaseUrl: 'https://media.example.test'
    });
    const catalog = createCatalog(storage);
    const first = await catalog.addMedia({
      name: 'A.mp4',
      originalName: 'A.mp4',
      key: 'media/a.mp4',
      type: 'video',
      sizeBytes: 100,
      durationSeconds: 10,
      contentHash: 'antes'
    });

    const result = await catalog.replaceMedia(first.id, {
      key: 'media/a-720p.mp4',
      sizeBytes: 80,
      contentHash: 'depois'
    });
    assert.equal(result.previous.key, 'media/a.mp4');
    assert.equal(result.media.id, first.id);
    assert.equal(result.media.order, 1);
    assert.equal(result.media.key, 'media/a-720p.mp4');
    assert.equal(result.media.url, 'https://media.example.test/media/a-720p.mp4');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
