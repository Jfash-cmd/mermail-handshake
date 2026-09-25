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
  // 4. Check PIN protection in HTML
  assert.match(htmlText, /pinInput/i);
  assert.match(htmlText, /btnVerifyPin/i);

  // 5. Check GET /api/pin-status
  const pinStatusRes = await fetch(`http://localhost:${testPort}/api/pin-status`);
  assert.strictEqual(pinStatusRes.status, 200);
  const pinStatusJson = await pinStatusRes.json();
  assert.strictEqual(pinStatusJson.ok, true);

  // 6. Check POST /api/verify-pin rejects wrong PIN
  const wrongPinRes = await fetch(`http://localhost:${testPort}/api/verify-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: 'wrong-pin-99999' })
  });
  assert.strictEqual(wrongPinRes.status, 401);
  const wrongPinJson = await wrongPinRes.json();
  assert.strictEqual(wrongPinJson.ok, false);
  assert.strictEqual(wrongPinJson.verified, false);

  // 7. Check POST /api/verify-pin accepts correct PIN (process.env.DASHBOARD_PIN)
  const configuredPin = process.env.DASHBOARD_PIN || '1234';
  const correctPinRes = await fetch(`http://localhost:${testPort}/api/verify-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: configuredPin })
  });
  assert.strictEqual(correctPinRes.status, 200);
  const correctPinJson = await correctPinRes.json();
  assert.strictEqual(correctPinJson.ok, true);
  assert.strictEqual(correctPinJson.verified, true);

  // 8. Check POST /api/negotiate rejects request with invalid/missing PIN
  const unauthStartRes = await fetch(`http://localhost:${testPort}/api/negotiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction: 'Test instruction', pin: 'invalid' })
  });
  assert.strictEqual(unauthStartRes.status, 401);
  const unauthStartJson = await unauthStartRes.json();
  assert.strictEqual(unauthStartJson.ok, false);
  assert.match(unauthStartJson.error, /PIN/i);
});
