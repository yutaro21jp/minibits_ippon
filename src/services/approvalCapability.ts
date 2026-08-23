import crypto from 'crypto'

const BASE64URL = /^[A-Za-z0-9_-]+$/

export type ApprovalOperation = 'pay' | 'receive'

export type ApprovalPayload = {
    version: 1
    operation: ApprovalOperation
    wallet_sha256: string
    intent_id: string
    amount: number
    max_spend: number
    expires_at: number
    invoice_sha256: string
    quote_sha256: string
    plan_sha256: string
}

export class ApprovalCapabilityError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message)
        this.name = 'ApprovalCapabilityError'
    }
}

function publicKeyFromEnvironment(): crypto.KeyObject {
    const configured = process.env.IPPON_APPROVAL_PUBLIC_KEY?.trim()
    if (!configured) {
        throw new ApprovalCapabilityError(
            'APPROVAL_NOT_CONFIGURED',
            'IPPON_APPROVAL_PUBLIC_KEY is required before approved operations can execute',
        )
    }

    try {
        let key: crypto.KeyObject
        if (configured.startsWith('-----BEGIN PUBLIC KEY-----')) {
            key = crypto.createPublicKey(configured.replace(/\\n/g, '\n'))
        } else {
            if (!BASE64URL.test(configured)) throw new Error('non-canonical base64url')
            const decoded = Buffer.from(configured, 'base64url')
            if (decoded.toString('base64url') !== configured) throw new Error('non-canonical base64url')
            key = crypto.createPublicKey({ key: decoded, format: 'der', type: 'spki' })
        }
        if (key.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519')
        return key
    } catch {
        throw new ApprovalCapabilityError(
            'INVALID_APPROVAL_CONFIG',
            'IPPON_APPROVAL_PUBLIC_KEY must be an Ed25519 public key in PEM or base64url SPKI form',
        )
    }
}

export function approvalKeyConfigured(): boolean {
    try {
        publicKeyFromEnvironment()
        return true
    } catch {
        return false
    }
}

export function buildApprovalPayload(input: Omit<ApprovalPayload, 'version'>): string {
    return JSON.stringify({
        version: 1,
        operation: input.operation,
        wallet_sha256: input.wallet_sha256,
        intent_id: input.intent_id,
        amount: input.amount,
        max_spend: input.max_spend,
        expires_at: input.expires_at,
        invoice_sha256: input.invoice_sha256,
        quote_sha256: input.quote_sha256,
        plan_sha256: input.plan_sha256,
    } satisfies ApprovalPayload)
}

export function walletApprovalId(accessKey: string): string {
    return crypto.createHash('sha256').update(accessKey, 'utf8').digest('hex')
}

export function verifyApprovalSignature(payload: string, signature: string): void {
    if (!BASE64URL.test(signature)) {
        throw new ApprovalCapabilityError('INVALID_APPROVAL', 'The approval signature is invalid')
    }
    const decoded = Buffer.from(signature, 'base64url')
    if (decoded.length !== 64 || decoded.toString('base64url') !== signature) {
        throw new ApprovalCapabilityError('INVALID_APPROVAL', 'The approval signature is invalid')
    }

    if (!crypto.verify(null, Buffer.from(payload, 'utf8'), publicKeyFromEnvironment(), decoded)) {
        throw new ApprovalCapabilityError(
            'INVALID_APPROVAL',
            'The approval signature does not authorize this exact operation',
        )
    }
}
