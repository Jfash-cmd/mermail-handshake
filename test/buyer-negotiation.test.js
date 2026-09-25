const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateBuyerDecision,
  buildBuyerEmailBody,
  parseOffer,
  formatPrice,
  BUDGET_CAP,
  UNITS,
  MAX_ROUNDS,
  BUYER_EMAIL,
  BUYER_MAILBOX_ID,
  VENDOR_EMAIL,
  PRODUCT_NAME,
  INSTRUCTION,
  DEFAULT_INSTRUCTION,
  getCommandLineInstruction,
  DEFAULT_BUDGET_CAP,
  DEFAULT_UNITS,
  DEFAULT_VENDOR_EMAIL,
  DEFAULT_PRODUCT_NAME,
  parseInstruction,
  resolveNegotiationParameters,
  logNegotiationParameters,
  getPayboxConnectionStatus,
  formatPaymentApprovalSummary,
  printPaymentApprovalBanner,
  callMermailWalletMcp,
  NegotiationTracker,
  formatTranscriptFilename,
  saveTranscriptToFile,
  sendTranscriptEmail,
  runBuyerAgent
} = require('../buyer-agent.js');
const { evaluateNegotiation } = require('../vendor-bot.js');

test('Buyer: Accepts immediately if vendor offer total is <= BUDGET_CAP', () => {
  // Vendor counters with 0.45 * 100 = $45.00 <= $50.00
  const result = evaluateBuyerDecision({
    vendorOfferPrice: 0.45,
    vendorRound: 2,
    vendorDecision: 'COUNTER',
    buyerLastOffer: 0.40,
    budgetCap: 50.0,
    units: 100,
    maxRounds: 3
  });

  assert.equal(result.decision, 'ACCEPT');
  assert.equal(result.price, 0.45);
  assert.equal(result.totalCost, 45.0);
  assert.equal(result.round, 2);
});

test('Buyer: Counters if vendor offer > BUDGET_CAP and vendorRound <= MAX_ROUNDS (splits difference)', () => {
  // Buyer at 0.40, Vendor at 0.60, round 2. Difference = 0.20, half = 0.10. Counter = 0.50.
  const result = evaluateBuyerDecision({
    vendorOfferPrice: 0.60,
    vendorRound: 2,
    vendorDecision: 'COUNTER',
    buyerLastOffer: 0.40,
    budgetCap: 50.0,
    units: 100,
    maxRounds: 3
  });

  assert.equal(result.decision, 'COUNTER');
  assert.equal(result.price, 0.50);
  assert.equal(result.totalCost, 50.0);
  assert.equal(result.round, 3);
});

test('Buyer: Sends final-round counter at vendorRound == MAX_ROUNDS at max affordable price (0.50)', () => {
  // Vendor counters with 0.525 at vendorRound 3 == MAX_ROUNDS.
  // Buyer last offer was 0.50. Max affordable is 50.0 / 100 = 0.50.
  // Buyer should send one more counter at 0.50.
  const result = evaluateBuyerDecision({
    vendorOfferPrice: 0.525,
    vendorRound: 3,
    vendorDecision: 'COUNTER',
    buyerLastOffer: 0.50,
    budgetCap: 50.0,
    units: 100,
    maxRounds: 3
  });

  assert.equal(result.decision, 'COUNTER');
  assert.equal(result.price, 0.50);
  assert.equal(result.totalCost, 50.0);
  assert.equal(result.round, 4);
});

test('Buyer: Walks away only after final counter was sent (vendorRound > MAX_ROUNDS) and still unaffordable', () => {
  // vendorRound 4 > MAX_ROUNDS (3), vendor offer is 0.55 * 100 = $55.00 > $50.00
  const result = evaluateBuyerDecision({
    vendorOfferPrice: 0.55,
    vendorRound: 4,
    vendorDecision: 'COUNTER',
    buyerLastOffer: 0.50,
    budgetCap: 50.0,
    units: 100,
    maxRounds: 3
  });

  assert.equal(result.decision, 'WALK_AWAY');
  assert.equal(result.price, null);
  assert.equal(result.round, 4);
});

test('Buyer: Honors explicit vendor ACCEPT decision', () => {
  const result = evaluateBuyerDecision({
    vendorOfferPrice: 0.40,
    vendorRound: 1,
    vendorDecision: 'ACCEPT',
    buyerLastOffer: 0.40,
    budgetCap: 50.0,
    units: 100,
    maxRounds: 3
  });

  assert.equal(result.decision, 'ACCEPT');
  assert.equal(result.price, 0.40);
  assert.equal(result.totalCost, 40.0);
});

test('Buyer: Honors explicit vendor WALK_AWAY decision', () => {
  const result = evaluateBuyerDecision({
    vendorOfferPrice: null,
    vendorRound: 3,
    vendorDecision: 'WALK_AWAY',
    buyerLastOffer: 0.45,
    budgetCap: 50.0,
    units: 100,
    maxRounds: 3
  });

  assert.equal(result.decision, 'WALK_AWAY');
});

test('Simulation: Buyer 0.40 -> Vendor 0.60 -> Buyer 0.50 -> Vendor 0.525 -> Buyer final 0.50 -> Vendor ACCEPTS', () => {
  // 1. Buyer opening offer
  const buyerOffer1 = 0.40;
  const buyerRound1 = 1;

  // 2. Vendor receives 0.40 at Round 1
  const vendorResponse1 = evaluateNegotiation(buyerOffer1, buyerRound1, 100);
  assert.equal(vendorResponse1.decision, 'COUNTER');
  assert.equal(vendorResponse1.price, 0.60);
  assert.equal(vendorResponse1.round, 2);

  // 3. Buyer receives Vendor counter of 0.60 (Round 2)
  const buyerResponse1 = evaluateBuyerDecision({
    vendorOfferPrice: vendorResponse1.price,
    vendorRound: vendorResponse1.round,
    vendorDecision: vendorResponse1.decision,
    buyerLastOffer: buyerOffer1,
    budgetCap: 50.0,
    units: 100,
    maxRounds: 3
  });
  assert.equal(buyerResponse1.decision, 'COUNTER');
  assert.equal(buyerResponse1.price, 0.50); // Split difference (0.60 - 0.40)/2 = 0.10 + 0.40 = 0.50
  assert.equal(buyerResponse1.round, 3);

  // 4. Vendor counters with 0.525 at Round 3
  const vendorPrice2 = 0.525;
  const vendorRound2 = 3;

  // 5. Buyer receives Vendor counter of 0.525 at vendorRound == MAX_ROUNDS (3)
  // Buyer is willing to send one more counter at max affordable (0.50)
  const buyerResponse2 = evaluateBuyerDecision({
    vendorOfferPrice: vendorPrice2,
    vendorRound: vendorRound2,
    vendorDecision: 'COUNTER',
    buyerLastOffer: buyerResponse1.price,
    budgetCap: 50.0,
    units: 100,
    maxRounds: 3
  });
  assert.equal(buyerResponse2.decision, 'COUNTER');
  assert.equal(buyerResponse2.price, 0.50); // Capped at max affordable budget ($50/100)
  assert.equal(buyerResponse2.round, 4);

  // 6. Vendor evaluates buyer final counter of 0.50 at round 3 (final round)
  // Vendor FLOOR is 0.45. Offer 0.50 >= FLOOR (0.45) -> ACCEPT!
  const vendorFinal = evaluateNegotiation(buyerResponse2.price, 3, 100);
  assert.equal(vendorFinal.decision, 'ACCEPT');
  assert.equal(vendorFinal.isFinal, true);

  // 7. Buyer receives vendor acceptance -> Deal confirmed!
  const buyerFinal = evaluateBuyerDecision({
    vendorOfferPrice: vendorFinal.price,
    vendorRound: vendorFinal.round,
    vendorDecision: vendorFinal.decision,
    buyerLastOffer: buyerResponse2.price,
    budgetCap: 50.0,
    units: 100,
    maxRounds: 3
  });
  assert.equal(buyerFinal.decision, 'ACCEPT');
  assert.equal(buyerFinal.totalCost, 45.0); // Vendor accepted at FLOOR $0.45 * 100 = $45.00
});

test('Buyer: buildBuyerEmailBody formats ACCEPT, COUNTER, and WALK_AWAY correctly', () => {
  const acceptResult = evaluateBuyerDecision({
    vendorOfferPrice: 0.45,
    vendorRound: 2,
    vendorDecision: 'COUNTER',
    buyerLastOffer: 0.40,
    budgetCap: 50.0,
    units: 100,
    maxRounds: 3
  });
  const acceptBody = buildBuyerEmailBody(acceptResult);
  assert.match(acceptBody, /DECISION: ACCEPT/);
  assert.match(acceptBody, /OFFER: \$0\.45\/unit x 100 units/);
  assert.match(acceptBody, /ROUND: 2/);

  const counterResult = evaluateBuyerDecision({
    vendorOfferPrice: 0.60,
    vendorRound: 1,
    vendorDecision: 'COUNTER',
    buyerLastOffer: 0.40,
    budgetCap: 50.0,
    units: 100,
    maxRounds: 3
  });
  const counterBody = buildBuyerEmailBody(counterResult);
  assert.match(counterBody, /DECISION: COUNTER/);
  assert.match(counterBody, /OFFER: \$0\.50\/unit x 100 units/);
  assert.match(counterBody, /ROUND: 2/);

  const walkResult = evaluateBuyerDecision({
    vendorOfferPrice: 0.55,
    vendorRound: 4,
    vendorDecision: 'COUNTER',
    buyerLastOffer: 0.50,
    budgetCap: 50.0,
    units: 100,
    maxRounds: 3
  });
  const walkBody = buildBuyerEmailBody(walkResult);
  assert.match(walkBody, /DECISION: WALK_AWAY/);
  assert.match(walkBody, /ROUND: 4/);
});

test('Buyer: Payment approval summary includes wallet info when wallet call succeeds (mocked)', async () => {
  const mockWalletData = {
    status: 'ACTIVE',
    balance: '$250.00',
    portfolio: { USDC: 250, SOL: 1.5 }
  };

  const mockCaller = async (toolName, args) => {
    assert.equal(toolName, 'get_paybox_connection');
    return mockWalletData;
  };

  const walletStatus = await getPayboxConnectionStatus(mockCaller);
  assert.deepEqual(walletStatus, mockWalletData);

  const dealSummary = {
    price: 0.45,
    units: 100,
    totalCost: 45.0
  };

  const summaryText = formatPaymentApprovalSummary(dealSummary, walletStatus);
  assert.match(summaryText, /READY FOR PAYMENT APPROVAL/);
  assert.match(summaryText, /Status:\s+DEAL ACCEPTED/);
  assert.match(summaryText, /Price Per Unit:\s+\$0\.45/);
  assert.match(summaryText, /Units:\s+100/);
  assert.match(summaryText, /Total Price:\s+\$45\.00/);
  assert.match(summaryText, /Wallet Status:\s+ACTIVE/);
  assert.match(summaryText, /Wallet Balance:\s+\$250\.00/);
  assert.match(summaryText, /Portfolio:\s+\{"USDC":250,"SOL":1.5\}/);

  // Also verify printPaymentApprovalBanner resolves without throwing
  const printed = await printPaymentApprovalBanner(dealSummary, walletStatus);
  assert.equal(printed, summaryText);
});

test('Buyer: Payment approval summary completes gracefully with "Wallet status unavailable" when wallet call fails (mocked)', async () => {
  const mockFailingCaller = async () => {
    throw new Error('Connection refused: MCP server timeout');
  };

  // Must not throw, should return null gracefully
  const walletStatus = await getPayboxConnectionStatus(mockFailingCaller);
  assert.equal(walletStatus, null);

  const dealSummary = {
    price: 0.50,
    units: 100,
    totalCost: 50.0
  };

  const summaryText = formatPaymentApprovalSummary(dealSummary, walletStatus);
  assert.match(summaryText, /READY FOR PAYMENT APPROVAL/);
  assert.match(summaryText, /Status:\s+DEAL ACCEPTED/);
  assert.match(summaryText, /Price Per Unit:\s+\$0\.50/);
  assert.match(summaryText, /Units:\s+100/);
  assert.match(summaryText, /Total Price:\s+\$50\.00/);
  assert.match(summaryText, /Wallet Status:\s+Wallet status unavailable/);

  // Also verify printPaymentApprovalBanner resolves without throwing
  const printed = await printPaymentApprovalBanner(dealSummary, walletStatus);
  assert.equal(printed, summaryText);
});

test('Buyer: Strictly read-only enforcement blocks disallowed wallet tools', async () => {
  await assert.rejects(
    async () => {
      await callMermailWalletMcp('paybox_request_transfer', { to: 'attacker', amount: 100 });
    },
    /Security restriction: Tool "paybox_request_transfer" is not permitted/
  );

  await assert.rejects(
    async () => {
      await callMermailWalletMcp('list_credentials', {});
    },
    /Security restriction: Tool "list_credentials" is not permitted/
  );
});

test('Transcript: NegotiationTracker incrementally builds rounds and generates markdown for ACCEPT deal', () => {
  const tracker = new NegotiationTracker({
    item: 'Widget X',
    units: 100,
    budgetCap: 50.0,
    vendorEmail: 'vendor.negotiator11@gmail.com',
    buyerEmail: 'rewardcourt@mermail.app',
    startTime: '2026-09-24T12:00:00.000Z'
  });

  // Round 1
  tracker.recordBuyerOffer({ round: 1, price: 0.40, units: 100 });
  tracker.recordVendorCounter({ round: 1, decision: 'COUNTER', price: 0.60, units: 100 });

  // Advance to Round 2
  tracker.advanceRound();
  tracker.recordBuyerOffer({ round: 2, price: 0.50, units: 100 });
  tracker.recordVendorCounter({ round: 2, decision: 'COUNTER', price: 0.525, units: 100 });

  // Advance to Round 3
  tracker.advanceRound();
  tracker.recordBuyerOffer({ round: 3, price: 0.50, units: 100 });
  tracker.recordVendorCounter({ round: 3, decision: 'ACCEPT', price: 0.45, units: 100 });

  tracker.finish({
    decisionResult: {
      decision: 'ACCEPT',
      price: 0.45,
      totalCost: 45.0,
      round: 3,
      units: 100,
      message: 'Vendor accepted terms.'
    },
    walletInfo: {
      status: 'ACTIVE',
      balance: '$250.00',
      portfolio: { USDC: 250, SOL: 1.5 }
    }
  });

  const markdown = tracker.generateMarkdown();
  assert.match(markdown, /# Negotiation Transcript: Widget X/);
  assert.match(markdown, /- \*\*Start Time\*\*: 2026-09-24T12:00:00.000Z/);
  assert.match(markdown, /- \*\*End Time\*\*: \d{4}-\d{2}-\d{2}T/);
  assert.match(markdown, /### Round 1/);
  assert.match(markdown, /- \*\*Buyer Offer\*\*: \$0\.40\/unit x 100 units \(\$40\.00 total\)/);
  assert.match(markdown, /- \*\*Vendor Counter\*\*: \$0\.60\/unit x 100 units \(\$60\.00 total\)/);
  assert.match(markdown, /### Round 2/);
  assert.match(markdown, /- \*\*Buyer Offer\*\*: \$0\.50\/unit x 100 units \(\$50\.00 total\)/);
  assert.match(markdown, /- \*\*Vendor Counter\*\*: \$0\.525\/unit x 100 units \(\$52\.50 total\)/);
  assert.match(markdown, /### Round 3/);
  assert.match(markdown, /- \*\*Buyer Offer\*\*: \$0\.50\/unit x 100 units \(\$50\.00 total\)/);
  assert.match(markdown, /- \*\*Vendor ACCEPT\*\*: \$0\.45\/unit x 100 units \(\$45\.00 total\)/);
  assert.match(markdown, /## Final Result: DEAL ACCEPTED/);
  assert.match(markdown, /- \*\*Agreed Price Per Unit\*\*: \$0\.45/);
  assert.match(markdown, /- \*\*Total Price\*\*: \$45\.00/);
  assert.match(markdown, /- \*\*Wallet Status\*\*: ACTIVE/);
  assert.match(markdown, /- \*\*Wallet Balance\*\*: \$250\.00/);
  assert.match(markdown, /- \*\*Portfolio\*\*: \{"USDC":250,"SOL":1.5\}/);
});

test('Buyer Agent: runBuyerAgent creates transcript file with correct rounds & result and sends self-email (mocked sequence)', async () => {
  const tempTranscriptsDir = path.join(__dirname, `test-transcripts-${Date.now()}`);
  if (fs.existsSync(tempTranscriptsDir)) {
    fs.rmSync(tempTranscriptsDir, { recursive: true, force: true });
  }

  // Simulated vendor email stream
  const vendorReplies = [
    {
      id: 'vendor-email-1',
      body: 'OFFER: $0.60/unit x 100 units\nROUND: 2\nDECISION: COUNTER'
    },
    {
      id: 'vendor-email-2',
      body: 'OFFER: $0.525/unit x 100 units\nROUND: 3\nDECISION: COUNTER'
    },
    {
      id: 'vendor-email-3',
      body: 'DECISION: ACCEPT\nOFFER: $0.45/unit x 100 units\nROUND: 3\n\nMaximum rounds reached. We accept at our floor price of $0.45/unit.'
    }
  ];

  let pollCount = 0;
  const sentEmails = [];

  const mockCallMcp = async (toolName, args) => {
    if (toolName === 'list_emails') {
      if (pollCount === 0) {
        // Initial baseline check
        return { emails: [] };
      }
      const reply = vendorReplies[pollCount - 1];
      if (reply) {
        return {
          emails: [
            {
              id: reply.id,
              sender: 'vendor.negotiator11@gmail.com',
              subject: 'Re: Widget X Negotiation'
            }
          ]
        };
      }
      return { emails: [] };
    }

    if (toolName === 'get_email') {
      const email = vendorReplies.find((e) => e.id === args.emailId);
      return email || { id: args.emailId, body: '' };
    }

    if (toolName === 'send_email') {
      sentEmails.push(args);
      // Advance to next vendor reply after sending an offer/counter to vendor
      if (args.body.to === 'vendor.negotiator11@gmail.com') {
        pollCount++;
      }
      return { id: `mock-msg-${sentEmails.length}` };
    }

    throw new Error(`Unexpected tool call: ${toolName}`);
  };

  const mockCallWalletMcp = async (toolName) => {
    assert.equal(toolName, 'get_paybox_connection');
    return {
      status: 'ACTIVE',
      balance: '$250.00',
      portfolio: { USDC: 250, SOL: 1.5 }
    };
  };

  try {
    const result = await runBuyerAgent({
      callMcp: mockCallMcp,
      callWalletMcp: mockCallWalletMcp,
      transcriptsDir: tempTranscriptsDir,
      pollIntervalMs: 0,
      jitterMaxMs: 0
    });

    assert.equal(result.finalResult.decision, 'ACCEPT');
    assert.equal(result.finalResult.price, 0.45);
    assert.equal(result.finalResult.totalCost, 45.0);

    // 1. Confirm the transcript file was created in transcripts folder
    assert.ok(fs.existsSync(tempTranscriptsDir), 'Transcripts directory was created');
    const createdFiles = fs.readdirSync(tempTranscriptsDir);
    assert.equal(createdFiles.length, 1, 'Exactly one transcript file was saved');
    assert.match(createdFiles[0], /^widget-x-negotiation-.*\.md$/);

    const fileContent = fs.readFileSync(path.join(tempTranscriptsDir, createdFiles[0]), 'utf8');

    // Confirm transcript contents
    assert.match(fileContent, /- \*\*Start Time\*\*: \d{4}-\d{2}-\d{2}T/);
    assert.match(fileContent, /- \*\*End Time\*\*: \d{4}-\d{2}-\d{2}T/);
    assert.match(fileContent, /### Round 1/);
    assert.match(fileContent, /- \*\*Buyer Offer\*\*: \$0\.40\/unit x 100 units \(\$40\.00 total\)/);
    assert.match(fileContent, /- \*\*Vendor Counter\*\*: \$0\.60\/unit x 100 units \(\$60\.00 total\)/);
    assert.match(fileContent, /### Round 2/);
    assert.match(fileContent, /- \*\*Buyer Offer\*\*: \$0\.50\/unit x 100 units \(\$50\.00 total\)/);
    assert.match(fileContent, /- \*\*Vendor Counter\*\*: \$0\.525\/unit x 100 units \(\$52\.50 total\)/);
    assert.match(fileContent, /### Round 3/);
    assert.match(fileContent, /- \*\*Buyer Offer\*\*: \$0\.50\/unit x 100 units \(\$50\.00 total\)/);
    assert.match(fileContent, /- \*\*Vendor ACCEPT\*\*: \$0\.45\/unit x 100 units \(\$45\.00 total\)/);
    assert.match(fileContent, /## Final Result: DEAL ACCEPTED/);
    assert.match(fileContent, /- \*\*Agreed Price Per Unit\*\*: \$0\.45/);
    assert.match(fileContent, /- \*\*Total Price\*\*: \$45\.00/);
    assert.match(fileContent, /- \*\*Wallet Status\*\*: ACTIVE/);
    assert.match(fileContent, /- \*\*Wallet Balance\*\*: \$250\.00/);
    assert.match(fileContent, /- \*\*Portfolio\*\*: \{"USDC":250,"SOL":1.5\}/);

    // 2. Confirm self-email was sent to rewardcourt@mermail.app
    const selfEmail = sentEmails.find(
      (m) => m.body.to === 'rewardcourt@mermail.app' && m.body.from === 'rewardcourt@mermail.app'
    );
    assert.ok(selfEmail, 'Self-email transcript was sent');
    assert.equal(selfEmail.body.subject, 'Negotiation Transcript: Widget X [DEAL ACCEPTED]');
    assert.equal(selfEmail.body.text, fileContent);
  } finally {
    if (fs.existsSync(tempTranscriptsDir)) {
      fs.rmSync(tempTranscriptsDir, { recursive: true, force: true });
    }
  }
});

test('Buyer Agent: runBuyerAgent creates transcript file on WALK_AWAY outcome', async () => {
  const tempTranscriptsDir = path.join(__dirname, `test-transcripts-walk-${Date.now()}`);
  if (fs.existsSync(tempTranscriptsDir)) {
    fs.rmSync(tempTranscriptsDir, { recursive: true, force: true });
  }

  const vendorReplies = [
    {
      id: 'vendor-walk-1',
      body: 'DECISION: WALK_AWAY\nROUND: 1\n\nWe cannot negotiate at this time.'
    }
  ];

  let pollCount = 0;
  const sentEmails = [];

  const mockCallMcp = async (toolName, args) => {
    if (toolName === 'list_emails') {
      if (pollCount === 0) return { emails: [] };
      const reply = vendorReplies[pollCount - 1];
      return reply ? { emails: [{ id: reply.id, sender: 'vendor.negotiator11@gmail.com', subject: 'Re: Widget X Negotiation' }] } : { emails: [] };
    }
    if (toolName === 'get_email') {
      return vendorReplies.find((e) => e.id === args.emailId) || { id: args.emailId, body: '' };
    }
    if (toolName === 'send_email') {
      sentEmails.push(args);
      if (args.body.to === 'vendor.negotiator11@gmail.com') {
        pollCount++;
      }
      return { id: `mock-msg-${sentEmails.length}` };
    }
    throw new Error(`Unexpected tool call: ${toolName}`);
  };

  try {
    const result = await runBuyerAgent({
      callMcp: mockCallMcp,
      transcriptsDir: tempTranscriptsDir,
      pollIntervalMs: 0,
      jitterMaxMs: 0
    });

    assert.equal(result.finalResult.decision, 'WALK_AWAY');
    const createdFiles = fs.readdirSync(tempTranscriptsDir);
    assert.equal(createdFiles.length, 1);
    const content = fs.readFileSync(path.join(tempTranscriptsDir, createdFiles[0]), 'utf8');
    assert.match(content, /## Final Result: WALK_AWAY/);
    assert.match(content, /- \*\*Vendor WALK_AWAY\*\*: WALK_AWAY/);

    const selfEmail = sentEmails.find(
      (m) => m.body.to === 'rewardcourt@mermail.app' && m.body.from === 'rewardcourt@mermail.app'
    );
    assert.ok(selfEmail);
    assert.equal(selfEmail.body.subject, 'Negotiation Transcript: Widget X [WALK_AWAY]');
  } finally {
    if (fs.existsSync(tempTranscriptsDir)) {
      fs.rmSync(tempTranscriptsDir, { recursive: true, force: true });
    }
  }
});

test('Instruction Parsing: parseInstruction extracts vendor email, product name, units, and budget cap from test instruction', () => {
  const testInstruction = "Negotiate with vendor.negotiator11@gmail.com for 100 units of Widget X, budget cap $50";
  const result = parseInstruction(testInstruction);

  assert.equal(result.vendorEmail, 'vendor.negotiator11@gmail.com');
  assert.equal(result.productName, 'Widget X');
  assert.equal(result.units, 100);
  assert.equal(result.budgetCap, 50.0);

  assert.equal(result.fields.vendorEmail.parsed, true);
  assert.equal(result.fields.productName.parsed, true);
  assert.equal(result.fields.units.parsed, true);
  assert.equal(result.fields.budgetCap.parsed, true);
});

test('Instruction Parsing: resolveNegotiationParameters falls back to defaults when fields are missing and reports status', () => {
  // Partial instruction: missing vendor email and budget cap
  const partialInstruction = "Negotiate for 40 units of Turbo Sprocket";
  const resolved = resolveNegotiationParameters(partialInstruction);

  assert.equal(resolved.units, 40);
  assert.equal(resolved.status.units.source, 'parsed');

  assert.equal(resolved.productName, 'Turbo Sprocket');
  assert.equal(resolved.status.productName.source, 'parsed');

  assert.equal(resolved.vendorEmail, DEFAULT_VENDOR_EMAIL);
  assert.equal(resolved.status.vendorEmail.source, 'defaulted');

  assert.equal(resolved.budgetCap, DEFAULT_BUDGET_CAP);
  assert.equal(resolved.status.budgetCap.source, 'defaulted');

  // Empty instruction: all defaulted
  const emptyResolved = resolveNegotiationParameters('');
  assert.equal(emptyResolved.vendorEmail, DEFAULT_VENDOR_EMAIL);
  assert.equal(emptyResolved.status.vendorEmail.source, 'defaulted');
  assert.equal(emptyResolved.productName, DEFAULT_PRODUCT_NAME);
  assert.equal(emptyResolved.status.productName.source, 'defaulted');
  assert.equal(emptyResolved.units, DEFAULT_UNITS);
  assert.equal(emptyResolved.status.units.source, 'defaulted');
  assert.equal(emptyResolved.budgetCap, DEFAULT_BUDGET_CAP);
  assert.equal(emptyResolved.status.budgetCap.source, 'defaulted');
});

test('Instruction Parsing: runBuyerAgent accepts natural language instruction and conducts negotiation', async () => {
  const tempTranscriptsDir = path.join(__dirname, `test-transcripts-instr-${Date.now()}`);
  if (fs.existsSync(tempTranscriptsDir)) {
    fs.rmSync(tempTranscriptsDir, { recursive: true, force: true });
  }

  const customInstruction = "Negotiate with vendor.negotiator11@gmail.com for 50 units of Super Gadget, budget cap $35";
  const sentEmails = [];

  const mockCallMcp = async (toolName, args) => {
    if (toolName === 'list_emails') {
      return { emails: [] };
    }
    if (toolName === 'send_email') {
      sentEmails.push(args);
      return { id: `mock-msg-${sentEmails.length}` };
    }
    throw new Error(`Unexpected tool call: ${toolName}`);
  };

  try {
    // Only check opening offer generation and parameter passing
    const parsed = resolveNegotiationParameters(customInstruction);
    assert.equal(parsed.vendorEmail, 'vendor.negotiator11@gmail.com');
    assert.equal(parsed.productName, 'Super Gadget');
    assert.equal(parsed.units, 50);
    assert.equal(parsed.budgetCap, 35.0);
    assert.equal(parsed.status.vendorEmail.source, 'parsed');
    assert.equal(parsed.status.productName.source, 'parsed');
    assert.equal(parsed.status.units.source, 'parsed');
    assert.equal(parsed.status.budgetCap.source, 'parsed');
  } finally {
    if (fs.existsSync(tempTranscriptsDir)) {
      fs.rmSync(tempTranscriptsDir, { recursive: true, force: true });
    }
  }
});

test('CLI Arguments: getCommandLineInstruction handles single quoted argument, unquoted arguments, and flags', () => {
  // 1. Single quoted argument
  const singleArg = ['node', 'buyer-agent.js', 'Negotiate with test@vendor.com for 50 units of Widget Z, budget cap $25'];
  assert.equal(
    getCommandLineInstruction(singleArg),
    'Negotiate with test@vendor.com for 50 units of Widget Z, budget cap $25'
  );

  // 2. Unquoted multiple arguments
  const multiArgs = ['node', 'buyer-agent.js', 'Negotiate', 'with', 'test@vendor.com', 'for', '50', 'units', 'of', 'Widget', 'Z,', 'budget', 'cap', '$25'];
  assert.equal(
    getCommandLineInstruction(multiArgs),
    'Negotiate with test@vendor.com for 50 units of Widget Z, budget cap $25'
  );

  // 3. Flag argument --instruction
  const flagArgs = ['node', 'buyer-agent.js', '--instruction', 'Negotiate with test@vendor.com for 20 units'];
  assert.equal(
    getCommandLineInstruction(flagArgs),
    'Negotiate with test@vendor.com for 20 units'
  );

  // 4. Flag argument --instruction=...
  const equalsFlagArgs = ['node', 'buyer-agent.js', '--instruction=Negotiate with test@vendor.com for 20 units'];
  assert.equal(
    getCommandLineInstruction(equalsFlagArgs),
    'Negotiate with test@vendor.com for 20 units'
  );

  // 5. Empty arguments returns null
  const emptyArgs = ['node', 'buyer-agent.js'];
  assert.equal(getCommandLineInstruction(emptyArgs), null);
});

