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
