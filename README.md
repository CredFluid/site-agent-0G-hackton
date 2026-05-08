# Site Agent Pro

> AI-powered browser agent that executes real user tasks on any website, captures step-by-step evidence, and produces scored, actionable reports.

**Playwright** · **OpenAI / Ollama / 0G Compute** · **axe-core** · **TypeScript** · **0G Storage & Chain** · **Zod**

Site Agent Pro is an AI browser agent that verifies website user flows, records evidence, and anchors audit proofs on 0G Storage and Chain.

---

## How It Works

```
User submits URL + tasks
        │
        ▼
┌─────────────────────────────┐
│  Chromium launches           │
│  (desktop 1440×900           │
│   or mobile 390×844)         │
└──────────┬──────────────────┘
           ▼
┌─────────────────────────────┐
│  For each task:              │
│   1. Capture page state      │
│   2. LLM plans next action   │
│   3. Playwright executes it  │
│   4. Repeat until done       │
└──────────┬──────────────────┘
           ▼
┌─────────────────────────────┐
│  Site checks:                │
│  SEO · Performance ·         │
│  Security · Accessibility ·  │
│  Mobile · Content · CRO      │
└──────────┬──────────────────┘
           ▼
┌─────────────────────────────┐
│  LLM evaluates the run       │
│  → Scored report (1-10)      │
│  → HTML / Markdown / JSON    │
│  → Activity replay animation │
└──────────┬──────────────────┘
           ▼
┌─────────────────────────────┐
│  0G Network Integration      │
│  → Plan/evaluate via 0G AI   │
│  → Persist to 0G Storage     │
│  → Anchor Proof on 0G Chain  │
└─────────────────────────────┘
```

**Verifying 0G Activity:**
- **0G Compute:** Set `LLM_PROVIDER=0g` to route planner/evaluator calls through the 0G inference endpoint.
- **On-Chain Audit:** Enable `ZG_PROOF_ENABLED=true` to upload audit evidence to 0G Storage and anchor the run's proof to the 0G Chain.
- **Registry:** Deploy `ZGAuditRegistry` once with `npm run zerog:deploy-registry`, then set `ZG_AUDIT_REGISTRY_ADDRESS` so future runs reuse the same proof registry.
- **Explorer:** Check `0g-proof.json` in the child agent run directory for the registry transaction explorer link.

---

## Features

- **Task-driven execution** — the agent follows only the tasks you provide, nothing more
- **Step-by-step evidence** — every interaction, page state, relevant console signal, and network failure is logged
- **Ordered instruction parsing** — pasted instructions, bullet lists, JSON tasks, and uploaded text files are normalized into accepted task lanes
- **Independent evaluation** — the LLM scores from captured evidence, not from the agent's own impressions
- **Multi-agent perspectives** — run 1–5 agents with different personas on the same site, merged into one report
- **Auth-aware** — detects login walls mid-run, fills signup forms, polls IMAP for OTP/verification emails
- **Supplemental audits** — SEO crawl, security headers, performance timings, accessibility (axe-core), CRO signals, content readability, mobile layout
- **Activity replay** — compact animated WebP that overlays all recorded agent actions onto the captured click frames
- **Exchange-flow QA** — safely tests Naira/crypto buy and sell flows with harmless values and stops before real transfers
- **Paystack Integration** — provision dedicated virtual Naira accounts for agents and trigger outbound bank transfers
- **0G Network Integration** — decentralized artifact persistence (0G Storage), on-chain audit proofs (0G Chain), and optional 0G Compute inference
- **Triple LLM support** — OpenAI (GPT-5) for production, Ollama for local development, and 0G for decentralized GPU inference
- **Two deployment modes** — CLI or web dashboard, including Render web service deployment

---

## Quick Start

### 1. Install

```bash
npm install
npm run browser:install
```

### 2. Configure

```bash
cp .env.example .env
```

Set your LLM provider in `.env`:

```bash
# Option A: OpenAI (recommended for production)
LLM_PROVIDER=openai
OPENAI_API_KEY=your_key_here

# Option B: 0G Network (decentralized GPU inference)
LLM_PROVIDER=0g
ZG_INFERENCE_BASE_URL=https://router-api.0g.ai/v1
ZG_INFERENCE_API_KEY=your_key_here
OPENAI_MODEL=qwen3.6-plus  # Recommended for agentic tasks

# Option C: Ollama (for local/private development)
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3.1:8b
```

Optional 0G audit proofs:

```bash
# Uses ZG_CHAIN_RPC_URL and ZG_PRIVATE_KEY or WALLET_PRIVATE_KEY from .env
npm run zerog:deploy-registry
```

Copy the printed registry address into `.env`:

```bash
ZG_PROOF_ENABLED=true
ZG_NETWORK=galileo
ZG_CHAIN_RPC_URL=https://evmrpc-testnet.0g.ai
ZG_STORAGE_INDEXER_RPC=https://indexer-storage-testnet-turbo.0g.ai
ZG_AUDIT_REGISTRY_ADDRESS=0xYourDeployedRegistryAddress
ZG_EXPLORER_URL=https://chainscan-galileo.0g.ai
ZG_PROOF_TIMEOUT_MS=120000
```

For HackQuest mainnet submissions, switch the proof network before deploying the registry:

```bash
ZG_PROOF_ENABLED=true
ZG_NETWORK=mainnet
ZG_CHAIN_RPC_URL=https://evmrpc.0g.ai
ZG_STORAGE_INDEXER_RPC=<mainnet-storage-indexer-rpc-url>
ZG_EXPLORER_URL=https://chainscan.0g.ai
```

`ZG_NETWORK=mainnet` refuses testnet RPC, storage indexer, or explorer URLs so the generated contract address and explorer link are suitable for mainnet-only submission requirements. Deploy `ZGAuditRegistry` again after switching networks, then use the new mainnet `ZG_AUDIT_REGISTRY_ADDRESS` for the final proof run.

The project uses the official `@0gfoundation/0g-storage-ts-sdk` package for 0G Storage uploads and `ethers@6.13.1`, which is the SDK's expected peer version. 0G proof registration is optional and time-bounded by `ZG_PROOF_TIMEOUT_MS`, so a slow storage or chain request cannot keep the audit submission running after the browser work and report evaluation finish.

### HackQuest Mainnet Proof

The current mainnet proof configuration uses:

- 0G mainnet registry contract: `0x53feA0506836077C2508a27B529212cA76529dce`
- Example 0G Explorer transaction: `https://chainscan.0g.ai/tx/0xcf3a5b28969255d1314244c5269fc53306792b9a8c855611f91c60637a334853`
- 0G components: 0G Compute for inference, 0G Storage for evidence bundles, and 0G Chain for proof registration.

For a fresh submission proof, run the agent with `ZG_NETWORK=mainnet` and use the newest child run's `0g-proof.json`. Aggregate run directories summarize multi-agent output; the child run contains the on-chain proof artifact.

### 3. Run

```bash
# Run the agent against a site
npm run dev -- --url https://example.com \
  --task "Open pricing and compare the visible plans before signup"

# Start the web dashboard
npm run dashboard
# → http://localhost:4173
```

### 4. View Results

Artifacts are saved to `runs/<run-id>/`:

| File | Contents |
|---|---|
| `report.html` | Standalone shareable report |
| `report.json` | Machine-readable scored report |
| `report.md` | Markdown report |
| `task-results.json` | Per-task step history and outcomes |
| `raw-events.json` | Every browser event, console log, and network request |
| `0g-proof.json` | **0G Chain** proof-of-audit, registry transaction, explorer URL, and **0G Storage** root hashes |
| `0g-proof-bundle.json` | Hash-addressed evidence bundle uploaded to 0G Storage; JSON evidence is embedded and large media is anchored by hash |
| `accessibility.json` | axe-core violation list |
| `site-checks.json` | SEO, performance, security, CRO, content, mobile checks |
| `click-replay.webp` | Compact animated activity replay with click screenshots and overlays for all recorded actions |
| `inputs.json` | Run configuration and timing metadata |
| `trade-executions.json` | Optional deterministic trade validation/execution records when trade mode is enabled |
| `trade-instruction.json` | Optional standalone trade CLI input copy when `npm run trade:run` is used |

---

## CLI Reference

```bash
# Basic single-task run
npm run dev -- --url https://example.com --task "Click the pricing tab"

# Multiple tasks
npm run dev -- --url https://example.com \
  --task "Read the visible how-to-play section" \
  --task "Play the game five times and record each win or loss"

# Mobile viewport (iPhone 13, 390×844)
npm run dev -- --url https://example.com --task "Check the mobile nav" --mobile

# Headed mode (visible browser)
npm run dev -- --url https://example.com --task "Open pricing" --headed

# Ollama for local sites
npm run dev -- --url http://127.0.0.1:3000 --task "Check the homepage CTA" \
  --llm-provider ollama --model llama3.1:8b

# Allow self-signed HTTPS certificates
npm run dev -- --url https://localhost:3000 --task "Check the homepage" --ignore-https-errors

# Exchange-flow QA without real transfers
npm run dev -- --url https://example.com \
  --task "Click Buy; enter 50000 NGN; confirm the crypto preview updates; copy the account number if available; stop before making any real payment" \
  --task "Click Sell; enter 0.01 USDT; confirm the Naira payout preview updates; stop before sending any real crypto"

# Deterministic onchain validation in dry-run mode
npm run dev -- --url https://example-dapp.test \
  --task "Sell 0.01 USDC using the visible deposit address" \
  --trade-dry-run --trade-strategy deposit_only
```

> **Note:** Every CLI run requires at least one `--task` flag. Runs with no tasks are rejected.

### All CLI Options

| Flag | Description |
|---|---|
| `--url <url>` | **(Required)** Website URL to test |
| `--task <task>` | **(Required)** Task for the agent. Repeat for multiple tasks |
| `--headed` | Run browser in headed (visible) mode |
| `--mobile` | Use iPhone 13 mobile viewport |
| `--ignore-https-errors` | Allow invalid or self-signed HTTPS certificates |
| `--llm-provider <name>` | LLM provider override: `openai` or `ollama`; use `.env` for `LLM_PROVIDER=0g` |
| `--model <name>` | Override the model name |
| `--ollama-base-url <url>` | Override the Ollama endpoint |
| `--storage-state <path>` | Load Playwright storage state JSON before the run |
| `--save-storage-state <path>` | Save Playwright storage state JSON after the run |
| `--auth-flow` | Bootstrap a test account (signup/login/OTP), then run tasks |
| `--auth-only` | Bootstrap a test account and save session — skip task run |
| `--signup-url <url>` | Signup page URL (absolute or relative) |
| `--login-url <url>` | Login page URL (absolute or relative) |
| `--access-url <url>` | Protected page URL to verify after login |
| `--trade-enabled` | Allow deterministic onchain trade execution for this run |
| `--trade-dry-run` | Validate extracted trade details without broadcasting a transaction |
| `--trade-strategy <strategy>` | Trade strategy: `auto`, `dapp_only`, or `deposit_only` |
| `--trade-confirmations <count>` | Confirmations to wait for before marking a trade confirmed, 0–12 |

---

## Web Dashboard

```bash
npm run dashboard
```

| URL | Purpose |
|---|---|
| `http://localhost:4173/` | Public submission form — enter URL, paste instructions, or upload text/JSON tasks |
| `http://localhost:4173/dashboard` | Internal run dashboard — inspect all results |
| `/submissions/<id>` | Submission progress tracking |
| `/r/<token>` | Public shareable report link (valid 30 days) |
| `/outputs/<run-id>` | Standalone HTML report for any run |
| `/api/runs` | REST API — list all runs |
| `/api/runs/<id>` | REST API — run detail |

The dashboard supports:
- Instruction paste box plus optional `.txt`, `.md`, `.json`, or `.csv` upload
- Public-hosted or localhost/private target mode for local development
- 1–5 concurrent agent perspectives per submission
- Per-submission trade controls for enablement, dry-run, strategy, and confirmation count
- Aggregate and per-agent report inspection
- Artifact downloads (JSON, Markdown, HTML, WebP activity replay)
- Strengths, weaknesses, and top fix recommendations

---

## Authentication

The agent can bootstrap authenticated sessions for sites that require signup/login.

### Quick Example

```bash
npm run dev -- --url https://example.com \
  --task "Reach the account dashboard and confirm billing is visible" \
  --auth-flow --signup-url /register --login-url /login --access-url /app
```

### What Auth Bootstrap Does

1. Fills visible signup fields with your configured test identity
2. Polls your IMAP inbox for OTP or verification emails
3. Submits the OTP code or opens the verification link
4. Logs in with the same credentials
5. Verifies a protected page (if `--access-url` is provided)
6. Saves the authenticated session to `.auth/session.json`

Successful auth also caches the working identity in `.auth/credentials.json`, keyed by target origin, so later runs against the same site can reuse the saved username or email plus password.

Auth walls detected mid-task are handled automatically when auth credentials are configured or a working identity has already been cached for that target origin.

### Auth-Only Mode

Save an authenticated session without running tasks:

```bash
npm run dev -- --url https://example.com --auth-only \
  --signup-url /register --login-url /login --access-url /dashboard
```

### Session Reuse

For sites behind verified sessions, load a saved Playwright storage state:

```bash
# Via CLI flag
npm run dev -- --url https://example.com --task "Reach the dashboard" \
  --storage-state .auth/session.json

# Via .env (auto-loaded on every run)
PLAYWRIGHT_STORAGE_STATE_PATH=.auth/session.json
```

> **Important:** This does not bypass CAPTCHA, MFA, or anti-bot controls. It reuses legitimate sessions you've established.

### Auth Environment Variables

**Required for a fresh auth bootstrap** (not needed when the target origin already has cached credentials):

| Variable | Description |
|---|---|
| `AUTH_TEST_EMAIL` | Email address for signup/login |
| `AUTH_TEST_PASSWORD` | Password for signup/login |

**Optional login field:**

`AUTH_TEST_USERNAME`

**IMAP inbox** (for OTP/verification email polling):

| Variable | Default | Description |
|---|---|---|
| `AUTH_IMAP_HOST` | — | IMAP server hostname |
| `AUTH_IMAP_PORT` | `993` | IMAP port |
| `AUTH_IMAP_SECURE` | `true` | Use TLS |
| `AUTH_IMAP_USER` | — | IMAP username |
| `AUTH_IMAP_PASSWORD` | — | IMAP password |
| `AUTH_IMAP_MAILBOX` | `INBOX` | Mailbox to poll |

**Optional identity fields:**

`AUTH_TEST_FIRST_NAME` · `AUTH_TEST_LAST_NAME` · `AUTH_TEST_PHONE` · `AUTH_TEST_ADDRESS_LINE1` · `AUTH_TEST_ADDRESS_LINE2` · `AUTH_TEST_CITY` · `AUTH_TEST_STATE` · `AUTH_TEST_POSTAL_CODE` · `AUTH_TEST_COUNTRY` · `AUTH_TEST_COMPANY`

**Optional tuning:**

| Variable | Default | Description |
|---|---|---|
| `AUTH_EMAIL_POLL_TIMEOUT_MS` | `180000` | Max wait time for verification email |
| `AUTH_EMAIL_POLL_INTERVAL_MS` | `5000` | Poll frequency |
| `AUTH_OTP_LENGTH` | `6` | Expected OTP digit count |
| `AUTH_EMAIL_FROM_FILTER` | — | Filter emails by sender |
| `AUTH_EMAIL_SUBJECT_FILTER` | — | Filter emails by subject |
| `AUTH_GENERATED_IDENTITY_MAX_ATTEMPTS` | `5` | Signup retry count when a generated identity is rejected |
| `AUTH_EMAIL_DOMAIN` | — | Override the generated plus-address domain |
| `AUTH_SIGNUP_URL` | — | Default signup URL (instead of CLI flag) |
| `AUTH_LOGIN_URL` | — | Default login URL |
| `AUTH_ACCESS_URL` | — | Default protected page URL |
| `AUTH_SESSION_STATE_PATH` | `.auth/session.json` | Where to save the session |

---

## Web3 Wallet Integration

The agent has built-in support for interacting with Web3 dApps. It uses a dual-mode architecture:

1. **Programmatic Provider (Default):** Injects a secure, headless-compatible `window.ethereum` provider. Transaction signing requests are intercepted and sent to a local HTTP relay running securely inside the Node.js process. The private key never enters the browser.
2. **MetaMask Extension Mode (Optional):** Runs a full headed browser with the MetaMask extension loaded, and automatically clicks "Connect", "Confirm", or "Sign" in MetaMask popups.

### Quick Setup

Configure your wallet in `.env`:

```bash
# Required
WALLET_PRIVATE_KEY=your_private_key_here
WALLET_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/...
WALLET_CHAIN_ID=11155111

# Optional: Mnemonic instead of private key
# WALLET_MNEMONIC="word1 word2 ..."
```

Once configured, the agent will automatically inject the wallet into every page it visits. The LLM planner is also aware of its wallet address and can interact with "Connect Wallet" flows.

### Deterministic Trade Execution

Trade execution is off by default unless `TRADE_ENABLED=true` or a run explicitly passes `--trade-enabled` or `--trade-dry-run`. When enabled, the agent only attempts a deterministic EVM sell/deposit handoff when the visible page and task provide enough evidence for recipient address, token, chain, and amount. Dry-run mode validates the extracted instruction and writes `trade-executions.json` without broadcasting.

Useful controls:

```bash
# Validate only; do not broadcast
--trade-dry-run

# Broadcast only if validation passes
--trade-enabled

# Choose how to handle the visible trade path
--trade-strategy auto|dapp_only|deposit_only
```

For a standalone trade instruction JSON file, use:

```bash
npm run trade:run -- --instruction ./sell-instruction.json --strategy deposit_only

# Add --broadcast only when you are ready to send the transaction
npm run trade:run -- --instruction ./sell-instruction.json --broadcast
```

### Using MetaMask Extension Mode

If you specifically need to test how a dApp interacts with the MetaMask UI, you can run the agent with the extension loaded. This requires extracting the MetaMask extension folder (not a `.crx` file).

**How to get the Extension Path (Mac):**
1. Ensure MetaMask is installed in your normal Google Chrome browser.
2. The extracted path is typically located at:
   `/Users/<YourUsername>/Library/Application Support/Google/Chrome/Default/Extensions/nkbihfbeogaeaoehlefnkodbefgpgknn/<version_number>`
3. Set the environment variable in `.env`:
   ```bash
   WALLET_METAMASK_EXTENSION_PATH=/Users/YourUsername/Library/.../11.14.2_0
   WALLET_METAMASK_USER_DATA_DIR=/Users/YourUsername/.site-agent-metamask-profile
   ```
*Note: Using this mode forces the agent to run in headed (visible) mode. For real MetaMask signing/confirm popups, point `WALLET_METAMASK_USER_DATA_DIR` at a persistent Chromium profile where MetaMask is already set up and unlocked.*

---

## Paystack Integration

The agent has built-in support for the Paystack API (Nigeria) to handle Naira payments and payouts. This enables "Agent-as-a-Service" monetization flows.

### Features
- **Dedicated Virtual Accounts (DVA):** Automatically provisions a unique bank account number (Wema/GTB) for each agent persona.
- **Naira Transfers:** Initiates outbound transfers to any Nigerian bank account via the Transfers API.
- **Webhook Processing:** Securely handles `charge.success` and `transfer.success` events with HMAC-SHA512 verification.
- **Zero-Dependency Client:** Uses Node 20+ native `fetch` (no `axios` required).

### Quick Setup
Configure Paystack in `.env`:
```bash
PAYSTACK_SECRET_KEY=sk_test_...
PAYSTACK_PUBLIC_KEY=pk_test_...
PAYSTACK_DVA_PROVIDER=wema-bank
```

### Testing the Integration
Run the standalone smoke test to verify your API keys and DVA provisioning:
```bash
npm run paystack:test
```

---


## Configuration

All settings are read from environment variables (`.env` file).

### Core Settings

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `openai` | LLM backend: `openai`, `ollama`, or `0g` |
| `OPENAI_API_KEY` | — | **(Required for OpenAI)** API key |
| `OPENAI_MODEL` | `gpt-5` | Model for planning and evaluation |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.1:8b` | Ollama model name |

### Execution Limits

| Variable | Default | Description |
|---|---|---|
| `MAX_SESSION_DURATION_MS` | `600000` | Total run time cap (clamped 60s–600s) |
| `MAX_STEPS_PER_TASK` | `32` | Max actions per task |
| `ACTION_DELAY_MS` | `600` | Delay between actions (human-like pacing) |
| `NAVIGATION_TIMEOUT_MS` | `25000` | Page load timeout |
| `RECORD_VIDEO` | `false` | Record Playwright video into the run directory |

### Browser

| Variable | Default | Description |
|---|---|---|
| `HEADLESS` | `true` | Set `false` for headed mode |
| `PLAYWRIGHT_STORAGE_STATE_PATH` | — | Auto-load session state JSON |
| `PLAYWRIGHT_EXECUTABLE_PATH` | — | Custom Chromium binary path |
| `USE_SERVERLESS_CHROMIUM` | — | Force `@sparticuz/chromium` |
| `SPARTICUZ_CHROMIUM_LOCATION` | — | Chromium binary location hint |

### Trade Policy

| Variable | Default | Description |
|---|---|---|
| `TRADE_ENABLED` | `false` | Enable deterministic trade execution by default |
| `TRADE_ALLOWLISTED_CHAIN_IDS` | — | Comma-separated chain IDs allowed for trade execution |
| `TRADE_TOKEN_REGISTRY` | `[]` | JSON array of `{ chainId, symbol, assetKind, contract?, decimals }` entries |
| `TRADE_MAX_TOKEN_AMOUNT` | — | Maximum token amount allowed by policy |
| `TRADE_REQUIRE_EXACT_TOKEN_CONTRACT` | `true` | Require ERC-20 contract matches when validating trades |
| `TRADE_CONFIRMATIONS_REQUIRED` | `1` | Default confirmations to wait for, 0–12 |
| `TRADE_RECEIPT_TIMEOUT_MS` | `120000` | Max wait time for transaction receipt/confirmation |

### 0G Network

| Variable | Default | Description |
|---|---|---|
| `ZG_INFERENCE_BASE_URL` | — | 0G inference API base URL when `LLM_PROVIDER=0g` |
| `ZG_INFERENCE_API_KEY` | — | 0G inference API key |
| `ZG_PROOF_ENABLED` | `false` | Enable 0G Storage upload and on-chain proof registration |
| `ZG_NETWORK` | `galileo` | 0G proof network: `galileo` for testnet or `mainnet` for HackQuest submission proofs |
| `ZG_PRIVATE_KEY` | `WALLET_PRIVATE_KEY` fallback | Wallet key used to pay 0G Storage and registry transactions |
| `ZG_CHAIN_RPC_URL` | `https://evmrpc-testnet.0g.ai` | 0G chain RPC endpoint |
| `ZG_STORAGE_INDEXER_RPC` | `https://indexer-storage-testnet-turbo.0g.ai` | 0G Storage indexer endpoint |
| `ZG_AUDIT_REGISTRY_ADDRESS` | — | Deployed `ZGAuditRegistry` address. Run `npm run zerog:deploy-registry` once to get it. |
| `ZG_EXPLORER_URL` | `https://chainscan-galileo.0g.ai` | Explorer base URL used to build transaction links |
| `ZG_PROOF_TIMEOUT_MS` | `120000` | Max wait time for optional 0G upload and proof registration before the run continues without a proof |

### Dashboard & Deployment

| Variable | Default | Description |
|---|---|---|
| `APP_BASE_URL` | — | Production URL for public report links. On Render, `RENDER_EXTERNAL_URL` is used automatically when this is unset. |
| `SITE_AGENT_DATA_DIR` | — | Root directory for persisted runs and submissions. Set this to your Render disk mount path for durable storage. |
| `PORT` | `10000` on Render | Public HTTP port for Render web services |
| `DASHBOARD_PORT` | `4173` | Dashboard server port |
| `DASHBOARD_HOST` | `127.0.0.1` locally, `0.0.0.0` on Render | Dashboard server host |
| `REPORT_TTL_DAYS` | `30` | Public report link expiry |
| `INTERNAL_JOB_SECRET` | — | Restrict background job invocation |

---

## Writing Effective Tasks

Since the agent follows only your tasks, structure them as focused coverage lanes:

```bash
# Map the main journey
--task "Navigate to pricing and compare the monthly vs yearly plans"

# Inspect discovery paths
--task "Use the site search to find 'refund policy' and read the visible result"

# Follow the conversion path
--task "Click the Sign Up Free tab, fill every visible detail, and submit"

# Probe edge cases
--task "Enter an invalid email in the signup form and check the error message"

# Safely test an exchange flow
--task "Click Buy; enter 50000 NGN; confirm the crypto preview updates; provide a harmless test wallet address; verify the payment account card appears; stop before making any real payment"

# Ask for monitoring evidence
--task "Check exchange-flow monitoring evidence for amount entry, wallet submission, bank submission, displayed account details, copy actions, and transfer attempts"
```

**Tips for better results:**
- Write **specific, concrete actions** — not "explore the site"
- Use ordered verbs like **click**, **enter**, **copy**, **scroll**, **wait**, **go back**, and **stop** when the sequence matters
- Include literal values when needed, for example `enter 50000 NGN` or `type "test@example.com" into email`
- Split large journeys into **separate tasks** so early clicks don't consume the entire budget
- Paste multi-line instructions or upload text/JSON files in the dashboard when tasks come from a spec
- A combined Naira/crypto exchange spec that mentions Buy flow, Sell flow, Naira, crypto, and logging/monitoring/events is expanded into separate Buy, Sell, and monitoring tasks
- For slow sites, increase `NAVIGATION_TIMEOUT_MS` before increasing step counts
- Use `--storage-state` for pages behind authentication
- Run **multiple agent perspectives** (2-5) when you want broader coverage
- For game sites, be explicit: "Play 5 rounds and record each win or loss"
- For exchange/payment QA, use harmless test values and explicitly tell the agent to stop before any real payment, crypto transfer, purchase, or payout

---

## Render Deployment

This repo now targets a standard Render web service deployment:

- **Dashboard server** (`src/dashboard/server.ts`) — handles the app, submission routes, public reports, and dashboard APIs
- **Local filesystem persistence** — submissions and run artifacts are stored under `SITE_AGENT_DATA_DIR`
- **Render Blueprint** (`render.yaml`) — defines the Render web service, health check, and persistent disk mount
- **Full Playwright runtime** — the build installs Chromium for the dashboard worker process

### Included `render.yaml`

The repo root includes a Render Blueprint with:

- `runtime: node`
- `buildCommand: npm ci && npm run build && npm run browser:install`
- `startCommand: npm run render:start`
- `healthCheckPath: /health`
- a persistent disk mounted at `/opt/render/project/src/data`

### Required Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key when `LLM_PROVIDER=openai` |

### Recommended Environment Variables

| Variable | Description |
|---|---|
| `LLM_PROVIDER` | Use `openai` or `0g` for a single-service Render deployment unless you are also hosting Ollama separately |
| `APP_BASE_URL` | Optional. If unset on Render, the app falls back to `RENDER_EXTERNAL_URL` |
| `SITE_AGENT_DATA_DIR` | Override only if you change the disk mount path from the default in `render.yaml` |
| `INTERNAL_JOB_SECRET` | Optional hardening for internal job-style routes |

> **Note:** Render web services must bind to `0.0.0.0:$PORT`, and persistent filesystem data survives deploys only when it is written under the attached disk mount path. See the official Render docs for [web services](https://render.com/docs/web-services), [persistent disks](https://render.com/docs/disks), and the [Blueprint spec](https://render.com/docs/blueprint-spec).

---

## Architecture

For a detailed technical breakdown of every module, see [**ARCHITECTURE.md**](ARCHITECTURE.md).

High-level summary:

| Layer | Key Files | Purpose |
|---|---|---|
| **Entry points** | `cli/run.ts`, `dashboard/server.ts` | CLI and web UI |
| **Orchestration** | `runAuditJob.ts`, `processSubmissionBatch.ts` | Single-run and multi-agent execution |
| **Agent loop** | `runner.ts` → `planner.ts` → `executor.ts` | Capture state → LLM plans → Playwright acts |
| **Page understanding** | `pageState.ts`, `siteBrief.ts`, `taskDirectives.ts`, `submissions/customTasks.ts` | DOM snapshots, site comprehension, ordered instruction and upload parsing |
| **Authentication** | `auth/profile.ts`, `auth/inbox.ts`, `auth/runner.ts` | Identity management, IMAP OTP polling, login flows |
| **Evaluation** | `evaluator.ts`, `aggregateReport.ts` | LLM scoring, multi-agent result merging |
| **Site checks** | `siteChecks.ts`, `audit.ts` | SEO, performance, security, accessibility |
| **Paystack** | `paystack/*` | Dedicated virtual accounts, Naira transfers, webhooks |
| **0G Network** | `zerog/*`, `llm/client.ts` | 0G Compute inference, decentralized storage, and on-chain proof registration |
| **Reporting** | `reporting/html.ts`, `reporting/markdown.ts`, `clickReplay.ts` | HTML/MD/JSON reports, activity replay animation |
| **Trade safety** | `trade/*`, `wallet/*` | Wallet injection, deterministic trade extraction, policy validation, dry-run/broadcast records |
| **LLM** | `llm/client.ts`, `prompts/browserAgent.ts`, `prompts/reviewer.ts` | OpenAI-compatible, 0G, and Ollama client, system prompts |

---

## Important Constraints

- **No CAPTCHA/MFA bypass** — the agent does not solve CAPTCHAs, MFA challenges, or anti-bot controls
- **No hidden DOM access** — the agent interacts only with visible elements, like a real user
- **No unsupported claims** — the evaluator scores from evidence only, not from the agent's impressions
- **Task-required** — every run must have at least one explicit task
- **Legitimate sessions only** — storage state reuse is for approved, pre-established sessions
- **Trade-safe by default** — onchain execution is disabled unless explicitly enabled, and exchange-flow QA should stop before real-world transfers

---

## Step-by-Step Guides

| Guide | Topic |
|---|---|
| `docs/01-installation.md` | Installation and setup |
| `docs/02-running-your-first-audit.md` | Your first run |
| `docs/03-configuration.md` | Configuration deep-dive |
| `docs/04-how-the-agent-thinks.md` | Agent planning internals |
| `docs/05-extending-personas-and-tasks.md` | Custom personas and tasks |
| `docs/06-hardening-for-production.md` | Production deployment |

---

## Recommended Rollout

1. **Start local** — run manually on desktop, inspect logs and reports
2. **Tune tasks** — write focused coverage lanes for your product
3. **Add mobile** — include `--mobile` runs
4. **Multi-agent** — use 2-5 perspectives for broader coverage
5. **CI integration** — only after you've validated the scores match your expectations

> Treat the scores as **signals, not ground truth** until you've calibrated them against your own quality bar.
