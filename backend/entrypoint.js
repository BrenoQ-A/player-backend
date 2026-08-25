'use strict';

const express = require('express');
const { createApp } = require('./server');
const { createStagingManager, createStagingRouter } = require('./staging');

const PORT = Number(process.env.PORT || 3000);

function createRootApp() {
  const production = createApp();
  const manager = createStagingManager(production.storage, production.catalog);
  const root = express();

  root.use('/api/staging', createStagingRouter(
    manager,
    production.catalog,
    production.storage
  ));
  root.use(production.app);

  return {
    app: root,
    production,
    staging: manager
  };
}

async function start() {
  const root = createRootApp();
  await root.staging.ensure();

  const server = root.app.listen(PORT, '0.0.0.0', function listening() {
    console.log('Backend rodando na porta ' + PORT + ' com staging isolado.');
  });

  server.requestTimeout = 15 * 60 * 1000;
  server.headersTimeout = 16 * 60 * 1000;
  return server;
}

if (require.main === module) {
  start().catch(function fatal(error) {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createRootApp, start };
