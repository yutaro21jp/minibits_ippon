# Contributing

Thank you for helping improve Minibits Ippon.

## Development setup

Use Node.js 24 and Yarn 1.22. Install the locked dependencies:

```bash
corepack enable
yarn install --frozen-lockfile
```

Do not place real wallet proofs, keys, access tokens, invoices, or funded
databases in the repository or test fixtures. Use fake values and disposable
local wallets.

## Required checks

Run the complete standard check set before opening a pull request:

```bash
yarn run verify
git diff --check
```

The two-mint fault drill is optional because it requires a separate Nutshell
checkout and starts loopback services. Follow the exact acknowledgement and
limits documented in the README; never substitute a public mint or real sats.

## Pull requests

- Keep changes narrow and explain the safety boundary they affect.
- Add tests for success, rejection, restart, and ambiguous-result paths when
  changing wallet operations.
- Preserve fail-closed behavior: an unknown external result is reconciled, not
  retried.
- Preserve the signer boundary: wallet/agent runtimes receive only the approval
  public key, never the signing private key.
- Update public documentation when a command or response contract changes.
- Sign off commits with `git commit --signoff` to certify the Developer
  Certificate of Origin.

Security reports belong in the private channel described in
[`SECURITY.md`](SECURITY.md), not in a pull request or public issue.
