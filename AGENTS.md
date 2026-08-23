# Agent contribution guide

This repository is an experimental wallet engine. Treat every wallet mutation
as an external financial effect even when a test normally uses fake funds.

## Safe working boundary

- Never use real proofs, funded wallets, production databases, credentials, or
  public-mint writes while developing or testing.
- The standard test suite must stay fully mocked. Live-protocol tests are
  opt-in, loopback-only, disposable, and bounded by their documented
  acknowledgement variables.
- Do not retry a payment, swap, or mint after an ambiguous response. Persist the
  outcome as unknown and reconcile it through the relevant status path.
- Keep approval signing keys outside the wallet and agent runtime. The wallet
  receives only `IPPON_APPROVAL_PUBLIC_KEY`.
- Do not weaken amount, expiry, mint, wallet, quote, proof/output-plan, or
  execution-count bindings to make an integration easier.
- Do not expose access keys, quote IDs, proofs, recovery material, database
  URLs, or approval private keys in logs, fixtures, commits, or issues.

## Required workflow

1. Read `README.md`, `SECURITY.md`, and `docs/APPROVAL_PROTOCOL.md` before
   changing a wallet operation.
2. Add rejection and ambiguous-result tests as well as the success path.
3. Run `yarn run verify` and `git diff --check`.
4. Keep changes narrowly staged. Do not push, publish, deploy, access a live
   mint, or use real funds without the repository owner's explicit approval.

Preserve unrelated working-tree changes and keep all public documentation
generic: this repository must not disclose private downstream products,
deployments, paths, credentials, balances, or integration details.
