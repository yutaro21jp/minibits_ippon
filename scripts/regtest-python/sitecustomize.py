"""Test-only patch for standards-valid FakeWallet preimages.

Nutshell's FakeWallet intentionally creates self-contained fake invoices. Its
test secret is hashed as UTF-8 when building the invoice, while real BOLT11
preimages are hashed as 32 raw bytes. This narrowly patches invoice creation in
the explicitly acknowledged local process so Ippon's real preimage verifier can
be exercised without Lightning, testnet coins, or mainnet sats.
"""

import hashlib as _real_hashlib
import os

if os.environ.get("IPPON_NUTSHELL_REGTEST_ACK") == "local-regtest-fake-ecash-only":
    import cashu.lightning.fake as _fake

    _original_create_invoice = _fake.FakeWallet.create_invoice
    _create_preimage = os.environ.get("IPPON_NUTSHELL_CREATE_PREIMAGE", "")
    _extra_preimages = os.environ.get("IPPON_NUTSHELL_EXTRA_PREIMAGES", "")

    for _preimage in filter(None, [_create_preimage, *_extra_preimages.split(",")]):
        if len(_preimage) != 64:
            raise RuntimeError("Regtest preimages must be 32-byte hex strings")
        _payment_hash = _real_hashlib.sha256(bytes.fromhex(_preimage)).hexdigest()
        _fake.FakeWallet.payment_secrets[_payment_hash] = _preimage

    class _CreateInvoiceHashlib:
        def __getattr__(self, name):
            return getattr(_real_hashlib, name)

        @staticmethod
        def sha256(data=b""):
            if isinstance(data, bytes) and len(data) == 64:
                try:
                    return _real_hashlib.sha256(bytes.fromhex(data.decode("ascii")))
                except (UnicodeDecodeError, ValueError):
                    pass
            return _real_hashlib.sha256(data)

    async def _create_invoice_with_standard_preimage(self, *args, **kwargs):
        if _create_preimage:
            kwargs["payment_secret"] = bytes.fromhex(_create_preimage)
        original_hashlib = _fake.hashlib
        _fake.hashlib = _CreateInvoiceHashlib()
        try:
            return await _original_create_invoice(self, *args, **kwargs)
        finally:
            _fake.hashlib = original_hashlib

    _fake.FakeWallet.create_invoice = _create_invoice_with_standard_preimage
