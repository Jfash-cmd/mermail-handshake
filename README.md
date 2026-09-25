# Mermail Handshake

An email-based negotiation skill built on Mermail.

## What this is

This project implements an autonomous negotiation skill where an agent handles commercial purchases over real email threads.

A buyer-agent connects to a real Mermail mailbox and negotiates terms with a vendor according to instructions supplied in plain English (for example: "Negotiate with vendor.negotiator11@gmail.com for 100 units of Widget X, budget cap $50"). The agent parses the target, sends an opening bid, evaluates incoming vendor replies, and counters within its budget constraints.

Once the vendor and buyer agree on terms, the agent queries the connected wallet status, logs a full markdown audit transcript of the conversation, and stops. It prints a clear payment approval summary and waits for a human decision instead of transferring funds automatically.

## Why it is built this way

Letting AI agents interact with businesses and other agents over email makes a lot of sense, but giving autonomous scripts unilateral control over money is risky.

This repository demonstrates a safe pattern for agent-to-agent commerce:
* Negotiation is autonomous. Agents can go back and forth across multiple rounds, adjusting offers, handling counter-proposals, and walking away if terms exceed the budget.
* Spending requires human approval. Read-only wallet checks verify that adequate balance exists, but no outbound transactions or signatures are executed autonomously. The agent hands off the agreed deal and stops.

## What is included

* `buyer-agent.js`: The buyer agent that connects to Mermail via API or MCP, manages email threads, parses incoming vendor offers, enforces the budget cap, and saves the final audit transcript.
* `vendor-bot.js`: A counterpart vendor bot used to demonstrate end-to-end negotiation over actual IMAP and SMTP email, following standard pricing ladder logic.
* `server.js` and `public/`: A lightweight local web dashboard for launching runs, watching the live turn-by-turn email exchange in real time, and inspecting negotiation transcripts.
* `test/`: A test suite covering offer parsing, negotiation round logic, boundary conditions, wallet safeguards, and dashboard endpoints.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file in the project root with your credentials:

```env
MERMAIL_API_KEY=your_mermail_api_key
VENDOR_GMAIL_ADDRESS=your_vendor_bot_email@gmail.com
VENDOR_GMAIL_APP_PASSWORD=your_vendor_gmail_app_password
```

## How to run it

### Step 1: Start the vendor bot

In your first terminal window, start the vendor listener:

```bash
node vendor-bot.js
```

The vendor bot will connect to its mailbox via IMAP and SMTP, then wait for incoming requests or offers from the buyer.

### Step 2: Run the negotiation

You can run the buyer in one of two ways:

#### Option A: Local Dashboard (Recommended)

Start the local dashboard server:

```bash
node server.js
```

Open `http://localhost:3000` in your browser. You can select a preset or type a custom instruction, then click the Start Negotiation button to watch both agents negotiate live on screen.

#### Option B: Command Line

Run the buyer agent directly from your terminal:

```bash
node buyer-agent.js "Negotiate with vendor.negotiator11@gmail.com for 100 units of Widget X, budget cap $50"
```

### Running Tests

To run the automated test suite:

```bash
npm test
```

***

Built for the Mermail Agent Skill bounty.
