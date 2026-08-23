import crypto from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
    ApprovalCapabilityError,
    approvalKeyConfigured,
    buildApprovalPayload,
    verifyApprovalSignature,
    walletApprovalId,
} from '../services/approvalCapability'

const originalPublicKey = process.env.IPPON_APPROVAL_PUBLIC_KEY

afterEach(() => {
    if (originalPublicKey === undefined) delete process.env.IPPON_APPROVAL_PUBLIC_KEY
    else process.env.IPPON_APPROVAL_PUBLIC_KEY = originalPublicKey
})

function payload(): string {
    return buildApprovalPayload({
        operation: 'pay',
        wallet_sha256: walletApprovalId('wallet-secret'),
        intent_id: 'wallet_0123456789abcdef01234567',
        amount: 100,
        max_spend: 107,
        expires_at: 2_000_003_600,
        invoice_sha256: '11'.repeat(32),
        quote_sha256: '22'.repeat(32),
        plan_sha256: '33'.repeat(32),
    })
}

describe('approvalCapability', () => {
    it('verifies an Ed25519 signature over the exact canonical payload', () => {
        const keys = crypto.generateKeyPairSync('ed25519')
        process.env.IPPON_APPROVAL_PUBLIC_KEY = keys.publicKey
            .export({ type: 'spki', format: 'der' })
            .toString('base64url')
        const approval = payload()
        const signature = crypto.sign(null, Buffer.from(approval), keys.privateKey).toString('base64url')

        expect(() => verifyApprovalSignature(approval, signature)).not.toThrow()
        expect(approvalKeyConfigured()).toBe(true)
    })

    it('rejects a signature after any approved field changes', () => {
        const keys = crypto.generateKeyPairSync('ed25519')
        process.env.IPPON_APPROVAL_PUBLIC_KEY = keys.publicKey
            .export({ type: 'spki', format: 'der' })
            .toString('base64url')
        const approval = payload()
        const signature = crypto.sign(null, Buffer.from(approval), keys.privateKey).toString('base64url')

        expect(() => verifyApprovalSignature(approval.replace('"amount":100', '"amount":101'), signature))
            .toThrow(ApprovalCapabilityError)
    })

    it('rejects non-canonical base64url signatures', () => {
        const keys = crypto.generateKeyPairSync('ed25519')
        process.env.IPPON_APPROVAL_PUBLIC_KEY = keys.publicKey
            .export({ type: 'spki', format: 'der' })
            .toString('base64url')
        const approval = payload()
        const signature = crypto.sign(null, Buffer.from(approval), keys.privateKey).toString('base64url')

        expect(() => verifyApprovalSignature(approval, `${signature}!`))
            .toThrow(ApprovalCapabilityError)
        expect(() => verifyApprovalSignature(approval, `${signature}=`))
            .toThrow(ApprovalCapabilityError)
    })

    it('fails closed when no approval key is configured', () => {
        delete process.env.IPPON_APPROVAL_PUBLIC_KEY
        expect(() => verifyApprovalSignature(payload(), Buffer.alloc(64).toString('base64url')))
            .toThrow('IPPON_APPROVAL_PUBLIC_KEY is required')
        expect(approvalKeyConfigured()).toBe(false)
    })
})
