'use strict';

// Load .env if present (optional, no external deps)
const fs = require('fs');
const path = require('path');
// 按优先级查找 .env：当前目录 → 可执行文件所在目录 → ~/.iflow-relay
const _envCandidates = [
  path.join(process.cwd(), '.env'),
  path.join(path.dirname(process.execPath), '.env'),
  path.join(require('os').homedir(), '.iflow-relay', '.env'),
];
const envFile = _envCandidates.find(f => { try { return require('fs').existsSync(f); } catch(_){return false;} });
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

const http = require('http');
const { load } = require('./src/config.js');
const { createHandler } = require('./src/server.js');

const cfg = load();
const handler = createHandler(cfg);
const server = http.createServer(handler);

server.listen(cfg.port, () => {
  console.log(`iflow-relay started on :${cfg.port}`);
  console.log(`upstreams=${cfg.upstreams.length} models=${cfg.models.join(',')}`);
});

function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down...`);
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
