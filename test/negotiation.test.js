const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseOffer,
  evaluateNegotiation,
  formatPrice,
  buildReplyBody,
  handleIncomingOffer,
  ANCHOR,
  FLOOR,
  MAX_ROUNDS,
  LADDER,
  runWithTimeout
} = require('../vendor-bot.js');

test('parseOffer extracts OFFER and ROUND correctly from plain text', () => {
  const body = `Hello,
I would like to make an offer.

OFFER: $0.40/unit x 100 units
ROUND: 1

Best regards,
Buyer`;

  const parsed = parseOffer(body);
  assert.notEqual(parsed, null);
  assert.equal(parsed.offerPrice, 0.40);
  assert.equal(parsed.quantity, 100);
  assert.equal(parsed.round, 1);
});

test('parseOffer handles 3 decimal places and variation in spacing', () => {
  const body = `OFFER:   $0.525/unit   x   100   units
ROUND:   2`;

  const parsed = parseOffer(body);
  assert.notEqual(parsed, null);
  assert.equal(parsed.offerPrice, 0.525);
  assert.equal(parsed.quantity, 100);
  assert.equal(parsed.round, 2);
});

test('parseOffer ignores quoted thread text and picks the top/latest offer', () => {
  const body = `OFFER: $0.48/unit x 100 units
ROUND: 2

On Wed, Sep 23, 2026, buyer-agent wrote:
> OFFER: $0.35/unit x 100 units
> ROUND: 1`;

  const parsed = parseOffer(body);
  assert.notEqual(parsed, null);
  assert.equal(parsed.offerPrice, 0.48);
  assert.equal(parsed.round, 2);
});

test('parseOffer falls back to HTML when body text is missing', () => {
  const html = `<p>OFFER: $0.42/unit x 100 units<br>ROUND: 1</p>`;
  const parsed = parseOffer('', html);
  assert.notEqual(parsed, null);
  assert.equal(parsed.offerPrice, 0.42);
  assert.equal(parsed.quantity, 100);
  assert.equal(parsed.round, 1);
});

test('parseOffer returns null for emails without offer/round lines', () => {
  const body = `Hi there, just wanted to say hello!`;
  const parsed = parseOffer(body);
  assert.equal(parsed, null);
});

test('Negotiation: Round 1 counter price maps to LADDER[0] = 0.60', () => {
  const result = evaluateNegotiation(0.40, 1, 100);
  assert.equal(result.decision, 'COUNTER');
  assert.equal(result.price, 0.60);
  assert.equal(result.round, 2);
  assert.equal(result.isFinal, false);
});

test('Negotiation: Round 2 counter price maps to LADDER[1] = 0.525', () => {
  const result = evaluateNegotiation(0.40, 2, 100);
  assert.equal(result.decision, 'COUNTER');
  assert.equal(result.price, 0.525);
  assert.equal(result.round, 3);
  assert.equal(result.isFinal, false);
});

test('Negotiation: Round 1 accepts if offerPrice >= LADDER[0] (0.60)', () => {
  const result = evaluateNegotiation(0.65, 1, 100);
  assert.equal(result.decision, 'ACCEPT');
  assert.equal(result.price, 0.65);
  assert.equal(result.round, 1);
});

test('Negotiation: Round 2 accepts if offerPrice >= LADDER[1] (0.525)', () => {
  const result = evaluateNegotiation(0.55, 2, 100);
  assert.equal(result.decision, 'ACCEPT');
  assert.equal(result.price, 0.55);
  assert.equal(result.round, 2);
});

test('Negotiation: Round >= MAX_ROUNDS with offer >= FLOOR -> ACCEPT at FLOOR (final)', () => {
  // Round 3 >= MAX_ROUNDS (3). Offer is 0.45 >= FLOOR (0.45)
  const result = evaluateNegotiation(0.45, 3, 100);
  assert.equal(result.decision, 'ACCEPT');
  assert.equal(result.price, 0.45);
  assert.equal(result.isFinal, true);
});

test('Negotiation: Round >= MAX_ROUNDS with offer < FLOOR -> WALK_AWAY', () => {
  // Round 3 >= MAX_ROUNDS (3). Offer is 0.35 < FLOOR (0.45)
  const result = evaluateNegotiation(0.35, 3, 100);
  assert.equal(result.decision, 'WALK_AWAY');
  assert.equal(result.price, null);
});

test('buildReplyBody includes decision, machine-readable lines, and explanation', () => {
  const counterResult = evaluateNegotiation(0.40, 1, 100);
  const counterBody = buildReplyBody(counterResult);
  assert.match(counterBody, /DECISION: COUNTER/);
  assert.match(counterBody, /OFFER: \$0\.60\/unit x 100 units/);
  assert.match(counterBody, /ROUND: 2/);

  const acceptResult = evaluateNegotiation(0.65, 1, 100);
  const acceptBody = buildReplyBody(acceptResult);
  assert.match(acceptBody, /DECISION: ACCEPT/);

  const walkResult = evaluateNegotiation(0.30, 3, 100);
  const walkBody = buildReplyBody(walkResult);
  assert.match(walkBody, /DECISION: WALK_AWAY/);
});

test('Duplicate incoming emails at Round 1: first email countered with Round 2, second duplicate email skipped', () => {
  const state = {
    processedUids: new Set(),
    processedMessageIds: new Set(),
    activeNegotiations: new Map()
  };

  const email1 = {
    uid: 101,
    messageId: 'msg-round1-first@mermail.app',
    sender: 'rewardcourt@mermail.app',
    subject: 'Widget X Negotiation',
    bodyText: 'OFFER: $0.40/unit x 100 units\nROUND: 1',
    htmlText: ''
  };

  // First incoming email at Round 1 triggers COUNTER reply with Round 2 at $0.60/unit
  const response1 = handleIncomingOffer(email1, state);
  assert.equal(response1.action, 'REPLY');
  assert.equal(response1.result.decision, 'COUNTER');
  assert.equal(response1.result.price, 0.60);
  assert.equal(response1.result.round, 2);

  // State recorded
  assert.equal(state.processedUids.has(101), true);
  assert.equal(state.processedMessageIds.has('msg-round1-first@mermail.app'), true);
  assert.equal(state.activeNegotiations.get('rewardcourt@mermail.app').lastProcessedRound, 1);

  // Second incoming email from same sender with different UID/Message-ID but identical ROUND: 1
  const email2 = {
    uid: 102,
    messageId: 'msg-round1-second@mermail.app',
    sender: 'rewardcourt@mermail.app',
    subject: 'Widget X Negotiation',
    bodyText: 'OFFER: $0.40/unit x 100 units\nROUND: 1',
    htmlText: ''
  };

  const response2 = handleIncomingOffer(email2, state);
  assert.equal(response2.action, 'SKIP_DUPLICATE_ROUND');
  assert.equal(response2.offerData.round, 1);
  assert.equal(response2.lastProcessedRound, 1);
  assert.match(response2.reason, /Duplicate or stale offer for Round 1/);

  // Second email is recorded as processed so it will never be evaluated again
  assert.equal(state.processedUids.has(102), true);
  assert.equal(state.processedMessageIds.has('msg-round1-second@mermail.app'), true);
});

test('Duplicate incoming emails at Round 2: handles first Round 2 email and rejects duplicate Round 2 email', () => {
  const state = {
    processedUids: new Set(),
    processedMessageIds: new Set(),
    activeNegotiations: new Map()
  };

  // Round 1
  const round1 = handleIncomingOffer({
    uid: 201,
    messageId: 'msg-round1@mermail.app',
    sender: 'rewardcourt@mermail.app',
    subject: 'Widget X Negotiation',
    bodyText: 'OFFER: $0.40/unit x 100 units\nROUND: 1'
  }, state);
  assert.equal(round1.action, 'REPLY');
  assert.equal(round1.result.round, 2);

  // Round 2 - first incoming email
  const round2First = handleIncomingOffer({
    uid: 202,
    messageId: 'msg-round2-a@mermail.app',
    sender: 'rewardcourt@mermail.app',
    subject: 'Re: Widget X Negotiation',
    bodyText: 'OFFER: $0.45/unit x 100 units\nROUND: 2'
  }, state);

  assert.equal(round2First.action, 'REPLY');
  assert.equal(round2First.result.decision, 'COUNTER');
  assert.equal(round2First.result.price, 0.525);
  assert.equal(round2First.result.round, 3);

  // Round 2 - duplicate second email arriving at same round
  const round2Second = handleIncomingOffer({
    uid: 203,
    messageId: 'msg-round2-b@mermail.app',
    sender: 'rewardcourt@mermail.app',
    subject: 'Re: Widget X Negotiation',
    bodyText: 'OFFER: $0.45/unit x 100 units\nROUND: 2'
  }, state);

  // Must NOT trigger another Round 2 counter reply!
  assert.equal(round2Second.action, 'SKIP_DUPLICATE_ROUND');
  assert.equal(round2Second.offerData.round, 2);
  assert.equal(round2Second.lastProcessedRound, 2);

  // Round 3 - legitimate progression should be processed and accepted
  const round3 = handleIncomingOffer({
    uid: 204,
    messageId: 'msg-round3@mermail.app',
    sender: 'rewardcourt@mermail.app',
    subject: 'Re: Widget X Negotiation',
    bodyText: 'OFFER: $0.50/unit x 100 units\nROUND: 3'
  }, state);

  assert.equal(round3.action, 'REPLY');
  assert.equal(round3.result.decision, 'ACCEPT');
  assert.equal(round3.result.price, 0.45);
});

test('Duplicate incoming emails by identical UID or Message-ID are skipped', () => {
  const state = {
    processedUids: new Set([301]),
    processedMessageIds: new Set(['existing-msg@mermail.app']),
    activeNegotiations: new Map()
  };

  const skipByUid = handleIncomingOffer({
    uid: 301,
    messageId: 'new-msg@mermail.app',
    sender: 'rewardcourt@mermail.app',
    subject: 'Widget X Negotiation',
    bodyText: 'OFFER: $0.40/unit x 100 units\nROUND: 1'
  }, state);
  assert.equal(skipByUid.action, 'SKIP');

  const skipByMsgId = handleIncomingOffer({
    uid: 302,
    messageId: 'existing-msg@mermail.app',
    sender: 'rewardcourt@mermail.app',
    subject: 'Widget X Negotiation',
    bodyText: 'OFFER: $0.40/unit x 100 units\nROUND: 1'
  }, state);
  assert.equal(skipByMsgId.action, 'SKIP');
});

test('runWithTimeout resolves successfully when task completes in time', async () => {
  const result = await runWithTimeout(
    Promise.resolve('success_val'),
    1000,
    'Should not time out'
  );
  assert.equal(result, 'success_val');
});

test('runWithTimeout rejects with ETIMEDOUT when task stalls', async () => {
  const hangingPromise = new Promise((resolve) => {
    // Never resolves
  });

  await assert.rejects(
    async () => {
      await runWithTimeout(hangingPromise, 50, 'Operation timed out after 50ms');
    },
    (err) => {
      assert.equal(err.code, 'ETIMEDOUT');
      assert.ok(err.message.includes('timed out after 50ms'));
      return true;
    }
  );
});

