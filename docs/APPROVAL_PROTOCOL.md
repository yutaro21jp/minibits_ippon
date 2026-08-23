# Ed25519 approval protocol

The local CLI uses a detached Ed25519 signature as an execution capability.
Comparing hashes is not approval: an agent that can call both `prepare` and
`execute` could otherwise approve its own proposal.

## Trust boundary

The wallet process receives only an Ed25519 public key through
`IPPON_APPROVAL_PUBLIC_KEY`. The private key belongs in a separate trusted
process, device, or policy service that reviews the proposed operation. Do not
put the private key in the wallet's `.env`, container, agent workspace, command
line, or logs.

`pay-prepare` and `receive-prepare` return an `approval_payload` string. It is
canonical compact JSON with these fields in this exact order:

```text
version, operation, wallet_sha256, intent_id, amount, max_spend, expires_at,
invoice_sha256, quote_sha256, plan_sha256
```

The payload binds the permission to one wallet, operation type, intent, amount,
maximum economic effect, expiry, invoice, private mint quote, and persisted
proof/output plan. The signer signs the exact UTF-8 bytes of this string and
returns the 64-byte Ed25519 signature encoded as unpadded base64url. Any change
to the plan, wallet, amount, or expiry invalidates the signature.

## Local setup helper

Generate a key pair into two new files (existing files are never overwritten):

```bash
node scripts/approval-tool.mjs generate \
  /secure/path/approval-private.pem \
  /secure/path/approval-public.txt
```

The private file is mode `0600`. Configure the wallet with the single-line
value from `approval-public.txt`:

```bash
IPPON_APPROVAL_PUBLIC_KEY='<base64url-spki-public-key>'
```

After independently reviewing an unexpired `approval_payload`, the trusted
signer can produce a signature without placing the private key in the wallet:

```bash
node scripts/approval-tool.mjs sign /secure/path/approval-private.pem \
  < approval-payload.json
```

Pass the resulting signature as the final argument to `pay-execute` or
`receive-execute`. The helper validates the payload shape and refuses expired
payloads, but it is not a policy engine: the trusted side must still decide
whether the amount, destination, purpose, mint, and limits are acceptable.

## Rotation and recovery

Changing `IPPON_APPROVAL_PUBLIC_KEY` intentionally invalidates signatures made
with the old key. Prepared operations can still be inspected or allowed to
expire; do not bypass verification or recreate an already-attempted intent.
After an uncertain external result, use only the matching status command until
the operation reaches a supported terminal state.
