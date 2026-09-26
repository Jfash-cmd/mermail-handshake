---
name: mermail-agent-handshake
description: Autonomous email negotiation skill using Mermail mailboxes for agent-to-agent procurement under a budget cap, with read-only wallet verification, halting before any payment step and leaving fund transfers entirely to human control outside the skill.
metadata:
  openclaw:
    requires:
      env:
        - MERMAIL_API_KEY
    primaryEnv: MERMAIL_API_KEY
    homepage: https://docs.mermail.app/ai/skills
    emoji: "🤝"
---

# Mermail Agent Handshake

An autonomous procurement and negotiation protocol built on Mermail. The buyer agent negotiates real commercial purchases with vendor agents or humans over standard email, enforces strict budget caps defined in plain English, logs complete markdown transcripts, checks connected wallet status via read-only tools, and halts before any payment step -- leaving the decision to send funds entirely to a human, outside the skill's control.

## 1. What This Skill Enables

Autonomous agent commerce requires a safe boundary between negotiation and payment execution:
- **Autonomous Communication**: The agent handles multi-turn email exchanges independently, calculating opening offers, evaluating counter-proposals, and determining walk-away points based on instructions.
- **Natural Language Parameter Extraction**: Accepts instructions like `"Negotiate with vendor@example.com for 100 units of Widget X, budget cap $50"`.
- **Budget Protection**: The agent will never agree to a unit price or total spend that exceeds the human-specified budget cap.
- **Halting Before Payment**: Once a deal is reached, the agent checks the connected wallet status using read-only tools, prints a deal summary, and stops -- full stop. The skill contains no built-in "confirm to pay" mechanism that then executes a transfer. Any actual payment must be initiated separately and manually by a human, outside of this skill entirely.

For detailed security principles and architectural guardrails, see [references/security.md](./references/security.md).

---

## 2. Interaction With Mermail Tools

This skill relies on the official Mermail MCP server tools. It strictly distinguishes between email negotiation tools and read-only wallet inspection tools:

### Allowed Email Tools
- `Mermail:send_email`: Dispatches initial offers, counter-proposals, final acceptance notices, walk-away notices, and audit transcripts.
- `Mermail:list_emails`: Periodically polls the buyer mailbox (`rewardcourt@mermail.app`) for new replies from the vendor matching the thread.
- `Mermail:get_email`: Retrieves full headers and raw body text to parse incoming quotes and decisions.

### Allowed Wallet Tools (Strictly Read-Only)
- `Mermail:get_paybox_connection`: Queries the connected Mermail Paybox wallet to verify `ACTIVE` status (status only -- no balance data is returned by this tool).

### Prohibited Tools (Absent From Skill Scope)
- `Mermail:paybox_request_transfer`
- `Mermail:paybox_transfer`
- Any mutation tool capable of signing transactions or releasing funds.

The skill does not possess tools or logic to execute, request, or dispatch transfers. The skill's job ends once the agreement is reached, verified, and recorded. Any payment is an independent manual operation carried out by a human operator entirely outside of this skill.

---

## 3. Step-by-Step Workflow

```text
[Plain English Instruction]
            │
            ▼
┌───────────────────────────────┐
│ 1. Parameter Extraction       │ ── Vendor, Product, Units, Budget Cap
└───────────────────────────────┘
            │
            ▼
┌───────────────────────────────┐
│ 2. Inbox Baseline Sync        │ ── Record existing UIDs to ignore old emails
└───────────────────────────────┘
            │
            ▼
┌───────────────────────────────┐
│ 3. Opening Offer Dispatched   │ ── Send Round 1 offer via send_email
└───────────────────────────────┘
            │
            ▼
┌───────────────────────────────┐
│ 4. Negotiation Loop           │ <── list_emails / get_email polling
│    - Parse vendor reply       │
│    - Compare vs Budget Cap    │
│    - Counter / Split Diff     │ ── Send Round 2..N counters
└───────────────────────────────┘
            │
      ┌─────┴────────────────┐
      ▼                      ▼
[DEAL ACCEPTED]         [WALK AWAY]
      │                      │
      ▼                      ▼
┌────────────────────┐ ┌────────────────────┐
│ 5. Read-Only       │ │ Log Termination    │
│    Wallet Check    │ │ Send Walk Notice   │
└────────────────────┘ └────────────────────┘
      │                      │
      ▼                      ▼
┌───────────────────────────────────────────┐
│ 6. Generate Markdown Audit Transcript     │ ── Saved to disk & emailed to self
└───────────────────────────────────────────┘
            │
            ▼
═════════════════════════════════════════════
  7. COMPLETE HALT BEFORE ANY PAYMENT STEP
     - Output deal summary & wallet status
     - Terminate execution (full stop)
     - Any actual payment is initiated
       manually by human outside the skill
═════════════════════════════════════════════
```

### Step 1: Instruction Intake & Parameter Resolution
Extract target vendor email, product description, quantity, and maximum budget cap using natural language parsing:
- **Vendor Email**: e.g., `vendor.negotiator11@gmail.com`
- **Product Name**: e.g., `Widget X`
- **Units**: e.g., `100`
- **Budget Cap**: e.g., `$50.00` total ($0.50/unit max)

### Step 2: Inbox Baseline Synchronization
Before sending the opening offer, query `Mermail:list_emails` to record all existing message IDs in the buyer's mailbox. This guarantees that stale emails or past negotiations are never misinterpreted as new replies.

### Step 3: Multi-Round Email Protocol
Offers are communicated via email using both human-readable text and machine-readable protocol blocks:
```text
OFFER: $0.40/unit x 100 units
ROUND: 1
DECISION: COUNTER
```

### Step 4: Decision Evaluation
On each incoming vendor turn:
- **Accept**: If vendor counter total is $\le$ `BUDGET_CAP`, accept immediately.
- **Counter**: If vendor counter > `BUDGET_CAP` and rounds remain, counter with a split-the-difference offer bounded by `BUDGET_CAP`.
- **Final Round**: At round $N = \text{MAX\_ROUNDS}$, counter at the exact maximum affordable price ($0.50/unit).
- **Walk Away**: If the vendor remains above budget after maximum rounds, gracefully terminate the negotiation.

### Step 5: Read-Only Wallet Verification
When a deal is reached, call `Mermail:get_paybox_connection` to confirm that the Paybox wallet connection is `ACTIVE` (status only -- no balance data is returned by this tool).

### Step 6: Audit Transcript Archival
Compile the entire chronological exchange into a structured Markdown transcript file, write it to `transcripts/`, and email a copy to the buyer agent mailbox.

### Step 7: Complete Halt Before Payment
Print the final **Deal Summary & Wallet Status** card and stop execution completely. The agent does not wait for an approval signal to execute a transfer — no transfer capability exists in this skill. Any decision to send funds is left entirely to a human, outside the skill's control.

---

## 4. Real-World Prompts & Expected Results

These examples reflect live negotiations executed with `buyer-agent.js` and `vendor-bot.js`:

### Example 1: Standard Purchase (Deal Accepted)
**User Prompt:**
> "Negotiate with vendor.negotiator11@gmail.com for 100 units of Widget X, budget cap $50"

**Exchange:**
1. **Round 1 (Buyer $\rightarrow$ Vendor)**: Offer `$0.40/unit` ($40.00 total).
2. **Round 2 (Vendor $\rightarrow$ Buyer)**: Counter `$0.60/unit` (Vendor anchor; exceeds $50 budget).
3. **Round 2 (Buyer $\rightarrow$ Vendor)**: Counter `$0.50/unit` (Splits difference; exactly at budget cap).
4. **Round 3 (Vendor $\rightarrow$ Buyer)**: Counter `$0.525/unit` (Vendor ladder; still exceeds $50 budget).
5. **Round 3 (Buyer $\rightarrow$ Vendor)**: Final counter `$0.50/unit` (Max affordable price).
6. **Round 3 (Vendor $\rightarrow$ Buyer)**: Vendor accepts at reserve floor `$0.45/unit` ($45.00 total).

**Outcome:**
- **Status**: `DEAL ACCEPTED`
- **Agreed Terms**: 100 units @ `$0.45/unit` = `$45.00` total ($5.00 under budget).
- **Wallet Check**: `ACTIVE` (status only -- no balance data is returned by this tool).
- **Result**: Transcript generated, summary printed, and execution terminates. Any payment must be initiated separately and manually by a human, outside of this skill.

---

### Example 2: Conservative Budget Cap
**User Prompt:**
> "Negotiate with vendor.negotiator11@gmail.com for 100 units of Widget X, budget cap $45"

**Exchange:**
1. **Round 1 (Buyer $\rightarrow$ Vendor)**: Offer `$0.35/unit` ($35.00 total).
2. **Round 2 (Vendor $\rightarrow$ Buyer)**: Counter `$0.60/unit` (Vendor anchor).
3. **Round 2 (Buyer $\rightarrow$ Vendor)**: Counter `$0.45/unit` (Max affordable price for $45 budget).
4. **Round 3 (Vendor $\rightarrow$ Buyer)**: Vendor reaches floor and accepts `$0.45/unit` ($45.00 total).

**Outcome:**
- **Status**: `DEAL ACCEPTED`
- **Agreed Terms**: 100 units @ `$0.45/unit` = `$45.00` total.
- **Wallet Check**: `ACTIVE` (status only -- no balance data is returned by this tool).
- **Result**: Execution stops. Any actual payment is handled manually by a human operator outside this skill.

---

### Example 3: Unaffordable Price (Walk Away)
**User Prompt:**
> "Negotiate with vendor.negotiator11@gmail.com for 100 units of Widget X, budget cap $40"

**Exchange:**
1. **Round 1 (Buyer $\rightarrow$ Vendor)**: Offer `$0.30/unit` ($30.00 total).
2. **Round 2 (Vendor $\rightarrow$ Buyer)**: Counter `$0.60/unit`.
3. **Round 2 (Buyer $\rightarrow$ Vendor)**: Counter `$0.40/unit` (Budget cap).
4. **Round 3 (Vendor $\rightarrow$ Buyer)**: Vendor cannot go below floor `$0.45/unit`.
5. **Round 3 (Buyer $\rightarrow$ Vendor)**: Buyer declines and sends walk-away notice (`DECISION: WALK_AWAY`).

**Outcome:**
- **Status**: `WALK_AWAY`
- **Agreed Terms**: None. Negotiation terminated without deal.
- **Wallet Check**: Skipped.
- **Result**: Transcript logged; zero funds allocated.

---

## 5. Security & Verification

For detailed security principles, duplicate-offer mitigation, and human-in-the-loop controls, refer to [`references/security.md`](./references/security.md).
