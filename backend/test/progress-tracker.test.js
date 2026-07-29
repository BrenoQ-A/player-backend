'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProgressTracker } = require('../progress-tracker');

test('acompanha progresso somente para o proprietário do upload', () => {
  const tracker = createProgressTracker();
  const id = 'upload-12345678';

  assert.equal(tracker.start(id, '09521542', 'video.mp4'), id);
  assert.equal(tracker.get(id, 'OUTRO'), null);
  assert.equal(tracker.update(id, 'OUTRO', { percent: 50 }), false);
  assert.equal(tracker.update(id, '09521542', {
    stage: 'transcoding',
    percent: 42.5,
    processing: 'transcoded'
  }), true);

  const progress = tracker.get(id, '09521542');
  assert.equal(progress.stage, 'transcoding');
  assert.equal(progress.percent, 42.5);
  assert.equal(progress.processing, 'transcoded');
  assert.equal(progress.owner, undefined);
  assert.deepEqual(tracker.stats(), { active: 1, tracked: 1 });
});

test('rejeita identificador inválido e encerra trabalhos concluídos', () => {
  const tracker = createProgressTracker();
  assert.equal(tracker.start('curto', '09521542', 'video.mp4'), null);

  const id = 'upload-87654321';
  tracker.start(id, '09521542', 'video.mp4');
  tracker.update(id, '09521542', { stage: 'complete', percent: 100 });
  assert.deepEqual(tracker.stats(), { active: 0, tracked: 1 });
});
