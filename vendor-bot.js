require('dotenv').config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

// Negotiation Policy Parameters
const ANCHOR = 0.60;
const FLOOR = 0.45;
const MAX_ROUNDS = 3;
const LADDER = [0.60, 0.525, 0.45];
const POLL_INTERVAL_MS = 4 * 1000; // 4 seconds

/**
 * Format numbers for dollar display (e.g. 0.6 -> "0.60", 0.525 -> "0.525")
 */
function formatPrice(price) {
  if (price === null || price === undefined) return '';
  const str = price.toString();
  const parts = str.split('.');
  if (!parts[1]) return `${str}.00`;
  if (parts[1].length === 1) return `${str}0`;
  return str;
}

/**
 * Clean floating point arithmetic
 */
function cleanNumber(num) {
  return Math.round(num * 1000) / 1000;
}

/**
 * Helper to extract offer and round from text
 */
function extractOfferFromText(text) {
  if (!text || typeof text !== 'string') return null;

  // Split out earlier quotes if present (e.g., lines starting with ">" or "On ... wrote:")
  const lines = text.split(/\r?\n/);
  const unquotedLines = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*On\s+.*wrote:\s*$/i.test(line)) break;
    if (/^\s*-+\s*Original Message\s*-+/i.test(line)) break;
    unquotedLines.push(line);
  }
  const cleanBody = unquotedLines.join('\n');

  // Match OFFER: $0.XX/unit x 100 units
  const offerRegex = /OFFER:\s*\$([0-9]+(?:\.[0-9]+)?)\/unit(?:\s*x\s*([0-9]+)\s*units?)?/i;
  // Match ROUND: N
  const roundRegex = /ROUND:\s*([0-9]+)/i;

  const offerMatch = cleanBody.match(offerRegex) || text.match(offerRegex);
  const roundMatch = cleanBody.match(roundRegex) || text.match(roundRegex);

  if (!offerMatch || !roundMatch) {
    return null;
  }

  const offerPrice = parseFloat(offerMatch[1]);
  const quantity = offerMatch[2] ? parseInt(offerMatch[2], 10) : 100;
  const round = parseInt(roundMatch[1], 10);

  return {
    offerPrice,
    quantity,
    round
  };
}

/**
 * Parse OFFER and ROUND from email body.
 * Checks plain text first, falls back to stripped HTML.
 */
function parseOffer(bodyText, htmlText = '') {
  let result = extractOfferFromText(bodyText);
  if (!result && htmlText) {
    const strippedHtml = htmlText
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ');
    result = extractOfferFromText(strippedHtml);
  }
  return result;
}

/**
 * Apply the negotiation policy:
 * - ANCHOR = 0.60
 * - FLOOR = 0.45
 * - MAX_ROUNDS = 3
 * - LADDER = [0.60, 0.525, 0.45] (indexed by round, using the last value if round exceeds the ladder length)
 * - If offerPrice >= LADDER[round] -> ACCEPT at offerPrice
 * - Else if round >= MAX_ROUNDS:
 *     - if offerPrice >= FLOOR -> ACCEPT at FLOOR (mark as final)
 *     - else -> WALK_AWAY (no deal)
 * - Else -> COUNTER at LADDER[round], and reply with ROUND incremented by 1
 */
function evaluateNegotiation(offerPrice, round, quantity = 100) {
  // If round >= MAX_ROUNDS:
  if (round >= MAX_ROUNDS) {
    if (cleanNumber(offerPrice) >= cleanNumber(FLOOR)) {
      const finalPrice = cleanNumber(offerPrice) >= cleanNumber(FLOOR) ? FLOOR : offerPrice;
      return {
        decision: 'ACCEPT',
        price: finalPrice,
        round: round,
        quantity: quantity,
        isFinal: true,
        message: `Maximum rounds reached. We accept at our floor price of $${formatPrice(FLOOR)}/unit for ${quantity} units (final offer).`
      };
    } else {
      return {
        decision: 'WALK_AWAY',
        price: null,
        round: round,
        quantity: quantity,
        isFinal: true,
        message: `Maximum rounds reached and your offer of $${formatPrice(offerPrice)}/unit is below our reserve floor of $${formatPrice(FLOOR)}/unit. We must respectfully walk away.`
      };
    }
  }

  const ladderIndex = Math.max(0, round - 1);
  const ladderPrice = ladderIndex < LADDER.length ? LADDER[ladderIndex] : LADDER[LADDER.length - 1];

  // If offerPrice >= LADDER[round - 1] -> ACCEPT at offerPrice
  if (cleanNumber(offerPrice) >= cleanNumber(ladderPrice)) {
    return {
      decision: 'ACCEPT',
      price: offerPrice,
      round: round,
      quantity: quantity,
      isFinal: false,
      message: `We are pleased to accept your offer of $${formatPrice(offerPrice)}/unit for ${quantity} units.`
    };
  }

  // Else -> COUNTER at LADDER[round - 1], and reply with ROUND incremented by 1
  const counterPrice = ladderPrice;
  const nextRound = round + 1;
  return {
    decision: 'COUNTER',
    price: counterPrice,
    round: nextRound,
    quantity: quantity,
    isFinal: false,
    message: `Thank you for your offer. We cannot accept $${formatPrice(offerPrice)}/unit, but we counter with $${formatPrice(counterPrice)}/unit for ${quantity} units.`
  };
}

/**
 * Build email response body
 */
function buildReplyBody(negotiationResult) {
  const { decision, price, round, quantity, message } = negotiationResult;

  if (decision === 'COUNTER') {
    return `DECISION: COUNTER\nOFFER: $${formatPrice(price)}/unit x ${quantity} units\nROUND: ${round}\n\n${message}`;
  }

  if (decision === 'ACCEPT') {
    return `DECISION: ACCEPT\nOFFER: $${formatPrice(price)}/unit x ${quantity} units\nROUND: ${round}\n\n${message}`;
  }

  // WALK_AWAY
  return `DECISION: WALK_AWAY\nROUND: ${round}\n\n${message}`;
}

/**
 * Create and configure SMTP Transporter
 */
function createSmtpTransporter(user, pass) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: user,
      pass: pass.replace(/\s+/g, '')
    }
  });
}

/**
 * Create and configure IMAP Client
 */
function createImapClient(user, pass) {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: user,
      pass: pass.replace(/\s+/g, '')
    },
    socketTimeout: 30000, // 30-second socket timeout prevents 5-minute hanging TCP sockets
    logger: false
  });
}

/**
 * Run an async promise with a timeout guard
 */
function runWithTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(timeoutMessage);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Process an incoming email against negotiation state.
 * Returns { action: 'REPLY' | 'SKIP_DUPLICATE_ROUND' | 'SKIP_NOT_OFFER' | 'SKIP', ... }
 */
function handleIncomingOffer(emailData, state) {
  const { uid, messageId, sender, bodyText, htmlText } = emailData;

  // Check if UID or Message-ID already processed
  if (state.processedUids.has(uid) || (messageId && state.processedMessageIds.has(messageId))) {
    return {
      action: 'SKIP',
      reason: `Email already processed (UID ${uid}, Message-ID <${messageId}>)`
    };
  }

  const offerData = parseOffer(bodyText, htmlText);
  if (!offerData) {
    state.processedUids.add(uid);
    if (messageId) state.processedMessageIds.add(messageId);
    return {
      action: 'SKIP_NOT_OFFER',
      reason: `Message UID ${uid} does not contain valid OFFER / ROUND lines`
    };
  }

  // Check if this sender already had this round or a later round processed
  const negotiation = state.activeNegotiations.get(sender);
  if (negotiation) {
    // If the negotiation previously finished (final) and buyer starts a brand new round 1, allow reset
    const isNewNegotiation = negotiation.isFinal && offerData.round === 1;
    if (!isNewNegotiation && offerData.round <= negotiation.lastProcessedRound) {
      state.processedUids.add(uid);
      if (messageId) state.processedMessageIds.add(messageId);
      return {
        action: 'SKIP_DUPLICATE_ROUND',
        offerData,
        lastProcessedRound: negotiation.lastProcessedRound,
        reason: `Duplicate or stale offer for Round ${offerData.round} from ${sender} (already responded to Round ${negotiation.lastProcessedRound})`
      };
    }
  }

  // Apply negotiation policy
  const result = evaluateNegotiation(offerData.offerPrice, offerData.round, offerData.quantity);

  // Update tracking state
  state.processedUids.add(uid);
  if (messageId) state.processedMessageIds.add(messageId);
  state.activeNegotiations.set(sender, {
    lastProcessedRound: offerData.round,
    lastDecision: result.decision,
    lastPrice: result.price,
    lastMessageId: messageId,
    isFinal: result.isFinal
  });

  return {
    action: 'REPLY',
    offerData,
    result
  };
}

/**
 * Main polling logic to check inbox and reply to new emails
 */
async function processInbox(imapClient, smtpTransporter, userEmail, state) {
  let lock;
  try {
    // 10-second acquire timeout prevents indefinite lock starvation if connection stalls
    lock = await imapClient.getMailboxLock('INBOX', { acquireTimeout: 10000 });

    // Explicit NOOP command forces Gmail IMAP server to push untagged EXISTS/EXPUNGE updates
    try {
      await imapClient.noop();
    } catch (noopErr) {
      console.warn('[Vendor Bot] NOOP mailbox sync notice:', noopErr.message);
    }

    const messages = [];
    const seenUids = new Set();

    // 1. Primary query: unseen messages
    for await (const message of imapClient.fetch({ seen: false }, { envelope: true, source: true, uid: true })) {
      if (!state.processedUids.has(message.uid) && !seenUids.has(message.uid)) {
        seenUids.add(message.uid);
        messages.push(message);
      }
    }

    // 2. Safeguard for Gmail Conversation View:
    // If Gmail automatically marked a threaded reply as \Seen, also check recent messages (last 10)
    // to catch any unprocessed offers.
    if (imapClient.mailbox && imapClient.mailbox.exists > 0) {
      const startSeq = Math.max(1, imapClient.mailbox.exists - 9);
      const recentRange = `${startSeq}:*`;
      for await (const message of imapClient.fetch(recentRange, { envelope: true, source: true, uid: true })) {
        if (!state.processedUids.has(message.uid) && !seenUids.has(message.uid)) {
          seenUids.add(message.uid);
          messages.push(message);
        }
      }
    }

    if (messages.length === 0) {
      return 0;
    }

    console.log(`[Vendor Bot] Found ${messages.length} unread/unprocessed email(s) in INBOX.`);

    for (const message of messages) {
      try {
        // Mark incoming email as seen on IMAP
        await imapClient.messageFlagsAdd(message.uid.toString(), ['\\Seen'], { uid: true });

        const parsed = await simpleParser(message.source);
        const sender = parsed.from?.value?.[0]?.address || parsed.from?.text;
        const subject = parsed.subject || 'Negotiation';
        const bodyText = parsed.text || parsed.html || '';
        const messageId = parsed.messageId;

        console.log(`[Vendor Bot] Processing message UID: ${message.uid}, Message-ID: <${messageId}> from: "${sender}", Subject: "${subject}"`);

        const emailData = {
          uid: message.uid,
          messageId: messageId,
          sender: sender,
          subject: subject,
          bodyText: bodyText,
          htmlText: parsed.html || ''
        };

        const decisionResult = handleIncomingOffer(emailData, state);

        if (decisionResult.action === 'SKIP' || decisionResult.action === 'SKIP_NOT_OFFER') {
          console.log(`[Vendor Bot] ${decisionResult.reason}. Skipping.`);
          continue;
        }

        if (decisionResult.action === 'SKIP_DUPLICATE_ROUND') {
          console.log(`[Vendor Bot] Duplicate offer detected: ${decisionResult.reason}. Skipping duplicate reply.`);
          continue;
        }

        const { offerData, result } = decisionResult;
        console.log(`[Vendor Bot] Parsed incoming offer: $${offerData.offerPrice}/unit x ${offerData.quantity} units, Round: ${offerData.round}`);
        console.log(`[Vendor Bot] Negotiation result: ${result.decision}`, result);

        const replyBody = buildReplyBody(result);
        const replySubject = /^Re:/i.test(subject) ? subject : `Re: ${subject}`;

        const mailOptions = {
          from: userEmail,
          to: sender,
          subject: replySubject,
          text: replyBody,
          inReplyTo: messageId,
          references: parsed.references ? [].concat(parsed.references, messageId) : messageId
        };

        const sendInfo = await smtpTransporter.sendMail(mailOptions);
        console.log(`[Vendor Bot] Sent reply to ${sender} for incoming Message-ID <${messageId}> (Outgoing Message-ID: <${sendInfo.messageId}>) with decision: ${result.decision}, Round: ${result.round}, Price: $${formatPrice(result.price)}/unit`);
      } catch (msgErr) {
        console.error(`[Vendor Bot] Error processing message UID ${message.uid}:`, msgErr);
      }
    }
    return messages.length;
  } catch (err) {
    console.error('[Vendor Bot] [IMAP ERROR] Error checking inbox:', err.message || err);
    throw err;
  } finally {
    if (lock) {
      try {
        lock.release();
      } catch (relErr) {
        console.warn('[Vendor Bot] Error releasing mailbox lock:', relErr.message || relErr);
      }
    }
  }
}

/**
 * Start the vendor bot loop
 */
async function startVendorBot() {
  const user = process.env.VENDOR_GMAIL_ADDRESS;
  const pass = process.env.VENDOR_GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    console.error('[Vendor Bot] Error: VENDOR_GMAIL_ADDRESS or VENDOR_GMAIL_APP_PASSWORD is missing in .env');
    process.exit(1);
  }

  console.log(`[Vendor Bot] Starting automated negotiation bot for ${user}...`);
  console.log(`[Vendor Bot] Policy: ANCHOR=${ANCHOR}, FLOOR=${FLOOR}, MAX_ROUNDS=${MAX_ROUNDS}, LADDER=[${LADDER.join(', ')}]`);

  const smtpTransporter = createSmtpTransporter(user, pass);
  let imapClient = null;

  const state = {
    processedUids: new Set(),
    processedMessageIds: new Set(),
    activeNegotiations: new Map() // sender -> { lastProcessedRound, lastDecision, lastPrice, lastMessageId, isFinal }
  };

  let isRunning = true;
  let isPolling = false;
  let consecutiveSkips = 0;
  let pollCycleCount = 0;
  const POLL_TIMEOUT_MS = 25000; // 25s per-poll watchdog timeout to prevent indefinite hangs

  async function connectImap(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (imapClient && imapClient.usable) {
          return;
        }
        if (imapClient) {
          try {
            imapClient.close();
          } catch (e) {
            // ignore error on stale client
          }
          imapClient = null;
        }
        console.log(`[Vendor Bot] Connecting to IMAP server (attempt ${attempt}/${maxRetries})...`);
        const client = createImapClient(user, pass);

        client.on('error', (err) => {
          console.error('[Vendor Bot] [IMAP ERROR EVENT]:', err.message || err);
          client.usable = false;
        });

        client.on('close', () => {
          console.warn('[Vendor Bot] [IMAP CLOSED EVENT]: Connection to IMAP server closed.');
          client.usable = false;
        });

        await runWithTimeout(client.connect(), 15000, 'IMAP connection handshake timed out after 15s');
        imapClient = client;
        console.log('[Vendor Bot] Connected to IMAP server successfully.');
        return;
      } catch (err) {
        console.error(`[Vendor Bot] Failed to connect to IMAP (attempt ${attempt}/${maxRetries}):`, err.message || err);
        if (attempt === maxRetries) {
          throw err;
        }
        await new Promise((res) => setTimeout(res, 2000 * attempt));
      }
    }
  }

  await connectImap();

  // Initial inbox check
  try {
    await runWithTimeout(
      processInbox(imapClient, smtpTransporter, user, state),
      POLL_TIMEOUT_MS,
      'Initial inbox check timed out'
    );
  } catch (initErr) {
    console.error('[Vendor Bot] Warning on initial inbox check:', initErr.message || initErr);
  }

  // Poll loop
  const intervalId = setInterval(async () => {
    if (!isRunning) return;

    if (isPolling) {
      consecutiveSkips++;
      console.warn(`[Vendor Bot] [POLL WARNING] Previous poll cycle still executing (skip #${consecutiveSkips}). Elapsed: ~${consecutiveSkips * (POLL_INTERVAL_MS / 1000)}s.`);
      if (consecutiveSkips >= 3) {
        console.error(`[Vendor Bot] [STALL RECOVERY] Polling has stalled for ${consecutiveSkips * (POLL_INTERVAL_MS / 1000)}s! Forcing reset of IMAP connection and lock.`);
        if (imapClient) {
          try { imapClient.close(); } catch (_) { }
          imapClient = null;
        }
        isPolling = false;
        consecutiveSkips = 0;
      }
      return;
    }

    consecutiveSkips = 0;
    isPolling = true;
    pollCycleCount++;

    try {
      if (!imapClient || !imapClient.usable) {
        console.log('[Vendor Bot] [RECONNECT] IMAP connection missing or unusable. Reconnecting...');
        await connectImap();
      }

      const count = await runWithTimeout(
        processInbox(imapClient, smtpTransporter, user, state),
        POLL_TIMEOUT_MS,
        `Inbox check timed out after ${POLL_TIMEOUT_MS / 1000}s`
      );

      // Periodic heartbeat every 8 poll cycles (~32s)
      if (pollCycleCount % 8 === 0) {
        console.log(`[Vendor Bot] [Heartbeat] Polling active (cycle #${pollCycleCount}, connection healthy, processed ${count || 0} offers).`);
      }
    } catch (pollErr) {
      console.error('[Vendor Bot] [POLL ERROR] Error during poll cycle:', pollErr.message || pollErr);
      // Invalidate IMAP client on network / timeout errors so next cycle establishes a fresh session
      if (pollErr.code === 'ETIMEDOUT' || pollErr.code === 'NoConnection' || pollErr.code === 'LockTimeout' || !imapClient?.usable) {
        console.warn('[Vendor Bot] [RECOVERY] Inactivating stale IMAP client for next cycle reconnection.');
        if (imapClient) {
          try { imapClient.close(); } catch (_) { }
          imapClient = null;
        }
      }
    } finally {
      isPolling = false;
    }
  }, POLL_INTERVAL_MS);

  // Handle graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[Vendor Bot] Received ${signal}. Shutting down cleanly...`);
    isRunning = false;
    clearInterval(intervalId);
    try {
      if (imapClient) {
        await imapClient.logout();
      }
    } catch (e) {
      // ignore
    }
    console.log('[Vendor Bot] Bot stopped.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = {
  ANCHOR,
  FLOOR,
  MAX_ROUNDS,
  LADDER,
  POLL_INTERVAL_MS,
  formatPrice,
  parseOffer,
  evaluateNegotiation,
  buildReplyBody,
  handleIncomingOffer,
  createSmtpTransporter,
  createImapClient,
  runWithTimeout,
  processInbox,
  startVendorBot
};

if (require.main === module) {
  startVendorBot().catch((err) => {
    console.error('[Vendor Bot] Fatal error starting bot:', err);
    process.exit(1);
  });
}
