const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { startServer, server, negotiationState } = require('../server.js');

test('Dashboard server starts, serves endpoints and HTML', async (t) => {
  const testPort = 3055;
  await startServer(testPort);

  t.after(() => {
    return new Promise((resolve) => server.close(resolve));
  });

  // 1. Check GET /
  const htmlRes = await fetch(`http://localhost:${testPort}/`);
  assert.strictEqual(htmlRes.status, 200);
  const htmlText = await htmlRes.text();
  assert.match(htmlText, /Mermail Handshake/i);
  assert.match(htmlText, /Start Negotiation/i);
  assert.match(htmlText, /grain-overlay/i);

  // 2. Check GET /api/status
  const statusRes = await fetch(`http://localhost:${testPort}/api/status`);
  assert.strictEqual(statusRes.status, 200);
  const statusJson = await statusRes.json();
  assert.strictEqual(statusJson.status, 'idle');

  // 3. Check GET /api/transcripts
  const transRes = await fetch(`http://localhost:${testPort}/api/transcripts`);
  assert.strictEqual(transRes.status, 200);
  const transJson = await transRes.json();
  assert.ok(Array.isArray(transJson.transcripts));
});
