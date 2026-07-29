'use strict';

function createProcessingQueue(options) {
  const opts = options || {};
  const maxPending = Math.max(1, Number(opts.maxPending || 4));
  let tail = Promise.resolve();
  let active = 0;
  let waiting = 0;

  function run(task) {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('A tarefa de processamento deve ser uma função.'));
    }
    if (active + waiting >= maxPending) {
      const error = new Error(
        'O servidor já está processando outras mídias. Aguarde a fila terminar e tente novamente.'
      );
      error.status = 503;
      error.code = 'PROCESSING_QUEUE_FULL';
      return Promise.reject(error);
    }

    waiting += 1;
    const result = tail.then(async () => {
      waiting -= 1;
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
      }
    });
    tail = result.catch(() => {});
    return result;
  }

  function stats() {
    return { active, waiting, maxPending };
  }

  return { run, stats };
}

module.exports = { createProcessingQueue };
