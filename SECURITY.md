# Security Policy

## Supported version

Only the latest commit on `main` receives security fixes. This project is
experimental alpha software, not a production-ready consumer wallet. Use
disposable wallets and only amounts you can afford to lose.

## Reporting a vulnerability

Do not disclose a vulnerability, wallet proof, private key, access key,
invoice, or database in a public issue.

Use GitHub's private vulnerability reporting for this repository when it is
available. If it is unavailable, open a public issue containing no sensitive
details and ask the maintainer for a private reporting channel.

Include the affected commit, deployment mode, reproduction steps using fake or
local-regtest funds, expected behavior, actual behavior, and the security
impact. You may redact values while preserving their format and length.

There is currently no bug-bounty program or guaranteed response time. Reports
will be acknowledged and triaged as maintainer availability permits.

## Scope reminders

- The signed approval-gated split payment and receive adapters cover local CLI
  mode, not the REST API. The signer private key must be isolated from both the
  wallet and proposing agent.
- One-step REST value mutations, raw quote-status routes, and initial token
  import are permanently disabled. There is no compatibility flag that can
  bypass the signed local workflow.
- Server-side Lightning-address resolution is disabled. Resolve addresses in a
  trusted client and submit the resulting BOLT11 invoice.
- A timed-out payment or issuance must be reconciled with status commands; it
  must never be blindly retried.
- The opt-in regtest must use loopback FakeWallet mints and disposable data.
- Never test against someone else's mint or funds without explicit permission.
