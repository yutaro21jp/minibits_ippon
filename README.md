# Minibits Ippon

Ippon (一本, "one point", "decisive victory")

> [!IMPORTANT]
> This owner fork is an experimental, approval-gated payment branch based on
> [Minibits Ippon](https://github.com/minibits-cash/minibits_ippon). It is meant
> for developers building agents, bots, and services that need a human or policy
> check before a Lightning payment. It is not a consumer wallet or a
> production-ready release. Use disposable wallets and small test amounts only.

## Why this fork exists

The upstream project gives software a small Cashu wallet that can receive and
send ecash and pay Lightning invoices. This fork adds a safer local-CLI payment
boundary for systems that must not pay immediately when an invoice arrives:

1. `pay-prepare` obtains the Cashu melt quote, selects and reserves proofs, and
   returns the amount, fee ceiling, expiry, payment hash, and approval hashes.
   It does not pay.
2. An external application can show those values to a person or apply its own
   approval policy without receiving the raw quote ID or proofs.
3. `pay-execute` accepts only the unchanged approval hashes and attempts the
   payment once.
4. `pay-status` reconciles PENDING or UNKNOWN outcomes after a timeout or
   restart. It never retries the melt.

This is useful for an AI assistant proposing a small purchase, an expense bot
waiting for an owner, or any service that wants to avoid blind retries and
duplicate payments. End users normally do not operate this repository
directly; a product embeds it as its wallet engine and supplies the approval UI.

### Current safety boundary

- The split payment flow is implemented only for local CLI mode. The REST API
  remains outside this approval adapter.
- cashu-ts is pinned to 4.7.2 and amounts stay native until database, REST, or
  CLI integer boundaries.
- Quote IDs, proofs, and change-recovery material stay in the private Ippon
  database. Approval responses expose only hashes and bounded amounts.
- The full mocked test suite and build pass, including restart, proof
  reservation, preimage verification, and ambiguous-outcome tests.
- A two-mint local Nutshell FakeWallet drill now covers an accepted melt whose
  response is lost, immediate UNKNOWN persistence, and status-only recovery
  after process restart. It also verifies that cashu-ts cannot silently retry
  the approved melt through NUT-19 transport caching.
- `restore-audit` checks every proof in a restored private database against the
  mint's NUT-07 state without spending or exporting it. It fails readiness on
  PENDING proofs, local/remote mismatches, active reservations, or unresolved
  melt operations. Because querying historical spent proofs can help the mint
  correlate activity, products must require an explicit recovery-time privacy
  acknowledgement before invoking it.
- A real funded restore drill and an independent security review are still
  required before a production release.

### Opt-in local regtest fault drill

The live-protocol drill is intentionally separate from the ordinary unit test
suite. It requires Node.js 24+, [`uv`](https://docs.astral.sh/uv/), and an
official [Nutshell](https://github.com/cashubtc/nutshell) checkout. It creates
two local `127.0.0.1` FakeWallet mints so a source mint pays an invoice from a
distinct destination mint, without testnet coins or real sats:

```bash
IPPON_REGTEST_FAULT_ACK=local-regtest-fake-ecash-only \
IPPON_NUTSHELL_PATH=/absolute/path/to/nutshell \
npm run test:regtest-fault
```

The exact acknowledgement, two loopback-only origins, 255-fake-sat funding cap,
16-fake-sat payment cap, disposable databases, and secret-free result are
enforced in the harness. It forwards one accepted melt, discards that response,
blocks the first reconciliation, restarts Ippon, and permits only `pay-status`
to recover the operation. The temporary wallets, proofs, mint keys, and
databases are removed even on failure; `uv` may retain only its public package
and Python download cache.

Nutshell's FakeWallet is adjusted only inside these acknowledged local test
processes so its synthetic invoice uses standard 32-byte BOLT11 preimage
hashing. That test-only hook is never loaded by Ippon or a production mint.

The original project and this fork are distributed under the MIT License. See
[`LICENSE`](LICENSE). The upstream authorship and Git history are preserved.

Minibits Ippon is a minimalistic ecash and Lightning wallet implementing the Cashu protocol. It can be operated as a **REST API server** (for hosted deployments and AI agents connecting over HTTP) or as a **local CLI** (for AI agents that install and control it directly via standard I/O).

> ### Try it out
> A live Ippon instance is running at **ippon.minibits.cash**:
>
> - [Swagger UI](https://ippon.minibits.cash/v1/) — API explorer (`GET /v1/`)
> - [OpenAPI 3.0 JSON](https://ippon.minibits.cash/v1/json) — raw spec (`GET /v1/json`)
> - [Wallet info](https://ippon.minibits.cash/v1/info) — wallet service info (`GET /v1/info`)
> - [MCP server](https://ippon.minibits.cash/mcp) — MCP server to make usage by AI agents easier (`POST /mcp`)
>
> Also available as Tor hidden service (requires [Tor Browser](https://www.torproject.org/) or a Tor-enabled client):
>
> - `eaqmg2oqhay5btz5v75bgknfb3x4q4vesfijjzvgkbgocn5fvhkntwad.onion`
>
> ⚠️ **This instance is provided for research, development and testing and evaluation purposes only. It is an alpha software, use it at your own risk, with small amounts only. Do not store funds you cannot afford to lose.**


Ippon is designed primarily for non-human systems — especially AI agents — that require instant, automated capability to receive and send micropayments without human intervention.

Minibits Ippon is intended both for server-side and local deployment, optimized for short-lived, single-purpose wallets with low balances.

To minimize complexity and provide an extremely simple API that AI agents can easily understand and use, Ippon adheres to strict design constraints:

### Mints defined by operator, single unit

Ippon supports one or more Cashu mints configured via the `MINT_URLS` environment variable (comma-separated list). All mints share a single unit (e.g. `sat`), keeping the API simple. Each wallet is bound to exactly one mint at creation time; the first listed mint is the default. Operators control which mints are accepted, keeping custody scope well-defined.

### Seed-less wallets
    
AI agents lack reliable long-term secret storage. Ippon wallets are expected to be short-lived, hold minimal balances, and should be emptied upon session completion. Seed-based wallets introduce unnecessary complexity and operational burden that neither agents nor wallet operators really need.

### Server-side REST API or local CLI mode

The wallet exposes a very simple REST with verbose, intuitive names that hide ecash internals where possible. To make consuming the API by AI agents more natural, the ippon_mcp project provides an MCP server facade. Alternatively, operators or  AI agents can install and run Ippon in **CLI mode** (`INTERACTION_MODE=cli`) where the wallet is controlled through standard I/O commands — useful for AI agents that can install and spawn a local process instead of relying on a hosted instance.

### Short-term security guarantees
    
Wallet access relies on a bare-bones access_key generated by the wallet server at creation time and later passed in the request’s Authorization header as a Bearer token. Given the short wallet lifetime and the expectation that a new wallet is created and funded for each longer session, there is no need for token refresh or revocation. To minimize necessity for AI agents to keep secrets, MCP server safeguards wallet access_key, linking it to agent's session_id.

### Arbitrary limits on wallets, balances and transactions
    
Due to the above constraints, the primary safeguard is a combination of rate limiting and of strict limits on maximum wallet balance and payment amounts. Limits are double-tiered:

-   Global limits set by the wallet operator on number of created wallets per ip address, max wallet balance and max ecash or lightning payment
    
-   Optional per-wallet balance and payment limits defined at wallet creation time. This prevents funding or outgoing payments from exceeding intended task scope.
    

## Server mode - REST API

The API isto be used in server-side deployments and is versioned under `/v1/`, using standard HTTP methods with JSON payloads.  
All authenticated endpoints require a `Bearer access_key` in the `Authorization` header (except wallet creation and public info).

### GET /v1/info

Returns machine-readable information about the wallet service, including status, supported unit, mint URL, and global limits (balance/payment caps and rate limits).

| Authorization | Request Type | Response Type |
|---------------|--------------|---------------|
| N/A           | N/A          | InfoResponse  |

**Example:**
```bash
curl -X GET http://localhost:3001/v1/info
 ```

### POST /v1/wallet

Creates a new short-lived wallet. Optionally accepts an initial Cashu token to fund it immediately or a name for identification.

| Authorization | Request Type        | Response Type  |
|---------------|---------------------|----------------|
| N/A           | WalletCreateRequest | WalletResponse |

**Example:**
```bash
curl -X POST http://localhost:3001/v1/wallet \
  -H "Content-Type: application/json" \
  -d '{"name": "agent-007-session-001", "token": "cashuBeyJ..."}'
```

### GET /v1/wallet

Retrieves details of the current wallet, including its name, unit, mint, confirmed balance, and pending balance. Any pending proofs are checked against the mint first and their state updated before the balances are returned.

| Authorization          | Request Type | Response Type  |
|------------------------|--------------|----------------|
| Bearer access_key      | N/A          | WalletResponse |

**Example:**
```bash
curl -X GET http://localhost:3001/v1/wallet \
  -H "Authorization: Bearer abc123_access_key"
```

### POST /v1/wallet/deposit

Requests a Lightning invoice for funding the wallet with a specified amount. The wallet automatically handles the mint quote and ecash issuance once the invoice is paid.

| Authorization          | Request Type             | Response Type              |
|------------------------|--------------------------|----------------------------|
| Bearer access_key      | WalletDepositRequest     | WalletDepositResponse      |

**Example:**
```bash
curl -X POST http://localhost:3001/v1/wallet/deposit \
  -H "Authorization: Bearer abc123_access_key" \
  -H "Content-Type: application/json" \
  -d '{"amount": 10000, "unit": "msat"}'
```

### GET /v1/wallet/deposit/:quote

Checks the status of a previously requested deposit quote (e.g., whether the invoice was paid and ecash minted).

| Authorization          | Request Type | Response Type              |
|------------------------|--------------|----------------------------|
| Bearer access_key      | N/A          | WalletDepositResponse      |

**Example:**
```bash
curl -X GET http://localhost:3001/v1/wallet/deposit/quote_abc123xyz \
  -H "Authorization: Bearer abc123_access_key"
 ```

### POST /v1/wallet/send

Generates and exports an ecash token for a specific amount (or pays a Cashu payment request if provided). The wallet handles any necessary swaps and marks proofs as pending to prevent double-spending.
Potential mint fees are fully paid by the sender (including fees paid by the
receiver when swapping the received token for fresh one).
Optionally allows locking the token to a specific receiver's pubkey to prevent unauthorized party to steal it.

| Authorization          | Request Type      | Response Type       |
|------------------------|-------------------|---------------------|
| Bearer access_key      | WalletSendRequest | WalletSendResponse  |

**Example:**
```bash
curl -X POST http://localhost:3001/v1/wallet/send \
  -H "Authorization: Bearer abc123_access_key" \
  -H "Content-Type: application/json" \
  -d '{"amount": 5000, "unit": "msat", "memo": "Complete this task for me"}'
```

### POST /v1/wallet/check

Checks the current state of an exported Cashu token (e.g., whether it has been spent/swapped by the recipient).

| Authorization          | Request Type       | Response Type        |
|------------------------|--------------------|----------------------|
| Bearer access_key      | WalletCheckRequest | WalletCheckResponse  |

**Example:**
```bash
curl -X POST http://localhost:3001/v1/wallet/check \
  -H "Authorization: Bearer abc123_access_key" \
  -H "Content-Type: application/json" \
  -d '{"token": "cashuB..."}'
```

### POST /v1/wallet/decode

Decodes a Cashu token, Cashu payment request, or Lightning invoice and returns structured information.

| Authorization          | Request Type        | Response Type         |
|------------------------|---------------------|-----------------------|
| Bearer access_key      | WalletDecodeRequest | WalletDecodeResponse  |

**Example:**
```bash
curl -X POST http://localhost:3001/v1/wallet/decode \
  -H "Authorization: Bearer abc123_access_key" \
  -H "Content-Type: application/json" \
  -d '{"type": "CASHU_TOKEN_V4", "data": "cashuB..."}'
```

### POST /v1/wallet/pay

Pays an external Lightning invoice (or Lightning address) using the wallet's ecash balance. The wallet handles melt quote, fees, and returns any change.

| Authorization          | Request Type     | Response Type      |
|------------------------|------------------|--------------------|
| Bearer access_key      | WalletPayRequest | WalletPayResponse  |

**Example:**
```bash
curl -X POST http://localhost:3001/v1/wallet/pay \
  -H "Authorization: Bearer abc123_access_key" \
  -H "Content-Type: application/json" \
  -d '{"bolt11_request": "lnbc50u...", "amount": 5000, "unit": "msat"}'
```

### GET /v1/wallet/pay/:quote

Checks the status of a melt quote / payment operation (e.g., whether the invoice was successfully paid).

| Authorization          | Request Type | Response Type      |
|------------------------|--------------|--------------------|
| Bearer access_key      | N/A          | WalletPayResponse  |

**Example:**
```bash
curl -X GET http://localhost:3001/v1/wallet/pay/etkpOx_SLLNEMOX2oEyk6y1ePKVp9sdUxc3k03bI \
  -H "Authorization: Bearer abc123_access_key"
```

### POST /v1/wallet/receive

Imports and processes an external Cashu token. The wallet validates token with the mint, and swaps it for a new ecash token.

| Authorization          | Request Type         | Response Type          |
|------------------------|----------------------|------------------------|
| Bearer access_key      | WalletReceiveRequest | WalletReceiveResponse  |

**Example:**
```bash
curl -X POST http://localhost:3001/v1/wallet/receive \
  -H "Authorization: Bearer abc123_access_key" \
  -H "Content-Type: application/json" \
  -d '{"token": "cashuB..."}'
```

### GET /v1/rate/:currency

Returns the current fiat exchange rate for the wallet's unit (e.g., satoshis per USD).

| Authorization          | Request Type | Response Type  |
|------------------------|--------------|----------------|
| Bearer access_key      | N/A          | RateResponse   |

**Example:**
```bash
curl -X GET http://localhost:3001/v1/rate/USD \
  -H "Authorization: Bearer abc123_access_key"
```

## API Reference

The full interactive API reference — including all request bodies, response schemas, and enum values — is served directly by the running Ippon instance:

- **Swagger UI** (interactive): `GET /v1/`
- **Raw OpenAPI 3.0 JSON**: `GET /v1/json`

The spec is generated at runtime from the route definitions and is always in sync with the code.

All request and response TypeScript types used in the route tables above are defined in [`src/routes/routeTypes.ts`](src/routes/routeTypes.ts).

> **Note on amounts:** Despite the wallet operating with a single unit, amounts are always declared together with `unit` to keep values unambiguous (`unit` must always equal the wallet's configured `MintUnit`).


## Local mode - CLI commands

CLI mode is intended for **local, self-hosted use** — typically by an AI agent that installs Ippon and interacts with it via standard I/O instead of HTTP. Data is stored in a local SQLite file; no PostgreSQL or network server is required.

### How it works

- `INTERACTION_MODE=cli` — starts a readline REPL instead of an HTTP server.
- `DATABASE_ENGINE=sqlite` — stores data in a local file (`DATABASE_FILE_PATH`, default `~/.ippon/database.sqlite`).
- **All responses are JSON lines on stdout**; the prompt (`> `) and info messages go to stderr so they don't interfere with programmatic parsing.
- Wallet access keys are short 6-character alphanumeric strings displayed as `xxx-xxx` (e.g. `adg-08m`). Both formats (`adg08m` and `adg-08m`) are accepted as input.

### Quick start

```bash
# 1. Install dependencies
yarn install

# 2. Copy and configure environment
cp .env.example .env
# Set DATABASE_ENGINE=sqlite, INTERACTION_MODE=cli, MINT_URLS, UNIT, limits, etc.

# 3. Build
yarn build

# 4. Set up SQLite schema (run once, and again after switching engines)
yarn db:setup

# 5. Start the CLI
DATABASE_ENGINE=sqlite INTERACTION_MODE=cli node dist/index.js
# or, combining steps 4 and 5:
yarn start:local
```

### Commands

All commands are typed at the `> ` prompt (or piped via stdin). Every response is a single JSON object on stdout.

| Command | Description |
|---|---|
| `info` | Service info: mints, unit, global limits, and the split-payment adapter contract |
| `wallet create [name] [mint_url]` | Create a new wallet; mint must be in `MINT_URLS`; prints `access_key` |
| `wallet list` | List all wallets with balances |
| `wallet <key> balance` | Show wallet balance and details; auto-syncs pending proofs with the mint first |
| `wallet <key> deposit <amount>` | Create a Lightning invoice to fund the wallet |
| `wallet <key> deposit-check <quote_id>` | Check deposit status; auto-mints ecash when paid |
| `wallet <key> send <amount> [lock_pubkey]` | Export a Cashu token (optionally P2PK-locked) |
| `wallet <key> receive <token>` | Import a Cashu token |
| `wallet <key> pay-prepare <intent_id> <bolt11>` | Create and persist a quote and exact proof plan without paying |
| `wallet <key> pay-execute <intent_id> <invoice_sha256> <quote_sha256> <proof_plan_sha256>` | Execute the approved, unchanged plan once |
| `wallet <key> pay-status <intent_id>` | Reconcile quote and proof states without retrying the melt |
| `wallet <key> sync` | Sync pending proofs with the mint |
| `restore-audit <mint_url>` | Check every proof for one allowlisted mint in a restored DB against NUT-07 without changing wallet state or exposing the access key |
| `decode <data>` | Decode a Cashu token, Cashu request, or BOLT11 invoice |
| `help` | Show available commands |
| `exit` | Quit |

### Example session

```
> wallet create agent-session-1
{"access_key":"adg-08m","name":"agent-session-1","mint":"https://mint.minibits.cash/Bitcoin","unit":"sat","balance":0,"pending_balance":0}

> wallet adg-08m deposit 100
{"quote":"abc123...","request":"lnbc1000n...","state":"UNPAID","expiry":1234567890}

> wallet adg-08m deposit-check abc123...
{"quote":"abc123...","request":"lnbc1000n...","state":"PAID","expiry":1234567890}

> wallet adg-08m balance
{"access_key":"adg-08m","name":"agent-session-1","mint":"https://mint.minibits.cash/Bitcoin","unit":"sat","balance":100,"pending_balance":0}

> wallet adg-08m pay-prepare wallet_0123456789abcdef01234567 lnbc500n...
{"intent_id":"wallet_0123456789abcdef01234567","state":"PREPARED","amount":50,"fee_reserve":1,"input_fee":1,"max_spend":52,"expiry":1234567890,"payment_hash":"...","invoice_sha256":"...","quote_sha256":"...","proof_plan_sha256":"..."}

> wallet adg-08m pay-execute wallet_0123456789abcdef01234567 <invoice_sha256> <quote_sha256> <proof_plan_sha256>
{"intent_id":"wallet_0123456789abcdef01234567","state":"PAID","quote_state":"PAID","proof_states":["SPENT"],"payment_preimage":"...","error_code":null}
```

The prepare response deliberately omits the raw quote ID, invoice, proofs, and change outputs.
Those values stay in the private Ippon database. The three hashes must be bound to an external
approval before `pay-execute` is called. The legacy one-shot `pay` and raw-ID `pay-check` commands
return `UNSAFE_OPERATION`.

### Piping commands (non-interactive)

Each command can be piped as a single stdin line; the process exits cleanly after completing it:

```bash
# Create a wallet and capture the access key
KEY=$(echo "wallet create bot" | DATABASE_ENGINE=sqlite INTERACTION_MODE=cli LOG_LEVEL=error node dist/index.js 2>/dev/null \
  | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).access_key))")

# Receive a token
echo "wallet $KEY receive cashuB..." | DATABASE_ENGINE=sqlite INTERACTION_MODE=cli LOG_LEVEL=error node dist/index.js 2>/dev/null

# Payment is intentionally not a one-line pipe: call pay-prepare, bind its
# hashes to an external approval, and only then call pay-execute once.
```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_ENGINE` | Database backend: `postgresql` or `sqlite` | `postgresql` |
| `DATABASE_URL` | PostgreSQL connection string (required when `DATABASE_ENGINE=postgresql`) | — |
| `DATABASE_FILE_PATH` | SQLite file path, supports `~` expansion (used when `DATABASE_ENGINE=sqlite`) | `~/.ippon/database.sqlite` |
| `INTERACTION_MODE` | Runtime mode: `api` (HTTP server) or `cli` (stdio REPL) | `api` |
| `PORT` | HTTP server port (API mode only) | `3001` |
| `LOG_LEVEL` | Log verbosity (`trace`, `debug`, `info`, `warn`, `error`) | `debug` |
| `MINT_URLS` | Comma-separated list of supported Cashu mint URLs. First entry is the default. | — |
| `UNIT` | Wallet unit (`sat` or `msat`) | `sat` |
| `MAX_BALANCE` | Global max wallet balance (in unit) | `100000` |
| `MAX_SEND` | Global max ecash send amount | `50000` |
| `MAX_PAY` | Global max Lightning payment amount | `50000` |
| `SERVICE_STATUS` | Status string returned by `/v1/info` (API mode only) | `operational` |
| `SERVICE_HELP` | Help URL returned by `/v1/info` (API mode only) | — |
| `SERVICE_TERMS` | Terms URL returned by `/v1/info` (API mode only) | — |
| `RATE_LIMIT_MAX` | Default max requests per window (API mode only) | `100` |
| `RATE_LIMIT_CREATE_WALLET_MAX` | Max wallet creations per window per IP (API mode only) | `3` |
| `RATE_LIMIT_WINDOW` | Rate-limit time window (API mode only) | `1 minute` |

All configured values are printed to **stderr** at startup regardless of mode, making it easy to verify the active configuration.


## Development

Minibits Ippon is written in TypeScript and runs on Node.js (v24+). It uses Fastify as the HTTP server and Prisma ORM with either PostgreSQL (API/server mode) or SQLite (CLI/local mode).

### Prerequisites

**Server REST API mode**
- Node.js v24+
- PostgreSQL
- A running Cashu mint

**Local CLI mode**
- Node.js v24+
- A running Cashu mint (public mints work; no self-hosted infrastructure needed)

### Setup

#### Server REST API mode (PostgreSQL)

```bash
yarn install
cp .env.example .env
# Edit .env: set DATABASE_ENGINE=postgresql, DATABASE_URL, INTERACTION_MODE=api, MINT_URLS, etc.

yarn db:setup     # copies schema, runs prisma generate + db push
yarn build
yarn start:prod
```

#### Local CLI mode (SQLite)

```bash
yarn install
cp .env.example .env
# Edit .env: set DATABASE_ENGINE=sqlite, INTERACTION_MODE=cli, MINT_URLS, etc.
# DATABASE_FILE_PATH defaults to ~/.ippon/database.sqlite

yarn db:setup     # creates ~/.ippon/, copies schema, runs prisma generate + db push
yarn build
yarn start:local  # db:setup + CLI start combined
```

> **Switching engines:** re-run `yarn db:setup` after changing `DATABASE_ENGINE`. This regenerates the Prisma client for the new engine.

### Running

```bash
# Development (auto-reload, reads INTERACTION_MODE from .env)
yarn start:dev

# Production build
yarn build

# Production start (API or CLI depending on .env)
yarn start:prod

# One-shot local CLI (sets up SQLite and starts the REPL)
yarn start:local
```

### Testing

The test suite uses [Vitest](https://vitest.dev/) and covers three layers:

| File | Scope |
|---|---|
| `src/__tests__/nostrService.test.ts` | Unit — pubkey normalisation (npub / x-only hex / compressed hex) |
| `src/__tests__/walletService.test.ts` | Unit — `WalletService` methods with Prisma and cashu-ts mocked |
| `src/__tests__/splitMeltService.test.ts` | Unit — prepare/execute separation, restart recovery, reconciliation, and failure injection |
| `src/__tests__/publicRoutes.test.ts` | Integration — unauthenticated routes (`GET /v1/info`, `POST /v1/wallet`) |
| `src/__tests__/protectedRoutes.test.ts` | Integration — all authenticated routes via Fastify `inject()` |

```bash
# Run once
yarn test

# Watch mode
yarn test:watch
```

All external I/O (Prisma, cashu-ts `Wallet`, token encoding, fetch) is mocked; no database or mint connection is required.

### MCP server

The companion [minibits_ippon_mcp](https://github.com/minibits-cash/minibits_ippon_mcp) project provides an MCP server that wraps the wallet API for AI agent integration. It manages session lifecycle and safeguards the wallet access key so that agents never handle it directly.

## TO-DO's

- [x] lock token to pubkey
- [ ] pay cashu payment request
- [ ] add transactions model and API
