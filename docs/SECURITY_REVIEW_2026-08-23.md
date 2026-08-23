# Security review and hardening — 2026-08-23

This document records the repository-wide static review performed against
baseline commit `44077f844ba0f1bfc83fc6aab08461925b417677` and the mitigations applied
afterward. It is not a production certification, funded-wallet test, or live
mint assessment.

## Material changes

- Replaced self-asserted approval hashes with a detached Ed25519 execution
  capability. The signature binds wallet, operation, intent, invoice, private
  quote, proof/output plan, amount, maximum effect, and expiry.
- Disabled one-step CLI ecash send/import operations until they have the same
  durable prepare/approve/execute/reconcile model.
- Permanently disabled inherited one-step REST value mutations, raw quote
  status, and initial-token import. There is no operator flag that reopens
  quote-ownership, deferred-cap, or partial-swap cleanup hazards.
- Removed server-side Lightning-address resolution to eliminate its untrusted
  URL-fetch/SSRF surface. Callers must resolve an address in a trusted client
  and submit BOLT11.
- Made API rate limiting global and changed proxy trust from unconditional to
  `false` or an explicit IP/CIDR allowlist.
- Clamped requested wallet limits to operator limits and rejected invalid
  non-positive configurations.
- Bound locked receive invoices to their exact requested amount, serialized
  receive-cap reservations, and prevented reconciliation from regressing a
  terminal issued state to unknown.
- Enforced signed receive expiry at execution, clamped split-receive balances
  to the global default/operator cap, and made paid split-payment state
  terminal across later status outages.
- Applied `MAX_PAY` to the complete prepared wallet effect: invoice amount,
  mint fee reserve, and selected-proof input fees.
- Replaced new six-character CLI access keys with 256-bit random credentials.
- Enforced private SQLite path checks in the runtime as well as setup, and
  replaced regex database-URL masking with structured credential/query
  removal.

## Remaining boundaries

- Cashu is bearer ecash and a configured mint remains a trust and availability
  dependency. Use short-lived wallets and amounts that can be lost.
- REST remains an inspection surface only for this fork. Registered inherited
  mutation and raw quote-status endpoints fail closed with `403`.
- The split adapters cover Lightning pay and locked Lightning receive. Direct
  ecash export/import stays disabled rather than claiming incomplete safety.
- Unknown external outcomes require status-only reconciliation. Never
  automatically retry an operation whose request may have reached a mint.
- A separate independent review and disposable funded/regtest validation are
  still appropriate before production use.

## Verification performed

The standard mocked suite covers signed-capability tampering, exact plan and
amount checks, execution races, ambiguous response recovery, private SQLite
paths, API defaults, and the approval helper. At handoff, all 96 tests and the
TypeScript/bundled build passed, and the locked production dependency audit
reported no known vulnerabilities. No real funds or public-mint writes were
used for this review.
