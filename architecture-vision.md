# ARGUS — Architecture Vision

## The Hundred-Eyed Guardian of Web3

*Argus Panoptes — the giant with a hundred eyes. Each one sees different threats. Together, nothing gets past.*

**Hackathon:** ETHPrague 2026
**Team size:** 2 (minimum per rules)
**Tracks:** Ethereum Core, Network Economy
**Bounties:** SpaceComputer ($6k), Sourcify ($4k), ENS ($4k), Apify ($2.7k), Umia ($2k+$10k), Best Hardware Usage, Best Privacy by Design, Best UX Flow

---

## 1. One-Sentence Pitch

A TEE-verified security intelligence network where anyone can report threats, the platform independently verifies them against Sourcify source code, publishes provably honest risk scores via ENS for the entire ecosystem, and autonomous guardians protect wallets using keys they can never steal.

## 2. The Problem

- $400M+ stolen from DeFi in 2026 alone
- 40% of on-chain transactions are now agent-initiated — none are defensive
- AI agents exploit 72% of known vulnerable contracts autonomously
- Existing tools (Revoke.cash, Forta, Hypernative) are either manual, protocol-focused, or lack source-code-level analysis
- No universal, verified, open threat intelligence feed exists for the Ethereum ecosystem

## 3. The Product

Argus is three things:

1. **A verified intelligence layer** — anyone submits threat signals, the platform verifies them inside a TEE against Sourcify source code, and publishes TEE-attested risk scores
2. **A universal distribution layer** — risk scores are served via ENS CCIP-Read wildcard resolution, so any wallet/dapp can check any contract's risk by resolving `[address].risks.argus.eth`
3. **An autonomous protection layer** — guardian agents consume platform consensus and execute protective actions (revoke, withdraw, alert) using signing keys held in Space KMS that no operator can touch

---

## 4. Architecture Overview

```
CONTRIBUTORS              PLATFORM                    CONSUMERS
(open, permissionless)     (TEE-verified)              (via ENS, free)

                          ┌─────────────────────┐
Security    ──signal───→  │                     │
researchers               │   CONSENSUS ENGINE  │
                          │   (GoTEE Trusted     │     Wallets
Watcher     ──signal───→  │    Applet — runs    │──→  (check risk
agents                    │    on QEMU, deploy- │     before approve)
                          │    able to USB      │
Apify       ──signal───→  │    Armory later)    │──→  DeFi protocols
scouts       (via X402)   │                     │     (embed risk badge)
                          │   • Weight by        │
On-chain    ──signal───→  │     reputation       │──→  Agentic wallets
monitors                  │   • Compute          │     (avoid risky
                          │     consensus        │      contracts)
                          │   • Sign with TEE    │
                          │     attestation      │──→  Other agents
                          │                     │     (consume scores)
                          └──────────┬──────────┘
                                     │
                              ┌──────▼──────┐
                              │  ENS CCIP   │
                              │  Wildcard   │
                              │  Resolver   │
                              │             │
                              │ [addr].risks│
                              │ .argus   │
                              │ .eth        │
                              └──────┬──────┘
                                     │
                              ┌──────▼──────┐
                              │  GUARDIANS  │
                              │             │
                              │  Act on     │
                              │  consensus  │
                              │  Sign via   │
                              │  Space KMS  │
                              │             │
                              │  Revoke /   │
                              │  Withdraw / │
                              │  Alert      │
                              └─────────────┘
```

---

## 5. Building Blocks (detailed)

### 5.1 Signal Submission API

**What:** REST/WebSocket endpoint where watchers submit threat signals.

**Signal schema:**
```json
{
  "contract_address": "0xABC...",
  "chain_id": 1,
  "threat_type": "SWAT-001",
  "description": "Arbitrary-call pattern allows approval drain",
  "evidence": {
    "type": "sourcify_analysis",
    "function_signature": "execute(address,bytes)",
    "details": "No access control on external call"
  },
  "submitter": "watcher-alice.argus.eth",
  "signature": "0x..."
}
```

**SWAT threat types (initial set for hackathon):**
- `SWAT-001` — Approval abuse (arbitrary call, unguarded transferFrom)
- `SWAT-002` — Admin key compromise (OwnershipTransferred to unknown)
- `SWAT-003` — Proxy upgrade exploit (Upgraded to unverified implementation)
- `SWAT-004` — Oracle manipulation (price deviation beyond threshold)
- `SWAT-005` — Rug pull pattern (liquidity removal setup, suspicious tokenomics)

**Implementation:** Node.js/Express server running in the platform's Normal World (non-TEE). Validates signal format, authenticates submitter via ENS signature verification, then passes to the TEE for processing.

---

### 5.2 Consensus Engine (TEE — GoTEE Trusted Applet)

**What:** The core intelligence processor running inside a GoTEE Trusted Execution Environment via QEMU emulation. This is where signals become verified risk scores. The same applet can be deployed to physical USB Armory Mk II hardware in the future (or at the event if devices are available), but all development and demo runs on QEMU.

**What runs INSIDE the TEE (Trusted Applet, Go or Rust):**
```
Input: raw signal from watcher
Process:
  1. VERIFY — cross-reference claim against Sourcify data
     - Fetch contract ABI + source from Sourcify API
     - Parse source for the claimed vulnerability pattern
     - If source confirms claim → confidence HIGH
     - If source doesn't match → confidence LOW, flag as suspicious

  2. AGGREGATE — combine with existing signals for this contract
     - Deduplicate (same threat type = 1 signal, not N)
     - Weight by submitter reputation (from reputation store)
     - Count independent signal sources

  3. SCORE — compute consensus risk level
     - 1 unconfirmed signal → YELLOW
     - 1 Sourcify-confirmed signal → ORANGE
     - 2+ independent confirmed signals → RED
     - 3+ signals including on-chain event → CRITICAL

  4. ATTEST — sign the risk score with TEE key
     - Hash the inputs + score + timestamp
     - Sign with the Trusted Applet's private key
       (generated inside TEE, never extracted)
     - Attestation = proof this score was computed
       by verified code in TrustZone

Output: {
  contract_address,
  risk_score,        // YELLOW | ORANGE | RED | CRITICAL
  confidence,        // 0-100%
  signal_count,
  signal_summary[],
  attestation,       // TEE signature
  code_hash,         // hash of running Trusted Applet code
  timestamp
}
```

**What runs OUTSIDE the TEE (Normal World):**
- Network I/O: HTTP calls to Sourcify API, blockchain RPC
- Signal reception from watchers
- Passing verified results to the ENS resolver and guardian coordinator
- Dashboard API serving

**Communication between worlds:** GoTEE syscall interface. Normal World sends signal data to Trusted Applet via syscall. Trusted Applet processes and returns signed risk score via syscall response.

**Development setup (QEMU-first, no hardware required):**
- Repository: `github.com/spacecomputer-io/gotee_starter` (branch: `pedro/qemu`)
- Primary environment: **QEMU emulation on laptop** — this is how we develop, test, and demo
- QEMU provides partial TrustZone emulation, sufficient for developing and demonstrating the Trusted Applet logic, attestation signing, and Secure/Normal World separation
- Language: Trusted Applet in Rust (supported via GoTEE), Normal World in Go
- Reference: `CLAUDE.md` in the gotee_starter repo for AI agent onboarding
- Hot reload: change `src/main.rs` without re-flashing
- Network: example in `examples/square` shows webserver forwarding traffic to the emulated device
- Build: `make qemu` runs the full TEE environment locally
- **Hardware note:** The same applet binary can be deployed to a physical USB Armory Mk II if available at the event. This is a bonus for the demo (physical device on the table), not a requirement. All functionality works identically on QEMU.

**Key question for SpaceComputer mentor:** "We're developing on QEMU using the gotee_starter repo (pedro/qemu branch). Can the Normal World in QEMU make outbound HTTP calls (to Sourcify API, Ethereum RPC) and pass response data to the Trusted Applet via syscalls? Also, does the QEMU attestation flow produce a verifiable signature we can check on-chain, or is that hardware-only?"

---

### 5.3 ENS Distribution Layer (CCIP-Read Wildcard Resolver)

**What:** A CCIP-Read (EIP-3668) wildcard resolver that serves risk scores for any contract address as an ENS subdomain of `argus.eth`.

**How it works:**
```
User/wallet resolves: 0xABC.risks.argus.eth

1. ENS registry has wildcard resolver for *.risks.argus.eth
2. Resolver returns CCIP-Read response pointing to our gateway
3. Gateway receives request for contract 0xABC
4. Gateway queries platform's risk score database
5. Returns risk score + TEE attestation as ENS text records
6. Client verifies the response against the resolver's on-chain commitment
```

**ENS text records served per contract:**
```
risk_score     = "CRITICAL"
confidence     = "97"
signals        = "sourcify:arbitrary-call,onchain:admin-transferred,external:peckshield-disclosure"
attestation    = "0x7f3a...TEE_SIGNATURE..."
code_hash      = "0xDEF...TRUSTED_APPLET_HASH..."
updated        = "2026-05-09T14:00:00Z"
action         = "REVOKE_APPROVAL,WITHDRAW_POSITION"
argus_url   = "https://argus.eth.limo/risk/0xABC"
```

**Implementation:**
- On-chain: deploy wildcard resolver contract on Sepolia pointing to our CCIP gateway
- Off-chain: CCIP gateway server (Node.js) that reads from the platform's risk score database
- Library: `@ensdomains/ccip-read` or custom CCIP gateway implementation
- Reference: ENS docs on CCIP-Read — https://docs.ens.domains/
- Reference: ENS docs on building with AI — https://docs.ens.domains/building-with-ai/

**ENS agent identities (subnames):**
```
argus.eth                        — the platform
├── risks.argus.eth              — wildcard risk score namespace
│   └── [any-address].risks.argus.eth → CCIP-Read risk score
├── agents.argus.eth             — agent registry namespace
│   ├── guardian-01.agents.argus.eth
│   │   text: fee=300, rescues=14, trust_tier=kms-attested
│   ├── watcher-sourcify.agents.argus.eth
│   │   text: specialty=code-analysis, accuracy=94, signals=203
│   └── scout-apify.agents.argus.eth
│       text: feeds=peckshield+certik, x402_address=0x...
└── vault.argus.eth              — recovery vault contract
```

**Why ENS is essential here:** Any wallet that does ENS resolution already works as a consumer. No custom integration. MetaMask resolves `0xABC.risks.argus.eth` → user sees risk score before approving. The distribution layer IS ENS. Remove ENS and you need custom APIs + wallet plugins for every wallet.

**Hits both ENS bounties:**
- Bounty 1 (AI Agents, $2k): agents have ENS subnames, capabilities in text records, agent-to-agent discovery via ENS
- Bounty 2 (Creative Use, $2k): CCIP-Read wildcard resolver serving security intelligence, subnames as access/identity layer

---

### 5.4 Sourcify Integration (Verification Engine)

**What:** The TEE's ground truth for verifying threat signals. When a watcher says "contract X is vulnerable," the TEE fetches the actual source code from Sourcify to independently confirm.

**API usage:**

```javascript
// Fetch verified source code for a contract
GET https://sourcify.dev/server/files/tree/any/1/0xABC...

// Response includes:
// - sources/ContractName.sol (full Solidity source)
// - metadata.json (compiler version, settings, ABI)
// - storage-layout.json (storage slot mappings)

// Fetch ABI specifically
GET https://sourcify.dev/server/files/any/1/0xABC.../metadata.json
```

**Verification patterns the TEE checks:**

```
SWAT-001 (Approval Abuse):
  Parse source → find functions accepting (address, bytes) params
  Check: does any function make arbitrary external calls?
  Check: is transferFrom reachable without access control?
  Match: function execute(address target, bytes calldata data) {
           target.call(data);  // VULNERABLE
         }

SWAT-002 (Admin Compromise):
  Parse source → find onlyOwner / access-controlled functions
  Enumerate: what can admin do? (pause, mint, setFee, upgrade, drain)
  Risk weight: admin can drain > admin can pause > admin can setFee
  Cross-reference: check admin address via on-chain call
    → is admin an EOA or multisig?
    → does admin have ENS name? (trust signal)
    → was admin recently changed? (red flag)

SWAT-003 (Proxy Upgrade):
  Parse source → detect proxy patterns (EIP-1967, TransparentProxy)
  When Upgraded event fires:
    → Fetch NEW implementation source from Sourcify
    → If NOT verified: HIGH RISK
    → If verified: diff against old source
    → Flag new functions: mint, drain, emergencyWithdraw

SWAT-005 (Code Similarity):
  For new/suspicious contracts:
    → Compare bytecode/source patterns against Sourcify dataset
    → Use BigQuery or Parquet export for batch analysis
    → "This contract shares 92% code with a known rug-pull"
```

**Deep dataset usage (what Sourcify judges want to see):**
- NOT just "is it verified?" (shallow)
- Parse actual source code for vulnerability patterns (deep)
- Use compiler metadata to flag dangerous compiler versions
- Use storage layouts to detect suspicious state variable patterns
- Cross-reference across 27M contracts via BigQuery for code similarity
- Pre-build a vulnerability pattern database from the Parquet export during hackathon setup

**Resources:**
- Sourcify docs: https://docs.sourcify.dev
- Sourcify API: https://docs.sourcify.dev/docs/api/
- Parquet dataset: https://docs.sourcify.dev/docs/repository/download-dataset/
- BigQuery: https://docs.sourcify.dev/docs/bigquery/
- 4byte signatures: https://docs.sourcify.dev/docs/api/ (4byte Signature API)
- GitHub: https://github.com/ethereum/sourcify
- Mentor: Manuel Wedler (@manuelwedler on Telegram, on site)

---

### 5.5 Space KMS (Guardian Signing)

**What:** Guardian agents sign revocation/withdrawal transactions using keys held in SpaceComputer's KMS. The private key is generated and stored in KMS — the operator never sees it, never touches it, cannot extract it.

**SDK:**
```typescript
import { OrbitportSDK } from "@spacecomputer-io/orbitport-sdk-ts";

const sdk = new OrbitportSDK({
  config: {
    clientId: process.env.ORBITPORT_CLIENT_ID,
    clientSecret: process.env.ORBITPORT_CLIENT_SECRET,
    authUrl: "https://auth.spacecomputer.io",
    apiUrl: "https://op.spacecomputer.io"
  }
});

// Create a secp256k1 key for Ethereum signing
const key = await sdk.kms.createKey({ type: "secp256k1" });

// Sign a revocation transaction
const signature = await sdk.kms.sign({
  keyId: key.id,
  message: serializedTransaction,
  messageType: "EIP191"  // or "RAW" or "DIGEST"
});

// cTRNG is also available with same credentials
const randomness = await sdk.ctrng.random();
```

**Guardian flow:**
```
1. Platform TEE outputs: "CRITICAL risk on 0xABC, trigger guardian"
2. Guardian receives trigger
3. Guardian constructs revoke transaction:
   approve(0xABC, 0) on the relevant ERC-20 token
4. Guardian calls sdk.kms.sign() to sign the transaction
   → private key stays in KMS, never exposed
5. Guardian submits signed transaction to blockchain
6. Approval revoked, user protected
```

**Why KMS is essential:** The guardian has session key access to user wallets. If the guardian operator held the key locally, they could sign malicious transactions. With KMS, the key is unreachable — even the operator cannot extract it. Combined with on-chain session key scoping (ERC-4337), the guardian physically cannot sign unauthorized actions.

**Starter repo:** SpaceComputer KMS starter — Next.js app that creates secp256k1 key, deploys contract on Sepolia, signs transactions. Build guardian logic on top.

**Credentials:** Register at https://accounts.spacecomputer.io/ for OAuth Client ID and Secret. Same credentials unlock both KMS and cTRNG.

**Resources:**
- SpaceComputer docs: https://docs.spacecomputer.io
- KMS starter repo: (see SpaceComputer ETHPrague guide)
- GoTEE starter: https://github.com/spacecomputer-io/gotee_starter (branch: pedro/qemu)
- Mentors: Filip Rezabek (@elrondjr), Amir Yahalom (@am_ylm), Pedro Sousa (@zkpedro)

---

### 5.6 Apify Scout (External Intelligence)

**What:** A watcher agent that scrapes off-chain security intelligence (security researcher tweets, audit reports, exploit disclosures) via Apify and pays per-request through the X402 protocol.

**Why off-chain intelligence matters:** On-chain watchers can only detect threats DURING or AFTER an attack (events, unusual transactions). Off-chain intelligence detects threats BEFORE — a researcher tweets about a vulnerability hours before any exploit. The scout gives the platform a head start.

**Implementation:**
```javascript
// Using Apify with X402 payment
// X402 docs: https://docs.apify.com/platform/integrations/x402

// Example: scrape a security researcher's feed
const result = await fetch("https://api.apify.com/v2/acts/twitter-scraper/run-sync", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Payment": x402PaymentHeader  // X402 protocol payment
  },
  body: JSON.stringify({
    searchTerms: ["SwapNet exploit", "DeFi vulnerability", "revoke approvals"],
    maxTweets: 10
  })
});

// Parse results, extract contract addresses mentioned
// Submit as signal to the platform
```

**X402 payment flow:**
```
Scout agent wants security feed data
  → Calls Apify Actor via X402
  → X402 handles payment in stablecoins on-chain
  → Apify delivers data
  → Scout parses and submits signals to platform
  → Demo shows the X402 payment transaction on-chain
```

**What to scrape (for the demo):**
- Security researcher Twitter/X accounts (PeckShield, CertiK, samczsun, SlowMist)
- Or: a simulated security feed for demo reliability

**Bounty requirement:** "Use Apify through X402. Show a real, tangible use case of paying for services." Our use case: agent paying for threat intelligence. Show the X402 transaction in the demo.

**Resources:**
- Apify docs: https://docs.apify.com/
- X402 integration: https://docs.apify.com/platform/integrations/x402
- Apify API: https://docs.apify.com/api
- Apify MCP: https://mcp.apify.com/
- Mentor: Jakub Kopecky (@themq37 on Telegram, responsible for X402)

---

### 5.7 Watcher Agents (Pluggable Detectors)

**What:** Independent processes that monitor for specific threat types and submit signals to the platform. Anyone can run one.

**For the hackathon, we build three watchers:**

**Watcher A — Sourcify Code Analyzer:**
```
Monitors: new contract deployments on Sepolia testnet
Process:
  1. Listen for new contract creation events
  2. Query Sourcify for verified source
  3. Parse source for SWAT vulnerability patterns
  4. If pattern found → submit signal to platform
Runs: as a Node.js process
```

**Watcher B — On-Chain Event Monitor:**
```
Monitors: OwnershipTransferred, Upgraded events on watched contracts
Process:
  1. Subscribe to relevant events via WebSocket RPC
  2. When event fires → check new owner/implementation
  3. If suspicious (fresh EOA, no ENS, unverified) → submit signal
Runs: as a Node.js process
```

**Watcher C — Apify Scout:**
```
Monitors: security researcher social media feeds
Process:
  1. Periodically call Apify via X402 to scrape feeds
  2. Parse for contract addresses and vulnerability mentions
  3. If relevant → submit signal to platform
Runs: as a Node.js process with X402 payment capability
```

**Agent configuration (YAML):**
```yaml
agent:
  name: "my-watcher"
  ens: "my-watcher.agents.argus.eth"
  swat_modules: ["SWAT-001", "SWAT-002"]
  data_sources:
    - type: sourcify
      depth: deep
    - type: on_chain
      events: [OwnershipTransferred, Upgraded]
    - type: apify
      feeds: [peckshield, certik]
      x402_budget: "0.01 ETH/day"
  submit_endpoint: "https://api.argus.eth.limo/signals"
```

---

### 5.8 Guardian Agent (Protection Execution)

**What:** An agent that consumes platform consensus and executes protective actions when risk threshold is reached. Signs transactions via Space KMS.

**Trigger flow:**
```
Platform TEE consensus: "0xABC is CRITICAL"
         │
         ▼
Guardian checks: which protected wallets have
  exposure to 0xABC?
         │
         ▼
For each exposed wallet:
  1. Determine action based on exposure type:
     - Has approval → construct revoke tx
     - Has deposit → construct withdraw tx
     - Holds token → construct swap tx (if configured)
     - Any exposure → send alert notification

  2. Sign via Space KMS:
     sdk.kms.sign({ keyId, message: serializedTx })

  3. Submit signed tx to blockchain

  4. Log action with TEE attestation reference
```

**Session key scoping (on-chain policy):**
The guardian's KMS key is registered as a session key on the user's smart wallet (ERC-4337). The session key module restricts what the key can do:
```solidity
// Session key permissions for guardian
SessionKeyPermissions({
  allowedFunctions: [
    // Can revoke any approval
    { selector: bytes4(keccak256("approve(address,uint256)")),
      paramRules: [{ index: 1, condition: EQUAL, value: 0 }] },
    // Can transfer to user's vault only
    { selector: bytes4(keccak256("transfer(address,uint256)")),
      paramRules: [{ index: 0, condition: EQUAL, value: USER_VAULT }] }
  ],
  validUntil: block.timestamp + 30 days,
  spendingLimit: type(uint256).max
})
```

Even if KMS is somehow compromised, the smart wallet rejects any transaction outside these rules.

---

### 5.9 Dashboard (User Interface)

**What:** React web application showing real-time platform activity, risk scores, and user-specific information.

**Views:**

**Public view (no wallet connected):**
- Live threat feed (recent risk score updates across the network)
- Watcher leaderboard (reputation, signal count, accuracy)
- Platform stats (contracts monitored, signals processed, wallets protected)

**User view (wallet connected):**
- "Your approvals" — list of all active token approvals with risk scores
- Risk heatmap — visual overview of exposure
- One-click manual revoke for any approval
- Guardian status (if enrolled) — active, last action, session key expiry
- Alert feed — notifications for risk changes on your contracts

**Agent view (for watcher/guardian operators):**
- Signal submission interface
- Reputation and accuracy stats
- Earnings and bounty claims

**Tech stack:** React + Vite + TailwindCSS. ethers.js for blockchain interaction. ENS resolution for risk scores. WebSocket for real-time updates from platform.

---

### 5.10 Smart Contracts (Sepolia)

**Contracts to deploy:**

**1. Argus Registry** — manages agent ENS subnames and reputation
```solidity
// Register a new agent
function registerAgent(string name, AgentType agentType, bytes metadata)
// Update reputation (called by TEE consensus engine, verified by attestation)
function updateReputation(address agent, uint256 accuracy, bytes attestation)
```

**2. Recovery Vault** — holds rescued funds (for rescue racing demo if included)
```solidity
function depositRescue(address[] victims, uint256[] amounts, uint256 feeBps)
function claim() external  // victims claim rescued funds
```

**3. Demo contracts:**
- `FakeSwapNet` — a contract with an intentional arbitrary-call vulnerability
- `MockUSDC` — ERC-20 token for demo purposes
- Pre-approve MockUSDC from several test wallets to FakeSwapNet

---

## 6. Sponsor Integration Summary

| Sponsor | Product Used | Integration Point | Depth |
|---|---|---|---|
| **SpaceComputer** | USB Armory GoTEE / **QEMU emulation** | Platform consensus engine runs as Trusted Applet in TrustZone (developed and demoed on QEMU, deployable to hardware) | TEE Track — verifiable computation |
| **SpaceComputer** | Space KMS SDK | Guardian signs revocation txs with unreachable key | KMS Track — key management |
| **SpaceComputer** | cTRNG | Agent enrollment randomness, attestation nonces | Bonus — same credentials |
| **Sourcify** | API + Parquet/BigQuery | TEE verifies threat claims against actual source code | Deep — source parsing, pattern matching, code similarity |
| **ENS** | CCIP-Read wildcard resolver | Risk scores distributed as ENS subdomains | Architectural — remove ENS, distribution breaks |
| **ENS** | Subnames + text records | Agent identity, reputation, discovery | Identity layer for agents |
| **Apify** | Actors + X402 | Scout agent scrapes security feeds, pays per-request | Functional — off-chain intelligence |
| **Umia** | Venture framing | Open agent marketplace with revenue path | Business — path to token and revenue |

---

## 7. Definition of Done — The Demo Scenario

### Preconditions (set up before demo):

1. `FakeSwapNet` contract deployed on Sepolia with arbitrary-call vulnerability
2. `MockUSDC` deployed, 50,000 tokens in 5 test wallets
3. All 5 wallets have approved MockUSDC to FakeSwapNet (unlimited approval)
4. Platform running: TEE consensus engine (QEMU), ENS resolver, signal API
5. Three watcher agents running: Sourcify analyzer, on-chain monitor, Apify scout
6. One guardian agent running with Space KMS signing key
7. One test wallet enrolled with guardian (session key granted)
8. Dashboard visible on screen

### Demo Flow (90 seconds live, within 5-minute presentation):

**STEP 1 — The trigger (simulated tweet)**

Presenter (or teammate) posts a simulated security alert. This can be:
- A real tweet from a test account: "ALERT: FakeSwapNet vulnerability discovered, arbitrary-call pattern in execute() function"
- OR: a direct signal submission to the platform API (simpler for demo reliability)

**Dashboard shows:** Scout agent detects external signal. X402 payment to Apify shown (or simulated).

**What audience sees:**
```
EVENT FEED:
[14:05:01] 🔍 Scout: External signal received
           Source: security researcher disclosure
           Contract: FakeSwapNet (0xABC...)
           Claim: "arbitrary-call vulnerability"
           X402 payment: 0.001 ETH to Apify ✓
```

**STEP 2 — Sourcify watcher confirms**

The Sourcify watcher agent independently fetches the contract source from Sourcify and confirms the vulnerability.

**Dashboard shows:** Second independent signal with code analysis details.

**What audience sees:**
```
[14:05:03] 🔬 Sourcify Watcher: Vulnerability CONFIRMED
           Contract: FakeSwapNet (0xABC...)
           Function: execute(address,bytes)
           Finding: Unguarded arbitrary external call
           Can drain: any approved token via transferFrom
           Confidence: HIGH
```

**STEP 3 — Platform TEE reaches consensus**

The TEE processes both signals, verifies against Sourcify source code, and produces an attested risk score.

**Dashboard shows:** Consensus engine processing, risk escalation, TEE attestation.

**What audience sees:**
```
[14:05:04] 🛡️ TEE Consensus: CRITICAL
           Contract: FakeSwapNet (0xABC...)
           Signals: 2 independent (external + sourcify)
           Sourcify verification: CONFIRMED ✓
           TEE attestation: 0x7f3a... ✓
           Code hash: 0xDEF... (matches open source) ✓

           Published to ENS:
           0xABC.risks.argus.eth → CRITICAL

           Action: TRIGGER GUARDIAN
```

**STEP 4 — Guardian protects wallets**

Guardian receives trigger, constructs revocation transactions, signs via Space KMS, submits to blockchain.

**Dashboard shows:** Guardian action, KMS signing, on-chain revocation.

**What audience sees:**
```
[14:05:05] ⚔️ Guardian: Protecting 5 wallets
           Signing via Space KMS (key in orbit) ✓

           Wallet 1: approve(FakeSwapNet, 0) → TX SENT ✓
           Wallet 2: approve(FakeSwapNet, 0) → TX SENT ✓
           Wallet 3: approve(FakeSwapNet, 0) → TX SENT ✓
           Wallet 4: approve(FakeSwapNet, 0) → TX SENT ✓
           Wallet 5: approve(FakeSwapNet, 0) → TX SENT ✓

           All approvals revoked. Funds safe.
```

**STEP 5 — Attacker arrives too late (optional but powerful)**

If time allows, demonstrate an attacker trying to exploit the vulnerability:

```
[14:05:30] 🚨 ATTACK ATTEMPT DETECTED
           Attacker: 0xEVIL...
           Action: FakeSwapNet.execute(USDC, transferFrom(...))
           Result: REVERTED — approval is 0

           Attacker got: $0
           Users saved: $250,000
```

**STEP 6 — The scoreboard**

```
┌──────────────────────────────────────────────────┐
│              ARGUS DEMO RESULTS               │
│                                                  │
│  Signals submitted:        2 (scout + watcher)   │
│  TEE verification:         CONFIRMED             │
│  Consensus reached:        CRITICAL              │
│  Time to protection:       ~4 seconds            │
│  Wallets protected:        5                     │
│  Approvals revoked:        5                     │
│  Funds at risk:            250,000 USDC          │
│  Funds lost:               $0                    │
│  Attacker earned:          $0                    │
│                                                  │
│  Trust guarantees:                               │
│  ✓ TEE attested (consensus tamper-proof, runs   │
│    in GoTEE on QEMU, deployable to hardware)    │
│  ✓ KMS signed (key unreachable by operator)      │
│  ✓ Sourcify verified (vulnerability confirmed    │
│    from actual source code)                      │
│  ✓ ENS published (risk score queryable by any    │
│    wallet in the ecosystem)                      │
│                                                  │
│  SwapNet (real, Jan 2026): $13.4M lost           │
│  SwapNet (with Argus):  $0 lost               │
└──────────────────────────────────────────────────┘
```

### Definition of Done checklist:

- [ ] FakeSwapNet + MockUSDC deployed on Sepolia
- [ ] TEE consensus engine running on QEMU (GoTEE Trusted Applet processes signals, produces attested scores)
- [ ] Sourcify watcher detects vulnerability in FakeSwapNet source
- [ ] Signal submission and TEE verification working end-to-end
- [ ] ENS CCIP-Read resolver serving risk scores for FakeSwapNet
- [ ] Guardian agent with Space KMS signing key
- [ ] Guardian successfully revokes approvals on trigger
- [ ] Dashboard shows entire flow in real-time
- [ ] Apify X402 payment demonstrated (or simulated)
- [ ] Agent ENS subnames registered with text records
- [ ] TEE attestation verifiable
- [ ] Presentation rehearsed (5 minutes, including live demo)
- [ ] Backup video recorded in case live demo fails

---

## 8. Hackathon Build Plan (2 people, 3 days)

### Pre-hackathon (before arriving):

- [ ] Get SpaceComputer credentials (OAuth Client ID/Secret) from https://accounts.spacecomputer.io/
- [ ] Clone and test KMS starter repo — verify Ethereum signing works on Sepolia
- [ ] Clone and test gotee_starter (pedro/qemu branch) — run `make qemu`, verify Trusted Applet boots, test syscall interface between Secure/Normal worlds
- [ ] Register for Apify account, test X402 payment flow
- [ ] Read ENS CCIP-Read docs, find example resolver implementations
- [ ] Deploy FakeSwapNet + MockUSDC on Sepolia
- [ ] Pre-approve MockUSDC from 5 test wallets to FakeSwapNet

### Day 1 — Core infrastructure

**Person 1 (platform + TEE):**
- Morning: Set up GoTEE environment with QEMU (`make qemu`). Build Trusted Applet with signal processing logic. Input: signal JSON. Output: risk score + attestation. Verify QEMU emulation runs correctly.
- Afternoon: Implement Sourcify verification flow — Normal World fetches source via Sourcify API, passes parsed results to Trusted Applet via syscalls for pattern matching and scoring. Test with FakeSwapNet contract.
- Evening: Signal submission API (Node.js/Express). Connect to TEE (via the webserver-forwarding pattern from `examples/square`). End-to-end: submit signal → TEE verifies → risk score output.

**Person 2 (agents + ENS + dashboard):**
- Morning: Sourcify watcher agent — monitors FakeSwapNet, detects arbitrary-call pattern, submits signal. On-chain watcher — listens for OwnershipTransferred events.
- Afternoon: ENS CCIP-Read wildcard resolver — deploy resolver contract on Sepolia, implement CCIP gateway that serves risk scores. Test: resolve `[address].risks.argus.eth`.
- Evening: Dashboard skeleton (React) — connect wallet, show approvals, display risk scores from ENS resolution.

### Day 2 — Integration + guardian + demo

**Person 1:**
- Morning: Guardian agent — consume platform consensus, construct revoke transactions, sign via Space KMS SDK. Test end-to-end on Sepolia.
- Afternoon: Apify scout agent — scrape security feed via X402, submit signal. Connect to platform.
- Evening: Full pipeline test: signal → TEE → ENS → guardian → revoke. Debug.

**Person 2:**
- Morning: Dashboard real-time updates — WebSocket event feed, risk score display, guardian action log. Agent registry view with ENS subnames.
- Afternoon: Register agent ENS subnames with text records (capabilities, fees, reputation). Polish dashboard UX.
- Evening: Full pipeline test with dashboard. Debug. Ensure demo reliability.

### Day 3 morning — Demo prep

- Both: Wire up complete demo scenario end-to-end (all on QEMU)
- Test 3x with timing
- Prepare presentation slides (5 slides max)
- Record backup video
- Optional: if USB Armory hardware is available and time permits, deploy Trusted Applet to physical device for a visual "hardware on the table" demo moment. This is bonus — the QEMU demo is the primary path.

---

## 9. Presentation Structure (5 minutes)

**Minute 0-1: The problem**
"40% of on-chain transactions are now agent-initiated. AI agents exploit 72% of known vulnerable contracts. $400M lost in DeFi in 2026. There are 100 agents trying to make money with your wallet. Zero trying to protect it."

**Minute 1-2: The product**
"Argus is a verified security intelligence network. Anyone can report threats. The platform independently verifies them against Sourcify source code inside a TEE. Verified risk scores are published via ENS — any wallet can check any contract. And autonomous guardians protect you with keys that no operator can touch."

**Minute 2-2.5: The trust model**
"Two trust problems, two solutions. The platform's consensus runs in a GoTEE Trusted Execution Environment — decisions are provably honest, computed by verified code. We develop and run on QEMU today; the same binary deploys to USB Armory satellites tomorrow. Guardian keys live in Space KMS — execution is provably safe. No human operator to trust at any point."

**Minute 2.5-4: LIVE DEMO**
[Run the demo scenario described in Section 7]

**Minute 4-5: The vision**
"What we showed is one threat type on one chain. The SWAT taxonomy covers admin compromises, proxy upgrades, oracle manipulation, rug pulls. ENS serves risk scores for any contract to any wallet. The more watchers contribute, the better the intelligence. The more guardians compete, the better the protection. This is the immune system Web3 has been missing."

**Closing line:**
"Argus had a hundred eyes. Our network has a hundred watchers. Each one sees different threats. Together, nothing gets past. There are 100 agents trying to use your money. Argus is watching all of them."

---

## 10. Track and Bounty Submission Strategy

Submit to ALL of the following (projects can win multiple categories):

**ETHPrague Tracks:**
- Ethereum Core (primary) — verified security infrastructure
- Network Economy — open intelligence marketplace with agent economics

**ETHPrague Bounties:**
- Best Hardware Usage — GoTEE TEE running consensus engine (QEMU emulation, deployable to USB Armory)
- Best Privacy by Design — anonymous agents, users don't need identity to benefit
- Best UX Flow — zero-friction protection, ENS-based universal access

**Sponsored Bounties:**
- SpaceComputer ($6k) — TEE via QEMU (Track 1, deployable to USB Armory) + KMS (Track 2) cross-track build
- Sourcify ($4k) — security pattern detector mining verified source code
- ENS ($4k) — Bounty 1 (AI agents) + Bounty 2 (CCIP-Read risk distribution)
- Apify ($2.7k) — X402 payment for security intelligence
- Umia ($2k+$10k) — agentic venture with clear revenue path

**Maximum potential:** $28,700 in sponsor prizes + ETHPrague track prizes + ETHPrague bounty prizes.

---

## 11. Risk Mitigation

| Risk | Mitigation |
|---|---|
| GoTEE/QEMU too complex | Fallback: run consensus engine as regular Node.js with simulated attestation. Explain TEE architecture in presentation, show QEMU setup separately if needed. |
| Space KMS latency too high | Fallback: pre-sign transactions, show KMS signing as a separate demo step. |
| ENS CCIP-Read resolver complex to deploy | Fallback: use off-chain resolver with ENS gateway, or hardcode resolver for demo contracts. |
| Apify X402 fails | Fallback: simulate the X402 payment, show the integration code, explain the flow. |
| Live demo fails on stage | Record backup video. Always have the video ready. Present video if needed, explain this is common in hackathons. |
| USB Armory hardware unavailable or limited | QEMU emulation is the primary path for both development and demo. Hardware deployment is a bonus. The project works fully on QEMU. |
| Testnet congestion | Deploy all contracts and run test transactions BEFORE the demo. Only the final revocation needs to work live. |

---

## 12. Key Contacts

| Sponsor | Mentor | Contact | Availability |
|---|---|---|---|
| SpaceComputer | Filip Rezabek | @elrondjr (Telegram) | On site |
| SpaceComputer | Pedro Sousa | @zkpedro (Telegram) | On site |
| Sourcify | Manuel Wedler | @manuelwedler (Telegram) | On site |
| Sourcify | Kaan Uzdoğan | @kuzdogan (Telegram) | Online |
| ENS | workemon.eth | @workemon (Telegram) | Whole event |
| Apify | Jakub Kopecky | @themq37 (Telegram) | All days |
| Umia | Nicolas | @Nicolas_993 (Telegram) | Full |
| Umia | Francesco (judge) | @fra_mosterts (Telegram) | Full |

---

## 13. Repository Structure (suggested)

```
argus/
├── README.md
├── architecture-vision.md          ← this document
├── contracts/
│   ├── FakeSwapNet.sol             ← demo vulnerable contract
│   ├── MockUSDC.sol                ← demo token
│   ├── ArgusRegistry.sol        ← agent registry
│   └── RecoveryVault.sol           ← fund recovery (if needed)
├── platform/
│   ├── tee/                        ← GoTEE Trusted Applet
│   │   ├── applet/                 ← consensus engine (Rust)
│   │   └── normal-world/           ← API server, Sourcify calls
│   ├── signal-api/                 ← signal submission endpoint
│   ├── ens-resolver/               ← CCIP-Read wildcard gateway
│   └── risk-db/                    ← risk score storage
├── agents/
│   ├── watcher-sourcify/           ← Sourcify code analyzer
│   ├── watcher-onchain/            ← on-chain event monitor
│   ├── scout-apify/                ← Apify X402 intelligence
│   └── guardian/                   ← KMS-signed protection agent
├── dashboard/
│   ├── src/
│   │   ├── components/             ← React components
│   │   ├── hooks/                  ← blockchain/ENS hooks
│   │   └── pages/                  ← main views
│   └── package.json
├── scripts/
│   ├── deploy-contracts.ts         ← testnet deployment
│   ├── setup-approvals.ts          ← pre-approve test wallets
│   ├── register-agents-ens.ts      ← register ENS subnames
│   └── demo-attack.ts              ← simulate attacker for demo
└── presentation/
    ├── slides.md                   ← presentation outline
    └── backup-video/               ← recorded demo backup
```
