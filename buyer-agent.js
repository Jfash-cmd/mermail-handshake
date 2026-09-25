require('dotenv').config();
const fs = require('fs');
const path = require('path');

// ============================================================================
// BUYER AGENT NEGOTIATION CONSTANTS & DEFAULTS
// ============================================================================
const DEFAULT_BUDGET_CAP = 50.0; // Total budget in dollars
const DEFAULT_UNITS = 100; // Number of units requested
const DEFAULT_VENDOR_EMAIL = 'vendor.negotiator11@gmail.com';
const DEFAULT_PRODUCT_NAME = 'Widget X';
const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_STARTING_OFFER = 0.40; // Initial opening offer price per unit ($0.40 * 100 = $40.00)

const BUYER_MAILBOX_ID = '4a97705e-77a1-4dd2-8644-18e86360dc09'; // Mermail public_id for rewardcourt@mermail.app
const BUYER_EMAIL = 'rewardcourt@mermail.app';
const POLL_INTERVAL_MS = 8000; // 8 seconds poll interval (under Mermail 15 req/min limit)

const DEFAULT_INSTRUCTION = "Negotiate with vendor.negotiator11@gmail.com for 100 units of Widget X, budget cap $50";

/**
 * Extract natural language negotiation instruction from command-line arguments or environment variables.
 * Supports:
 * - Direct single argument: node buyer-agent.js "Negotiate with vendor..."
 * - Multiple unquoted arguments: node buyer-agent.js Negotiate with vendor...
 * - Flag argument: node buyer-agent.js --instruction "Negotiate with vendor..." or -i "..."
 * - Environment variable: process.env.BUYER_INSTRUCTION
 */
function getCommandLineInstruction(argv = process.argv) {
  if (process.env.BUYER_INSTRUCTION && process.env.BUYER_INSTRUCTION.trim().length > 0) {
    return process.env.BUYER_INSTRUCTION.trim();
  }
  const args = argv.slice(2);
  if (!args || args.length === 0) {
    return null;
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--instruction=')) {
      return args[i].substring('--instruction='.length).trim();
    }
    if ((args[i] === '--instruction' || args[i] === '-i') && args[i + 1]) {
      return args[i + 1].trim();
    }
  }
  if (args.length === 1 && args[0].trim().length > 0) {
    return args[0].trim();
  }
  const nonFlagArgs = args.filter((a) => !a.startsWith('-'));
  if (nonFlagArgs.length > 0) {
    return nonFlagArgs.join(' ').trim();
  }
  return args.join(' ').trim();
}

// Natural language instruction string (defaults to test instruction, can be overridden via CLI arg or env var)
const INSTRUCTION = getCommandLineInstruction() || DEFAULT_INSTRUCTION;

/**
 * Simple regex/string parsing for natural-language negotiation instructions.
 * Extracts: vendor email, product name, units, and budget cap without an LLM call.
 */
function parseInstruction(instruction) {
  if (!instruction || typeof instruction !== 'string') {
    return {
      vendorEmail: null,
      productName: null,
      units: null,
      budgetCap: null,
      fields: {
        vendorEmail: { value: null, parsed: false },
        productName: { value: null, parsed: false },
        units: { value: null, parsed: false },
        budgetCap: { value: null, parsed: false }
      }
    };
  }

  // 1. Vendor Email
  const emailRegex = /(?:with|to)\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
  const fallbackEmailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;
  const emailMatch = instruction.match(emailRegex) || instruction.match(fallbackEmailRegex);
  const parsedEmail = emailMatch ? emailMatch[1].trim() : null;

  // 2. Units
  const unitsRegex = /(\d+)\s*(?:units?|pieces?|pcs?|items?)\b/i;
  const unitsMatch = instruction.match(unitsRegex);
  const parsedUnits = unitsMatch ? parseInt(unitsMatch[1], 10) : null;

  // 3. Budget Cap
  const budgetRegex = /(?:budget\s*(?:cap)?|cap)\s*(?:of|is|:)?\s*\$?([0-9]+(?:\.[0-9]+)?)/i;
  const budgetMatch = instruction.match(budgetRegex);
  const parsedBudgetCap = budgetMatch ? parseFloat(budgetMatch[1]) : null;

  // 4. Product Name
  let parsedProduct = null;
  const productWithUnitsRegex = /(?:units?|pieces?|pcs?|items?)\s+of\s+([^,;]+?)(?:,\s*budget|\s+budget|\s+cap|$)/i;
  const productMatch1 = instruction.match(productWithUnitsRegex);
  if (productMatch1) {
    parsedProduct = productMatch1[1].trim();
  } else {
    const productForRegex = /for\s+([^,;]+?)(?:,\s*budget|\s+budget|\s+cap|$)/i;
    const productMatch2 = instruction.match(productForRegex);
    if (productMatch2) {
      parsedProduct = productMatch2[1].replace(/^\d+\s*(?:units?|pieces?|pcs?|items?)?\s*(?:of\s*)?/i, '').trim();
    }
  }

  return {
    vendorEmail: parsedEmail,
    productName: parsedProduct || null,
    units: parsedUnits,
    budgetCap: parsedBudgetCap,
    fields: {
      vendorEmail: { value: parsedEmail, parsed: Boolean(parsedEmail) },
      productName: { value: parsedProduct, parsed: Boolean(parsedProduct) },
      units: { value: parsedUnits, parsed: Boolean(parsedUnits) },
      budgetCap: { value: parsedBudgetCap, parsed: parsedBudgetCap !== null && !isNaN(parsedBudgetCap) }
    }
  };
}

/**
 * Resolve negotiation parameters from instruction with fallback to defaults.
 * Also tracks whether each field was parsed or defaulted.
 */
function resolveNegotiationParameters(instruction = INSTRUCTION, overrides = {}) {
  const parsed = parseInstruction(instruction);

  const vendorEmail = overrides.vendorEmail || parsed.vendorEmail || DEFAULT_VENDOR_EMAIL;
  const productName = overrides.productName || parsed.productName || DEFAULT_PRODUCT_NAME;
  const units = overrides.units || parsed.units || DEFAULT_UNITS;
  const budgetCap = overrides.budgetCap !== undefined ? overrides.budgetCap : (parsed.budgetCap !== null ? parsed.budgetCap : DEFAULT_BUDGET_CAP);

  const status = {
    vendorEmail: { value: vendorEmail, source: (overrides.vendorEmail || parsed.fields.vendorEmail.parsed) ? 'parsed' : 'defaulted' },
    productName: { value: productName, source: (overrides.productName || parsed.fields.productName.parsed) ? 'parsed' : 'defaulted' },
    units: { value: units, source: (overrides.units || parsed.fields.units.parsed) ? 'parsed' : 'defaulted' },
    budgetCap: { value: budgetCap, source: (overrides.budgetCap !== undefined || parsed.fields.budgetCap.parsed) ? 'parsed' : 'defaulted' }
  };

  return {
    vendorEmail,
    productName,
    units,
    budgetCap,
    status
  };
}

/**
 * Log which negotiation fields were parsed vs defaulted
 */
function logNegotiationParameters(params) {
  log('Negotiation Parameters:');
  log(`- Vendor Email: ${params.vendorEmail} [${params.status.vendorEmail.source}]`);
  log(`- Product Name: ${params.productName} [${params.status.productName.source}]`);
  log(`- Units:        ${params.units} [${params.status.units.source}]`);
  log(`- Budget Cap:   $${formatPrice(params.budgetCap)} [${params.status.budgetCap.source}]`);
}

// Parse instruction at top of script
const INITIAL_PARAMS = resolveNegotiationParameters(INSTRUCTION);
const BUDGET_CAP = INITIAL_PARAMS.budgetCap;
const UNITS = INITIAL_PARAMS.units;
const VENDOR_EMAIL = INITIAL_PARAMS.vendorEmail;
const PRODUCT_NAME = INITIAL_PARAMS.productName;
const MAX_ROUNDS = DEFAULT_MAX_ROUNDS;
const STARTING_OFFER = DEFAULT_STARTING_OFFER;

// ============================================================================
// HELPER FUNCTIONS & FORMATTERS
// ============================================================================

/**
 * Log message with ISO timestamp
 */
function log(message, ...args) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [Buyer Agent] ${message}`, ...args);
}

/**
 * Format numbers for dollar display (e.g. 0.6 -> "0.60", 0.525 -> "0.525")
 */
function formatPrice(price) {
  if (price === null || price === undefined) return '0.00';
  const str = price.toString();
  const parts = str.split('.');
  if (!parts[1]) return `${str}.00`;
  if (parts[1].length === 1) return `${str}0`;
  return str;
}

/**
 * Clean floating point arithmetic to 3 decimal places
 */
function cleanNumber(num) {
  return Math.round(num * 1000) / 1000;
}

/**
 * Sleep helper for delays
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// MERMAIL MCP CLIENT CALLER
// ============================================================================

/**
 * Call a tool on the authenticated Mermail MCP server over HTTP JSON-RPC with automatic retry
 */
async function callMermailMcp(toolName, args, retries = 3) {
  const apiKey = process.env.MERMAIL_API_KEY;
  if (!apiKey) {
    throw new Error('MERMAIL_API_KEY is missing from environment (.env)');
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch('https://console.mermail.app/mcp', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: args
          }
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Mermail MCP call ${toolName} failed (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(`Mermail MCP error in ${toolName}: ${JSON.stringify(data.error)}`);
      }
      if (data.result?.isError) {
        throw new Error(`Mermail MCP tool ${toolName} reported conflict or error: ${JSON.stringify(data.result?.structuredContent || data.result?.content)}`);
      }

      if (data.result?.structuredContent) {
        return data.result.structuredContent;
      }
      if (data.result?.content?.[0]?.text) {
        try {
          return JSON.parse(data.result.content[0].text);
        } catch {
          return data.result.content[0].text;
        }
      }
      return data.result;
    } catch (err) {
      if (attempt === retries) throw err;
      log(`Warning: callMermailMcp(${toolName}) failed on attempt ${attempt}: ${err.message}. Retrying in ${attempt * 2}s...`);
      await sleep(2000 * attempt);
    }
  }
}

// ============================================================================
// MERMAIL-WALLET MCP CLIENT CALLER (READ-ONLY STATUS)
// ============================================================================

/**
 * Retrieve OAuth token for the mermail-wallet MCP server.
 * Checks environment variables first, then falls back to Antigravity's mcp_oauth_tokens.json
 */
function getMermailWalletOAuthToken() {
  if (process.env.MERMAIL_WALLET_OAUTH_TOKEN) return process.env.MERMAIL_WALLET_OAUTH_TOKEN;
  if (process.env.MERMAIL_OAUTH_TOKEN) return process.env.MERMAIL_OAUTH_TOKEN;

  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const tokenPath = path.join(home, '.gemini', 'antigravity-ide', 'mcp_oauth_tokens.json');
    if (fs.existsSync(tokenPath)) {
      const data = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      const entry = data['https://console.mermail.app/mcp'];
      if (entry?.token?.access_token) {
        return entry.token.access_token;
      }
    }
  } catch {
    // Fail silently when reading token file
  }
  return null;
}

/**
 * Call a read-only tool on the mermail-wallet MCP server over HTTP JSON-RPC with OAuth auth.
 * Strictly restricted to read-only status calls: only get_paybox_connection is permitted.
 */
async function callMermailWalletMcp(toolName, args = {}) {
  const ALLOWED_WALLET_TOOLS = ['get_paybox_connection'];
  if (!ALLOWED_WALLET_TOOLS.includes(toolName)) {
    throw new Error(`Security restriction: Tool "${toolName}" is not permitted. Only read-only status tools (${ALLOWED_WALLET_TOOLS.join(', ')}) are allowed.`);
  }

  const token = getMermailWalletOAuthToken();
  if (!token) {
    throw new Error('mermail-wallet OAuth token not found in environment or MCP configuration');
  }

  const response = await fetch('https://console.mermail.app/mcp', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    }),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`mermail-wallet MCP call ${toolName} failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(`mermail-wallet MCP error in ${toolName}: ${JSON.stringify(data.error)}`);
  }
  if (data.result?.isError) {
    throw new Error(`mermail-wallet MCP tool ${toolName} reported error: ${JSON.stringify(data.result?.structuredContent || data.result?.content)}`);
  }

  if (data.result?.structuredContent) {
    return data.result.structuredContent;
  }
  if (data.result?.content?.[0]?.text) {
    try {
      return JSON.parse(data.result.content[0].text);
    } catch {
      return { status: data.result.content[0].text };
    }
  }
  return data.result;
}

/**
 * Safely query get_paybox_connection via mermail-wallet MCP connection.
 * Returns the status object (with status, balance, portfolio, etc.), or null if unavailable.
 * Never throws — catches all errors gracefully.
 */
async function getPayboxConnectionStatus(caller = callMermailWalletMcp) {
  try {
    const callFn = caller || callMermailWalletMcp;
    const result = await callFn('get_paybox_connection', {});
    return result;
  } catch (err) {
    log(`Notice: mermail-wallet get_paybox_connection check failed (${err.message}). Proceeding gracefully without wallet info.`);
    return null;
  }
}

// ============================================================================
// OFFER / ROUND / DECISION PARSER (Reused from vendor-bot)
// ============================================================================

/**
 * Extract OFFER and ROUND from email body text, ignoring quoted reply history
 */
function extractOfferFromText(text) {
  if (!text || typeof text !== 'string') return null;

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
  // Match DECISION: ACCEPT / COUNTER / WALK_AWAY
  const decisionRegex = /DECISION:\s*(ACCEPT|COUNTER|WALK_AWAY)/i;

  const offerMatch = cleanBody.match(offerRegex) || text.match(offerRegex);
  const roundMatch = cleanBody.match(roundRegex) || text.match(roundRegex);
  const decisionMatch = cleanBody.match(decisionRegex) || text.match(decisionRegex);

  if (!offerMatch && !decisionMatch) {
    return null;
  }

  const offerPrice = offerMatch ? parseFloat(offerMatch[1]) : null;
  const quantity = offerMatch && offerMatch[2] ? parseInt(offerMatch[2], 10) : UNITS;
  const round = roundMatch ? parseInt(roundMatch[1], 10) : 1;
  const decision = decisionMatch ? decisionMatch[1].toUpperCase() : (offerMatch ? 'COUNTER' : null);

  return {
    offerPrice,
    quantity,
    round,
    decision
  };
}

/**
 * Parse OFFER, ROUND, and DECISION from email body with HTML fallback
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

// ============================================================================
// BUYER DECISION LOGIC
// ============================================================================

/**
 * Evaluate the vendor's incoming reply against buyer's budget and constraints.
 * 
 * Rules:
 * - If vendor said ACCEPT -> ACCEPT (deal confirmed)
 * - If vendor said WALK_AWAY -> WALK_AWAY (deal failed)
 * - If vendor's offerPrice * UNITS <= BUDGET_CAP -> ACCEPT at vendor's price
 * - If not affordable and round < MAX_ROUNDS -> COUNTER (split difference, increment round)
 * - If round >= MAX_ROUNDS and still not affordable -> WALK_AWAY
 */
function evaluateBuyerDecision({
  vendorOfferPrice,
  vendorRound,
  vendorDecision,
  buyerLastOffer,
  budgetCap = BUDGET_CAP,
  units = UNITS,
  maxRounds = MAX_ROUNDS
}) {
  // If vendor explicitly accepted
  if (vendorDecision === 'ACCEPT') {
    const finalPrice = vendorOfferPrice || buyerLastOffer;
    const totalCost = cleanNumber(finalPrice * units);
    return {
      decision: 'ACCEPT',
      price: finalPrice,
      totalCost,
      round: vendorRound,
      units,
      message: `Vendor accepted our terms. Deal confirmed at $${formatPrice(finalPrice)}/unit for ${units} units ($${formatPrice(totalCost)} total).`
    };
  }

  // If vendor walked away
  if (vendorDecision === 'WALK_AWAY') {
    return {
      decision: 'WALK_AWAY',
      price: null,
      totalCost: null,
      round: vendorRound,
      units,
      message: `Vendor decided to walk away at round ${vendorRound}. Negotiation ended without a deal.`
    };
  }

  if (vendorOfferPrice === null || vendorOfferPrice === undefined) {
    return {
      decision: 'UNKNOWN',
      message: 'Could not extract valid offer price from vendor reply.'
    };
  }

  const totalCost = cleanNumber(vendorOfferPrice * units);

  // If vendor's offer price times UNITS <= BUDGET_CAP -> ACCEPT
  if (totalCost <= cleanNumber(budgetCap)) {
    return {
      decision: 'ACCEPT',
      price: vendorOfferPrice,
      totalCost,
      round: vendorRound,
      units,
      message: `Vendor offer of $${formatPrice(vendorOfferPrice)}/unit ($${formatPrice(totalCost)} total) is within our budget cap of $${formatPrice(budgetCap)}. Accepting terms.`
    };
  }

  // If not affordable and vendorRound <= maxRounds -> COUNTER
  // Buyer is willing to send one more counter even when vendorRound == MAX_ROUNDS,
  // since vendor-agent's final round is exactly when it may accept a fair offer.
  if (vendorRound <= maxRounds) {
    // Split the difference between buyer's last offer and vendor's last offer
    const difference = vendorOfferPrice - buyerLastOffer;
    let splitOffer = buyerLastOffer + (difference / 2);
    // Ensure we do not counter higher than our maximum per-unit budget
    const maxPerUnit = budgetCap / units;
    splitOffer = Math.min(splitOffer, maxPerUnit);
    splitOffer = cleanNumber(splitOffer);

    const nextRound = vendorRound + 1;
    const counterTotalCost = cleanNumber(splitOffer * units);

    return {
      decision: 'COUNTER',
      price: splitOffer,
      totalCost: counterTotalCost,
      round: nextRound,
      units,
      message: `Vendor offer of $${formatPrice(vendorOfferPrice)}/unit ($${formatPrice(totalCost)} total) exceeds our budget cap of $${formatPrice(budgetCap)}. Countering with $${formatPrice(splitOffer)}/unit ($${formatPrice(counterTotalCost)} total) for round ${nextRound}.`
    };
  }

  // If vendorRound > maxRounds and still not affordable -> WALK_AWAY
  return {
    decision: 'WALK_AWAY',
    price: null,
    totalCost: null,
    round: vendorRound,
    units,
    message: `Maximum rounds (${maxRounds}) exceeded and vendor's offer of $${formatPrice(vendorOfferPrice)}/unit ($${formatPrice(totalCost)} total) exceeds our budget cap of $${formatPrice(budgetCap)}. Walking away.`
  };
}

/**
 * Format buyer email body based on decision
 */
function buildBuyerEmailBody(decisionResult) {
  const { decision, price, units, round, message } = decisionResult;

  if (decision === 'ACCEPT') {
    return `DECISION: ACCEPT\nOFFER: $${formatPrice(price)}/unit x ${units} units\nROUND: ${round}\n\nWe agree to your terms of $${formatPrice(price)}/unit for ${units} units. We are ready to proceed with payment and order fulfillment.`;
  }

  if (decision === 'COUNTER') {
    return `DECISION: COUNTER\nOFFER: $${formatPrice(price)}/unit x ${units} units\nROUND: ${round}\n\n${message}`;
  }

  // WALK_AWAY
  return `DECISION: WALK_AWAY\nROUND: ${round}\n\n${message}`;
}

/**
 * Format payment approval summary banner string when deal is accepted
 */
function formatPaymentApprovalSummary(summary, walletInfo = null, options = {}) {
  const product = options.product || options.productName || PRODUCT_NAME || 'Widget X';
  const budgetCap = options.budgetCap !== undefined ? options.budgetCap : BUDGET_CAP;
  const vendor = options.vendorEmail || VENDOR_EMAIL;
  const buyer = options.buyerEmail || BUYER_EMAIL;

  const lines = [
    '==================================================',
    '            READY FOR PAYMENT APPROVAL            ',
    '==================================================',
    `Status:          DEAL ACCEPTED`,
    `Product:         ${product}`,
    `Price Per Unit:  $${formatPrice(summary.price)}`,
    `Units:           ${summary.units}`,
    `Total Price:     $${formatPrice(summary.totalCost)}`,
    `Budget Cap:      $${formatPrice(budgetCap)}`,
    `Vendor:          ${vendor}`,
    `Buyer Mailbox:   ${buyer}`
  ];

  if (walletInfo && (walletInfo.status || walletInfo.text)) {
    const statusText = walletInfo.status || walletInfo.text;
    lines.push(`Wallet Status:   ${statusText}`);
    if (walletInfo.balance !== undefined && walletInfo.balance !== null) {
      lines.push(`Wallet Balance:  ${walletInfo.balance}`);
    }
    if (walletInfo.portfolio !== undefined && walletInfo.portfolio !== null) {
      const portStr = typeof walletInfo.portfolio === 'object'
        ? JSON.stringify(walletInfo.portfolio)
        : String(walletInfo.portfolio);
      lines.push(`Portfolio:       ${portStr}`);
    }
  } else {
    lines.push('Wallet Status:   Wallet status unavailable');
  }

  lines.push('--------------------------------------------------');
  lines.push('Action: Payment approval required before funds transfer.');
  lines.push('==================================================');

  return lines.join('\n');
}

/**
 * Print the required payment approval summary banner when deal is accepted.
 * First calls get_paybox_connection via mermail-wallet MCP connection before printing.
 */
async function printPaymentApprovalBanner(summary, walletInfo = undefined, options = {}) {
  let resolvedWalletInfo = walletInfo;
  if (resolvedWalletInfo === undefined) {
    resolvedWalletInfo = await getPayboxConnectionStatus();
  }
  const banner = formatPaymentApprovalSummary(summary, resolvedWalletInfo, options);
  console.log(`\n${banner}\n`);
  return banner;
}

// ============================================================================
// NEGOTIATION TRANSCRIPT TRACKER & GENERATOR
// ============================================================================

/**
 * Format filename for saving transcript markdown file.
 * Formatted safely for Windows, Linux, and macOS file systems:
 * e.g. widget-x-negotiation-2026-09-24T15-30-00Z.md
 */
function formatTranscriptFilename(item = 'widget-x', date = new Date()) {
  const itemSlug = item.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const iso = date instanceof Date ? date.toISOString() : new Date(date).toISOString();
  const safeTimestamp = iso.replace(/:/g, '-').replace(/\..+/, 'Z');
  return `${itemSlug}-negotiation-${safeTimestamp}.md`;
}

/**
 * Save negotiation transcript markdown to file in transcripts directory
 */
function saveTranscriptToFile(markdownContent, {
  transcriptsDir = path.join(__dirname, 'transcripts'),
  item = 'widget-x',
  date = new Date()
} = {}) {
  if (!fs.existsSync(transcriptsDir)) {
    fs.mkdirSync(transcriptsDir, { recursive: true });
  }
  const filename = formatTranscriptFilename(item, date);
  const filePath = path.join(transcriptsDir, filename);
  fs.writeFileSync(filePath, markdownContent, 'utf8');
  return filePath;
}

/**
 * Send negotiation transcript as an email from buyer-agent to itself
 */
async function sendTranscriptEmail(markdownContent, {
  mailboxId = BUYER_MAILBOX_ID,
  buyerEmail = BUYER_EMAIL,
  product = PRODUCT_NAME || 'Widget X',
  finalDecision = 'ACCEPT',
  callMcp = callMermailMcp
} = {}) {
  const statusLabel = finalDecision === 'ACCEPT' ? 'DEAL ACCEPTED' : 'WALK_AWAY';
  const subject = `Negotiation Transcript: ${product} [${statusLabel}]`;
  const result = await callMcp('send_email', {
    mailboxId,
    body: {
      from: buyerEmail,
      to: buyerEmail,
      subject,
      text: markdownContent
    }
  });
  return result;
}

/**
 * Incremental tracker for negotiation rounds, offers, counters, and final outcome
 */
class NegotiationTracker {
  constructor({
    item = PRODUCT_NAME || 'Widget X',
    units = UNITS,
    budgetCap = BUDGET_CAP,
    vendorEmail = VENDOR_EMAIL,
    buyerEmail = BUYER_EMAIL,
    startTime = new Date().toISOString()
  } = {}) {
    this.item = item;
    this.units = units;
    this.budgetCap = budgetCap;
    this.vendorEmail = vendorEmail;
    this.buyerEmail = buyerEmail;
    this.startTime = startTime;
    this.endTime = null;
    this.rounds = [];
    this.currentRoundNumber = 1;
    this.finalResult = null;
    this.walletInfo = null;
  }

  recordBuyerOffer({ round = this.currentRoundNumber, price, units = this.units } = {}) {
    let entry = this.rounds.find((r) => r.roundNumber === round);
    if (!entry) {
      entry = {
        roundNumber: round,
        buyerOffer: null,
        vendorCounter: null
      };
      this.rounds.push(entry);
    }
    entry.buyerOffer = {
      price,
      units,
      totalCost: cleanNumber(price * units),
      timestamp: new Date().toISOString()
    };
    return entry;
  }

  recordVendorCounter({
    round = this.currentRoundNumber,
    decision,
    price,
    units = this.units,
    message = ''
  } = {}) {
    let entry = this.rounds.find((r) => r.roundNumber === round);
    if (!entry) {
      entry = {
        roundNumber: round,
        buyerOffer: null,
        vendorCounter: null
      };
      this.rounds.push(entry);
    }
    entry.vendorCounter = {
      decision,
      price,
      units,
      totalCost: price !== null && price !== undefined ? cleanNumber(price * units) : null,
      message,
      timestamp: new Date().toISOString()
    };
    return entry;
  }

  advanceRound() {
    this.currentRoundNumber += 1;
  }

  finish({ decisionResult, walletInfo = null }) {
    this.endTime = new Date().toISOString();
    this.finalResult = decisionResult;
    this.walletInfo = walletInfo;
  }

  generateMarkdown() {
    const isAccepted = this.finalResult?.decision === 'ACCEPT';
    const statusText = isAccepted ? 'DEAL ACCEPTED' : (this.finalResult?.decision || 'IN PROGRESS');

    const lines = [
      `# Negotiation Transcript: ${this.item}`,
      '',
      `## Overview`,
      `- **Product**: ${this.item}`,
      `- **Units**: ${this.units}`,
      `- **Budget Cap**: $${formatPrice(this.budgetCap)}`,
      `- **Buyer Mailbox**: ${this.buyerEmail}`,
      `- **Vendor**: ${this.vendorEmail}`,
      `- **Start Time**: ${this.startTime}`,
      `- **End Time**: ${this.endTime || 'In Progress'}`,
      `- **Final Result**: ${statusText}`,
      '',
      '---',
      '',
      '## Negotiation Rounds',
      ''
    ];

    for (const r of this.rounds) {
      lines.push(`### Round ${r.roundNumber}`);
      if (r.buyerOffer) {
        lines.push(`- **Buyer Offer**: $${formatPrice(r.buyerOffer.price)}/unit x ${r.buyerOffer.units} units ($${formatPrice(r.buyerOffer.totalCost)} total)`);
      }
      if (r.vendorCounter) {
        const isCounter = r.vendorCounter.decision === 'COUNTER';
        const label = isCounter ? 'Vendor Counter' : `Vendor ${r.vendorCounter.decision || 'Reply'}`;
        if (r.vendorCounter.price !== null && r.vendorCounter.price !== undefined) {
          lines.push(`- **${label}**: $${formatPrice(r.vendorCounter.price)}/unit x ${r.vendorCounter.units} units ($${formatPrice(r.vendorCounter.totalCost)} total)`);
        } else {
          lines.push(`- **${label}**: ${r.vendorCounter.decision}`);
        }
        if (r.vendorCounter.message) {
          lines.push(`  - Note: ${r.vendorCounter.message}`);
        }
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
    lines.push(`## Final Result: ${statusText}`);
    lines.push('');

    if (isAccepted) {
      const finalPrice = this.finalResult.price;
      const totalCost = this.finalResult.totalCost || cleanNumber(finalPrice * this.units);
      const savings = cleanNumber(this.budgetCap - totalCost);

      lines.push(`- **Status**: DEAL ACCEPTED`);
      lines.push(`- **Agreed Price Per Unit**: $${formatPrice(finalPrice)}`);
      lines.push(`- **Units**: ${this.units}`);
      lines.push(`- **Total Price**: $${formatPrice(totalCost)}`);
      lines.push(`- **Budget Cap**: $${formatPrice(this.budgetCap)}`);
      if (savings >= 0) {
        lines.push(`- **Budget Savings**: $${formatPrice(savings)}`);
      }
      if (this.finalResult.message) {
        lines.push(`- **Summary**: ${this.finalResult.message}`);
      }
      lines.push('');
      lines.push('### Payment Approval & Wallet Status');

      if (this.walletInfo && (this.walletInfo.status || this.walletInfo.text)) {
        const walletStatus = this.walletInfo.status || this.walletInfo.text;
        lines.push(`- **Wallet Status**: ${walletStatus}`);
        if (this.walletInfo.balance !== undefined && this.walletInfo.balance !== null) {
          lines.push(`- **Wallet Balance**: ${this.walletInfo.balance}`);
        }
        if (this.walletInfo.portfolio !== undefined && this.walletInfo.portfolio !== null) {
          const portStr = typeof this.walletInfo.portfolio === 'object'
            ? JSON.stringify(this.walletInfo.portfolio)
            : String(this.walletInfo.portfolio);
          lines.push(`- **Portfolio**: ${portStr}`);
        }
      } else {
        lines.push('- **Wallet Status**: Wallet status unavailable');
      }
      lines.push('- **Action**: Payment approval required before funds transfer.');
    } else {
      lines.push(`- **Status**: WALK_AWAY`);
      if (this.finalResult?.message) {
        lines.push(`- **Summary**: ${this.finalResult.message}`);
      }
      lines.push('- **Wallet Status**: N/A (Negotiation ended without a deal; no payment approval requested.)');
    }

    lines.push('');
    return lines.join('\n');
  }
}

// ============================================================================
// MAIN NEGOTIATION RUNNER
// ============================================================================

async function runBuyerAgent(options = {}) {
  const callMcp = options.callMcp || callMermailMcp;
  const callWalletMcp = options.callWalletMcp || callMermailWalletMcp;
  const transcriptsDir = options.transcriptsDir || path.join(__dirname, 'transcripts');
  const pollIntervalMs = options.pollIntervalMs !== undefined ? options.pollIntervalMs : POLL_INTERVAL_MS;
  const jitterMaxMs = options.jitterMaxMs !== undefined ? options.jitterMaxMs : 1000;

  // Resolve negotiation parameters from instruction (with fallback to defaults)
  const instruction = options.instruction !== undefined ? options.instruction : INSTRUCTION;
  const params = resolveNegotiationParameters(instruction, options);
  const vendorEmail = params.vendorEmail;
  const productName = params.productName;
  const units = params.units;
  const budgetCap = params.budgetCap;
  const maxRounds = options.maxRounds || MAX_ROUNDS;
  const startingOffer = options.startingOffer !== undefined ? options.startingOffer : STARTING_OFFER;

  log('Starting buyer negotiation agent...');
  logNegotiationParameters(params);
  log(`Configuration: Budget=$${formatPrice(budgetCap)}, Units=${units}, Vendor=${vendorEmail}, MaxRounds=${maxRounds}`);

  const tracker = new NegotiationTracker({
    item: productName,
    units: units,
    budgetCap: budgetCap,
    vendorEmail: vendorEmail,
    buyerEmail: BUYER_EMAIL
  });

  // Step 1: Record baseline email IDs in buyer inbox so we only process new arrivals
  log('Establishing baseline of current inbox messages...');
  const baselineList = await callMcp('list_emails', {
    mailboxId: BUYER_MAILBOX_ID,
    query: { folder: 'inbox', limit: 20 }
  });
  const seenEmailIds = new Set((baselineList.emails || []).map((e) => e.id));
  log(`Baseline recorded with ${seenEmailIds.size} existing inbox email(s).`);

  // Step 2: Send Opening Offer Email
  let buyerCurrentOffer = startingOffer;
  let buyerCurrentRound = 1;
  const initialSubject = `${productName} Negotiation`;
  const initialBody = `Hi, I'd like to negotiate for ${units} units of ${productName}.\n\nOFFER: $${formatPrice(buyerCurrentOffer)}/unit x ${units} units\nROUND: ${buyerCurrentRound}`;

  // Record opening offer incrementally in tracker
  tracker.recordBuyerOffer({
    round: buyerCurrentRound,
    price: buyerCurrentOffer,
    units: units
  });

  log(`Sending opening offer: $${formatPrice(buyerCurrentOffer)}/unit x ${units} units (Round ${buyerCurrentRound}) to ${vendorEmail}...`);

  const initialSend = await callMcp('send_email', {
    mailboxId: BUYER_MAILBOX_ID,
    body: {
      from: BUYER_EMAIL,
      to: vendorEmail,
      subject: initialSubject,
      text: initialBody
    }
  });

  log(`Opening offer sent successfully (Message ID: ${initialSend.id}).`);
  let negotiationActive = true;
  let threadId = null;

  // Step 3: Polling loop
  while (negotiationActive) {
    const jitterMs = jitterMaxMs > 0 ? Math.floor(Math.random() * (jitterMaxMs + 1)) : 0;
    const waitMs = pollIntervalMs + jitterMs;
    if (waitMs > 0) {
      log(`Waiting ${(waitMs / 1000).toFixed(2)} seconds (with jitter) before checking for vendor reply...`);
      await sleep(waitMs);
    }

    log('Checking buyer-agent inbox for new replies from vendor...');
    const inboxResult = await callMcp('list_emails', {
      mailboxId: BUYER_MAILBOX_ID,
      query: { folder: 'inbox', limit: 10, sortColumn: 'date', sortDirection: 'DESC' }
    });

    const candidateEmails = (inboxResult.emails || []).filter((email) => {
      if (seenEmailIds.has(email.id)) return false;
      const sender = (email.sender || '').toLowerCase();
      return sender.includes(vendorEmail.toLowerCase()) || vendorEmail.toLowerCase().includes(sender);
    });

    if (candidateEmails.length === 0) {
      log('No new replies from vendor yet.');
      continue;
    }

    for (const emailSummary of candidateEmails) {
      seenEmailIds.add(emailSummary.id);
      log(`Found new incoming reply: ID ${emailSummary.id}, Subject: "${emailSummary.subject}"`);

      // Fetch full email content
      const fullEmail = await callMcp('get_email', {
        mailboxId: BUYER_MAILBOX_ID,
        emailId: emailSummary.id
      });

      threadId = fullEmail.thread_id || threadId;
      const parsed = parseOffer(fullEmail.body, fullEmail.body_format === 'html' ? fullEmail.body : '');

      if (!parsed) {
        log(`Email ID ${emailSummary.id} did not contain parseable negotiation lines. Skipping.`);
        continue;
      }

      log(`Parsed vendor message: Decision=${parsed.decision}, Offer=$${formatPrice(parsed.offerPrice)}/unit x ${parsed.quantity} units, Round=${parsed.round}`);

      // Record vendor's counter incrementally in tracker for current round
      tracker.recordVendorCounter({
        round: tracker.currentRoundNumber,
        decision: parsed.decision,
        price: parsed.offerPrice,
        units: parsed.quantity
      });

      // Evaluate buyer decision
      const decisionResult = evaluateBuyerDecision({
        vendorOfferPrice: parsed.offerPrice,
        vendorRound: parsed.round,
        vendorDecision: parsed.decision,
        buyerLastOffer: buyerCurrentOffer,
        budgetCap: budgetCap,
        units: units,
        maxRounds: maxRounds
      });

      log(`Decision made: ${decisionResult.decision}`);
      log(`Explanation: ${decisionResult.message}`);

      // Handle ACCEPT
      if (decisionResult.decision === 'ACCEPT') {
        const acceptBody = buildBuyerEmailBody(decisionResult);
        log(`Sending acceptance confirmation to ${vendorEmail}...`);

        await callMcp('send_email', {
          mailboxId: BUYER_MAILBOX_ID,
          body: {
            from: BUYER_EMAIL,
            to: vendorEmail,
            subject: /^Re:/i.test(emailSummary.subject) ? emailSummary.subject : `Re: ${emailSummary.subject}`,
            text: acceptBody
          }
        });

        log('Acceptance email sent.');
        const walletInfo = await getPayboxConnectionStatus(callWalletMcp);
        await printPaymentApprovalBanner(decisionResult, walletInfo, { product: productName, budgetCap, vendorEmail, buyerEmail: BUYER_EMAIL });
        tracker.finish({ decisionResult, walletInfo });
        negotiationActive = false;
        break;
      }

      // Handle COUNTER
      if (decisionResult.decision === 'COUNTER') {
        buyerCurrentOffer = decisionResult.price;
        buyerCurrentRound = decisionResult.round;
        tracker.advanceRound();
        tracker.recordBuyerOffer({
          round: tracker.currentRoundNumber,
          price: buyerCurrentOffer,
          units: units
        });
        const counterBody = buildBuyerEmailBody(decisionResult);

        log(`Sending counter-offer of $${formatPrice(buyerCurrentOffer)}/unit (Round ${buyerCurrentRound}) to ${vendorEmail}...`);

        await callMcp('send_email', {
          mailboxId: BUYER_MAILBOX_ID,
          body: {
            from: BUYER_EMAIL,
            to: vendorEmail,
            subject: /^Re:/i.test(emailSummary.subject) ? emailSummary.subject : `Re: ${emailSummary.subject}`,
            text: counterBody
          }
        });

        log(`Counter-offer sent. Waiting for next vendor turn...`);
        break;
      }

      // Handle WALK_AWAY
      if (decisionResult.decision === 'WALK_AWAY') {
        const walkBody = buildBuyerEmailBody(decisionResult);
        log(`Sending decline/walk-away notification to ${vendorEmail}...`);

        await callMcp('send_email', {
          mailboxId: BUYER_MAILBOX_ID,
          body: {
            from: BUYER_EMAIL,
            to: vendorEmail,
            subject: /^Re:/i.test(emailSummary.subject) ? emailSummary.subject : `Re: ${emailSummary.subject}`,
            text: walkBody
          }
        });

        log('Walk-away notice sent. Negotiation terminated without deal.');
        tracker.finish({ decisionResult, walletInfo: null });
        negotiationActive = false;
        break;
      }
    }
  }

  // After negotiation completes (ACCEPT or WALK_AWAY), save and email transcript
  if (tracker.finalResult) {
    const transcriptMarkdown = tracker.generateMarkdown();
    let savedFilePath = null;
    try {
      savedFilePath = saveTranscriptToFile(transcriptMarkdown, { transcriptsDir, item: productName });
      log(`Negotiation transcript saved to markdown file: ${savedFilePath}`);
    } catch (saveErr) {
      log(`Error saving transcript markdown file: ${saveErr.message}`);
    }

    try {
      log(`Sending negotiation transcript email to ${BUYER_EMAIL}...`);
      await sendTranscriptEmail(transcriptMarkdown, {
        mailboxId: BUYER_MAILBOX_ID,
        buyerEmail: BUYER_EMAIL,
        product: productName,
        finalDecision: tracker.finalResult.decision,
        callMcp
      });
      log(`Negotiation transcript emailed successfully to ${BUYER_EMAIL}.`);
    } catch (emailErr) {
      log(`Warning: Failed to email transcript to ${BUYER_EMAIL}: ${emailErr.message}`);
    }

    log('Buyer negotiation agent finished.');
    return {
      finalResult: tracker.finalResult,
      tracker,
      transcriptMarkdown,
      savedFilePath
    };
  }

  log('Buyer negotiation agent finished.');
}

module.exports = {
  DEFAULT_BUDGET_CAP,
  DEFAULT_UNITS,
  DEFAULT_VENDOR_EMAIL,
  DEFAULT_PRODUCT_NAME,
  DEFAULT_STARTING_OFFER,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_INSTRUCTION,
  getCommandLineInstruction,
  INSTRUCTION,
  PRODUCT_NAME,
  parseInstruction,
  resolveNegotiationParameters,
  logNegotiationParameters,
  BUDGET_CAP,
  UNITS,
  VENDOR_EMAIL,
  MAX_ROUNDS,
  STARTING_OFFER,
  POLL_INTERVAL_MS,
  BUYER_MAILBOX_ID,
  BUYER_EMAIL,
  formatPrice,
  cleanNumber,
  parseOffer,
  evaluateBuyerDecision,
  buildBuyerEmailBody,
  getMermailWalletOAuthToken,
  callMermailWalletMcp,
  getPayboxConnectionStatus,
  formatPaymentApprovalSummary,
  printPaymentApprovalBanner,
  NegotiationTracker,
  formatTranscriptFilename,
  saveTranscriptToFile,
  sendTranscriptEmail,
  runBuyerAgent
};

if (require.main === module) {
  const cliInstruction = getCommandLineInstruction();
  const options = cliInstruction ? { instruction: cliInstruction } : {};
  runBuyerAgent(options).catch((err) => {
    console.error('[Buyer Agent] Fatal error:', err);
    process.exit(1);
  });
}
