# Security & Safety Policy: Mermail Agent Handshake

This document details the multi-layered security architecture, anti-patterns, and guardrails enforced by the `mermail-agent-handshake` skill.

---

## 1. Complete Halt Before Any Payment Step

The fundamental security axiom of this skill is: **Negotiation can be autonomous, but spending must never be autonomous.**

```text
┌─────────────────────────────────┐
│     Autonomous Negotiation      │  <-- Multi-turn email offers & counters
└─────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│  Deal Reached (Accept / Agree)  │
└─────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│     Read-Only Wallet Check      │  <-- Verify ACTIVE status only
└─────────────────────────────────┘
                 │
                 ▼
═════════════════════════════════════
    COMPLETE HALT (FULL STOP)         <-- Skill execution terminates permanently
═════════════════════════════════════
                 │
                 ▼
┌─────────────────────────────────┐
│  Manual Human Action (External) │  <-- Any payment is initiated manually
└─────────────────────────────────┘      outside the skill entirely
```

### Architectural Distinction: No Built-in Transfer Execution
- The skill does **not** possess a "confirm to pay" callback, listener, or webhook that subsequently releases funds.
- It checks the wallet status (read-only), prints a summary of agreed terms and wallet status, and stops — full stop.
- Any actual payment must be initiated separately and manually by a human operator, outside of this skill entirely.
- This design eliminates the risk of prompt injections, corrupted state, or logic bugs coercing the agent into executing a financial transaction. The decision to send funds is left entirely to a human, outside the skill's control.

---

## 2. Read-Only Wallet Verification

To prevent unauthorized transactions, privilege escalation, or unexpected fund movement:

- The skill only interacts with Mermail's wallet subsystem using read-only endpoints:
  - `Mermail:get_paybox_connection`: Validates that the connected wallet is in an `ACTIVE` state (status only -- no balance data is returned by this tool).
- **Strictly Prohibited & Absent Tools**:
  - `paybox_request_transfer`
  - `paybox_transfer`
  - `paybox_create_invoice`
  - Any programmatic signing, transfer, or fund-movement mutation tools.
- Even if an incoming vendor email requests an immediate wire, crypto transfer, or invoice payment, the agent treats the text strictly as untrusted negotiation data and never delegates or attempts wallet execution.

---

## 3. Duplicate and Stale Offer Detection

In automated email workflows, network retries, email provider polling lag, or threading quirks can trigger duplicate message deliveries.

The counterparties enforce sequence-aware deduplication (implemented in `vendor-bot.js` and `buyer-agent.js`):

### Message-Level Tracking
- Every incoming email's `UID` and `Message-ID` are added to a processed set upon inspection.
- Identical `UID`s or `Message-ID`s delivered across subsequent poll cycles are skipped immediately without triggering a new evaluation.

### Sequence & Round Tracking
- Counterparties maintain active negotiation state per sender/recipient pair (`activeNegotiations` map).
- An incoming offer is rejected as duplicate or stale if `offerData.round <= lastProcessedRound` within the same negotiation session.
- **Session Reset Detection**: A new negotiation is recognized if:
  1. The previous negotiation completed with an explicit `isFinal` outcome (`ACCEPT` or `WALK_AWAY`), **or**
  2. A new `ROUND: 1` opening offer arrives after a cooldown window (>4 seconds since the last interaction).

This prevents rapid duplicate emails from generating contradictory counter-offers while allowing fresh negotiations to proceed smoothly.

---

## 4. Bounded Negotiation Rounds (`MAX_ROUNDS`)

To eliminate runaway infinite loops, credit exhaustion, or unconstrained email ping-pong:

- **Hard Round Limit**: Both buyer and vendor enforce a strict upper bound on rounds (default `MAX_ROUNDS = 3`).
- **Forced Terminal State**:
  - In `Round 1`: Parties establish opening bids and anchors.
  - In `Round 2`: Counter-offers split differences toward the budget cap.
  - In `Round 3` (Final Round): The buyer submits its maximum affordable price ($0.50/unit). If the vendor cannot meet or beat this price, it must issue `DECISION: WALK_AWAY` or `DECISION: ACCEPT` at its reserve floor ($0.45/unit).
- If `round >= MAX_ROUNDS` and prices cannot converge within budget, the agent sends an explicit `DECISION: WALK_AWAY` notice and terminates immediately.

---

## 5. Untrusted Email Intake & Injection Defense

Email bodies and subject lines are untrusted external inputs:

| Threat | Defense |
| --- | --- |
| Prompt injection inside email body | Parser extracts only strict regex matches for `OFFER:`, `ROUND:`, and `DECISION:`. Arbitrary instructions in email text are ignored. |
| Fake discount links or phishing URLs | The agent does not follow or navigate to external hyperlinks found in incoming emails. |
| Forged sender headers | The agent filters messages using mailbox thread IDs, Message-ID reference chains, and baseline inbox state. |
