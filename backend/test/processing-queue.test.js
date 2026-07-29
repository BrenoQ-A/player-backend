'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProcessingQueue } = require('../processing-queue');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('executa processamentos pesados um por vez', async () => {
  const queue = createProcessingQueue({ maxPending: 3 });
  const firstGate = deferred();
  const events = [];

  const first = queue.run(async () => {
    events.push('first:start');
    await firstGate.promise;
    events.push('first:end');
    return 1;
  });
  const second = queue.run(async () => {
    events.push('second:start');
    events.push('second:end');
    return 2;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  assert.deepEqual(queue.stats(), { active: 1, waiting: 1, maxPending: 3 });

  firstGate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
  assert.deepEqual(queue.stats(), { active: 0, waiting: 0, maxPending: 3 });
});

test('continua a fila após falha e rejeita excesso de tarefas', async () => {
  const queue = createProcessingQueue({ maxPending: 2 });
  const gate = deferred();
  const first = queue.run(async () => {
    await gate.promise;
    throw new Error('falha esperada');
  });
  const second = queue.run(async () => 'ok');
  const excess = queue.run(async () => 'não deve executar');

  await assert.rejects(excess, (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'PROCESSING_QUEUE_FULL');
    return true;
  });

  gate.resolve();
  await assert.rejects(first, /falha esperada/);
  assert.equal(await second, 'ok');
});
