'use strict';

const ID_PATTERN = /^[a-zA-Z0-9-]{8,80}$/;

function createProgressTracker(options) {
  const opts = options || {};
  const ttlMs = Math.max(60000, Number(opts.ttlMs || 10 * 60 * 1000));
  const jobs = new Map();

  function cleanup() {
    const cutoff = Date.now() - ttlMs;
    for (const [id, job] of jobs.entries()) {
      if (job.updatedAt < cutoff) { jobs.delete(id); }
    }
  }

  function start(id, owner, fileName) {
    cleanup();
    if (!ID_PATTERN.test(String(id || ''))) { return null; }
    const now = Date.now();
    const job = {
      id: String(id),
      owner: String(owner || ''),
      fileName: String(fileName || ''),
      stage: 'checking',
      percent: 0,
      processing: null,
      queuePosition: null,
      message: 'Verificando compatibilidade.',
      createdAt: now,
      updatedAt: now
    };
    jobs.set(job.id, job);
    return job.id;
  }

  function update(id, owner, patch) {
    const job = jobs.get(String(id || ''));
    if (!job || job.owner !== String(owner || '')) { return false; }
    const source = patch || {};
    Object.keys(source).forEach((key) => {
      if (!['id', 'owner', 'createdAt'].includes(key)) {
        job[key] = source[key];
      }
    });
    job.updatedAt = Date.now();
    return true;
  }

  function get(id, owner) {
    cleanup();
    const job = jobs.get(String(id || ''));
    if (!job || job.owner !== String(owner || '')) { return null; }
    const result = {};
    Object.keys(job).forEach((key) => {
      if (key !== 'owner') { result[key] = job[key]; }
    });
    return result;
  }

  function stats() {
    cleanup();
    let active = 0;
    jobs.forEach((job) => {
      if (!['complete', 'failed'].includes(job.stage)) { active += 1; }
    });
    return { active, tracked: jobs.size };
  }

  return { start, update, get, stats };
}

module.exports = { createProgressTracker };
