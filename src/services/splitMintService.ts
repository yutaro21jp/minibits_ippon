import crypto from 'crypto'
import {
    Amount,
    MintPreview,
    MintQuoteBolt11Response,
    MintQuoteState,
    OutputData,
    Proof,
    SerializedOutputData,
    sumProofs,
} from '@cashu/cashu-ts'
import {
    MintOperation,
    MintOperationState,
    Prisma,
    ProofStatus,
    Wallet as StoredWallet,
} from '@prisma/client'
import { decode as decodeBolt11 } from '@gandlaf21/bolt11-decode'
import prisma from '../utils/prismaClient'
import { WalletService } from './walletService'
import {
    ApprovalCapabilityError,
    buildApprovalPayload,
    verifyApprovalSignature,
    walletApprovalId,
} from './approvalCapability'

const INTENT_ID = /^wallet_[0-9a-f]{24}$/
const HASH_HEX = /^[0-9a-f]{64}$/
const SCHNORR_HEX = /^[0-9a-f]{128}$/
const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/
const MAX_BOUNDARY_AMOUNT = Amount.from(2_147_483_647)
const MAX_INVOICE_LENGTH = 8_192

type ReceiveHashes = {
    invoiceSha256: string
    quoteSha256: string
    outputPlanSha256: string
}

type ReceiveEvidence = {
    intent_id: string
    state: string
    quote_state: string | null
    amount: number
    expiry: number | null
    request: string | null
    invoice_sha256: string | null
    quote_sha256: string | null
    output_plan_sha256: string | null
    proofs_issued: number
    balance: number | null
    error_code: string | null
    approval_payload?: string
}

export class SplitMintError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message)
        this.name = 'SplitMintError'
    }
}

function fail(code: string, message: string): never {
    throw new SplitMintError(code, message)
}

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function boundaryNumber(value: Amount, field: string): number {
    if (value.lessThanOrEqual(Amount.zero()) || value.greaterThan(MAX_BOUNDARY_AMOUNT)) {
        fail('AMOUNT_OUT_OF_RANGE', `${field} is outside the supported integer range`)
    }
    return value.toNumber()
}

function effectiveMaxBalance(storedWallet: StoredWallet): Amount {
    const configured = Number(process.env.MAX_BALANCE ?? 100_000)
    if (
        !Number.isSafeInteger(configured)
        || configured <= 0
        || configured > MAX_BOUNDARY_AMOUNT.toNumber()
    ) {
        fail('INVALID_LIMIT_CONFIG', 'MAX_BALANCE must be a positive supported integer')
    }
    if (
        storedWallet.maxBalance !== null
        && (
            !Number.isSafeInteger(storedWallet.maxBalance)
            || storedWallet.maxBalance <= 0
        )
    ) {
        fail('INVALID_LIMIT_CONFIG', 'The stored wallet balance limit is invalid')
    }
    return Amount.from(
        storedWallet.maxBalance === null
            ? configured
            : Math.min(storedWallet.maxBalance, configured),
    )
}

function expiryNumber(value: bigint | null): number | null {
    if (value === null) return null
    const numeric = Number(value)
    if (!Number.isSafeInteger(numeric) || numeric <= 0) {
        fail('INVALID_OPERATION', 'Stored mint quote expiry is invalid')
    }
    return numeric
}

function generateQuoteKey(): { privkey: string, pubkey: string } {
    const ecdh = crypto.createECDH('secp256k1')
    ecdh.generateKeys()
    const privkey = ecdh.getPrivateKey().toString('hex').padStart(64, '0')
    const pubkey = ecdh.getPublicKey('hex', 'compressed')
    if (!HASH_HEX.test(privkey) || !COMPRESSED_PUBKEY.test(pubkey)) {
        fail('KEY_GENERATION_ERROR', 'A valid NUT-20 quote key could not be generated')
    }
    return { privkey, pubkey }
}

function validateInvoice(invoice: string, expectedAmount: number): void {
    if (
        invoice.length === 0
        || invoice.length > MAX_INVOICE_LENGTH
        || /\s/.test(invoice)
        || !invoice.toLowerCase().startsWith('lnbc')
    ) {
        fail('INVALID_MINT_QUOTE', 'The mint returned an invalid mainnet invoice')
    }
    try {
        const decoded = decodeBolt11(invoice)
        const amountSection = decoded.sections.find(item => item?.name === 'amount')
        if (typeof amountSection?.value !== 'string') {
            fail('INVALID_MINT_QUOTE', 'The mint invoice must contain an amount')
        }
        if (BigInt(amountSection.value) !== BigInt(expectedAmount) * 1_000n) {
            fail('INVALID_MINT_QUOTE', 'The mint invoice amount does not match the locked quote')
        }
    } catch (error) {
        if (error instanceof SplitMintError) throw error
        fail('INVALID_MINT_QUOTE', 'The mint invoice could not be decoded')
    }
}

function restoreOutputs(operation: MintOperation): OutputData[] {
    if (!operation.outputDataJson) fail('INVALID_OPERATION', 'Stored mint outputs are missing')
    try {
        const stored = JSON.parse(operation.outputDataJson) as SerializedOutputData[]
        if (!Array.isArray(stored) || stored.length === 0 || stored.length > 4_096) {
            throw new Error('invalid output list')
        }
        return stored.map(item => OutputData.deserialize(item))
    } catch {
        fail('INVALID_OPERATION', 'Stored mint outputs could not be restored')
    }
}

function restoredPreview(operation: MintOperation): MintPreview<{ quote: string }> {
    if (
        !operation.quoteId
        || !operation.keysetId
        || !operation.signature
        || !SCHNORR_HEX.test(operation.signature)
        || (operation.legacySignature !== null && !SCHNORR_HEX.test(operation.legacySignature))
    ) {
        fail('INVALID_OPERATION', 'Stored NUT-20 mint plan is incomplete')
    }
    const outputData = restoreOutputs(operation)
    return {
        method: 'bolt11',
        payload: {
            quote: operation.quoteId,
            outputs: outputData.map(item => item.blindedMessage),
            signature: operation.signature,
        },
        outputData,
        keysetId: operation.keysetId,
        quote: { quote: operation.quoteId },
        legacySignature: operation.legacySignature ?? undefined,
    }
}

function publicEvidence(
    operation: MintOperation,
    quoteState: string | null = operation.lastQuoteState,
    errorCode: string | null = operation.errorCode,
): ReceiveEvidence {
    return {
        intent_id: operation.intentId,
        state: operation.state,
        quote_state: quoteState,
        amount: operation.amount,
        expiry: expiryNumber(operation.expiry),
        request: operation.request,
        invoice_sha256: operation.invoiceSha256,
        quote_sha256: operation.quoteSha256,
        output_plan_sha256: operation.outputPlanSha256,
        proofs_issued: operation.proofsIssued,
        balance: operation.balanceAfter,
        error_code: errorCode,
    }
}

function approvalPayloadFor(operation: MintOperation, storedWallet: StoredWallet): string {
    const expiresAt = expiryNumber(operation.expiry)
    if (
        expiresAt === null
        || !operation.invoiceSha256
        || !operation.quoteSha256
        || !operation.outputPlanSha256
    ) {
        fail('INVALID_OPERATION', 'The stored receive approval plan is incomplete')
    }
    return buildApprovalPayload({
        operation: 'receive',
        wallet_sha256: walletApprovalId(storedWallet.accessKey),
        intent_id: operation.intentId,
        amount: operation.amount,
        max_spend: operation.amount,
        expires_at: expiresAt,
        invoice_sha256: operation.invoiceSha256,
        quote_sha256: operation.quoteSha256,
        plan_sha256: operation.outputPlanSha256,
    })
}

function quoteMismatchFields(
    operation: MintOperation,
    quote: MintQuoteBolt11Response,
): string[] {
    const mismatches: string[] = []
    try {
        if (quote.quote !== operation.quoteId) mismatches.push('quote')
        if (quote.request.toLowerCase() !== operation.request?.toLowerCase()) {
            mismatches.push('request')
        }
        if (quote.pubkey !== undefined && quote.pubkey !== operation.quotePubkey) {
            mismatches.push('pubkey')
        }
        if (quote.unit !== 'sat') mismatches.push('unit')
        if (!quote.amount.equals(operation.amount)) mismatches.push('amount')
        if (quote.expiry !== null && quote.expiry !== expiryNumber(operation.expiry)) {
            mismatches.push('expiry')
        }
    } catch {
        return ['invalid']
    }
    return mismatches
}

async function setUnknown(operation: MintOperation, code: string): Promise<MintOperation> {
    await prisma.mintOperation.updateMany({
        where: {
            intentId: operation.intentId,
            state: { notIn: [MintOperationState.ISSUED, MintOperationState.EXPIRED] },
        },
        data: {
            state: MintOperationState.UNKNOWN,
            errorCode: code,
            reconciledAt: new Date(),
        },
    })
    return prisma.mintOperation.findUniqueOrThrow({ where: { intentId: operation.intentId } })
}

async function saveIssuedProofs(
    operation: MintOperation,
    proofs: Proof[],
): Promise<MintOperation> {
    if (proofs.length === 0 || proofs.length > 4_096 || !sumProofs(proofs).equals(operation.amount)) {
        fail('INVALID_MINT_RESPONSE', 'Minted proofs do not match the approved receive amount')
    }
    return prisma.$transaction(async tx => {
        const current = await tx.mintOperation.findUniqueOrThrow({
            where: { intentId: operation.intentId },
        })
        if (current.state === MintOperationState.ISSUED) return current
        if (
            current.walletId !== operation.walletId
            || (
                current.state !== MintOperationState.EXECUTING
                && current.state !== MintOperationState.UNKNOWN
            )
        ) {
            fail('INVALID_OPERATION', 'The receive operation is not awaiting issued proofs')
        }
        for (const proof of proofs) {
            const expected = WalletService.proofStorageData(operation.walletId, proof, ProofStatus.UNSPENT)
            const existing = await tx.proof.findUnique({ where: { secret: proof.secret } })
            if (existing) {
                if (
                    existing.walletId !== expected.walletId
                    || existing.proofId !== expected.proofId
                    || existing.amount !== expected.amount
                    || existing.C !== expected.C
                    || existing.dleq !== expected.dleq
                    || existing.witness !== expected.witness
                    || existing.p2pkE !== expected.p2pkE
                    || existing.status !== ProofStatus.UNSPENT
                    || existing.reservedByIntentId !== null
                ) {
                    fail('PROOF_CONFLICT', 'Minted proof conflicts with an existing wallet proof')
                }
                continue
            }
            await tx.proof.create({ data: expected })
        }
        const balance = await tx.proof.aggregate({
            where: { walletId: operation.walletId, status: ProofStatus.UNSPENT },
            _sum: { amount: true },
        })
        return tx.mintOperation.update({
            where: { intentId: operation.intentId },
            data: {
                state: MintOperationState.ISSUED,
                lastQuoteState: MintQuoteState.ISSUED,
                errorCode: null,
                proofsIssued: proofs.length,
                balanceAfter: balance._sum.amount ?? 0,
                quotePrivkey: null,
                outputDataJson: null,
                signature: null,
                legacySignature: null,
                reconciledAt: new Date(),
            },
        })
    })
}

async function restoreIssuedProofs(
    operation: MintOperation,
    storedWallet: StoredWallet,
): Promise<Proof[]> {
    if (!operation.keysetId) fail('INVALID_OPERATION', 'Stored mint keyset is missing')
    const outputData = restoreOutputs(operation)
    const wallet = await WalletService.getWallet(storedWallet.mint)
    const restored = await wallet.mint.restore({
        outputs: outputData.map(item => item.blindedMessage),
    })
    if (restored.outputs.length !== restored.signatures.length) {
        fail('RESTORE_MISMATCH', 'Mint returned mismatched restored outputs and signatures')
    }
    const signatures = new Map<string, (typeof restored.signatures)[number]>()
    restored.outputs.forEach((output, index) => {
        if (signatures.has(output.B_)) fail('RESTORE_MISMATCH', 'Mint returned duplicate restored output')
        signatures.set(output.B_, restored.signatures[index])
    })
    await wallet.keyChain.ensureKeysetKeys(operation.keysetId)
    const keyset = wallet.getKeyset(operation.keysetId)
    return outputData.map(item => {
        const signature = signatures.get(item.blindedMessage.B_)
        if (!signature) fail('RESTORE_MISMATCH', 'Mint did not restore every issued output')
        return item.toProof(signature, keyset)
    })
}

async function prepare(
    storedWallet: StoredWallet,
    intentId: string,
    rawAmount: number,
): Promise<ReceiveEvidence> {
    if (!INTENT_ID.test(intentId)) fail('INVALID_INTENT_ID', 'The receive intent ID is invalid')
    if (!Number.isSafeInteger(rawAmount) || rawAmount <= 0 || rawAmount > MAX_BOUNDARY_AMOUNT.toNumber()) {
        fail('AMOUNT_OUT_OF_RANGE', 'The receive amount is outside the supported integer range')
    }
    const maxBalance = effectiveMaxBalance(storedWallet)

    const { privkey, pubkey } = generateQuoteKey()
    let operation = await prisma.$transaction(async tx => {
        const existing = await tx.mintOperation.findUnique({ where: { intentId } })
        if (existing) fail('DUPLICATE_INTENT', 'The receive intent already exists')
        const [available, pending, activeReceives] = await Promise.all([
            tx.proof.aggregate({
                where: { walletId: storedWallet.id, status: ProofStatus.UNSPENT },
                _sum: { amount: true },
            }),
            tx.proof.aggregate({
                where: { walletId: storedWallet.id, status: ProofStatus.PENDING },
                _sum: { amount: true },
            }),
            tx.mintOperation.aggregate({
                where: {
                    walletId: storedWallet.id,
                    state: {
                        in: [
                            MintOperationState.CREATING,
                            MintOperationState.PREPARED,
                            MintOperationState.PAID,
                            MintOperationState.EXECUTING,
                            MintOperationState.UNKNOWN,
                        ],
                    },
                },
                _sum: { amount: true },
            }),
        ])
        const projected = Amount.from(available._sum.amount ?? 0)
            .add(Amount.from(pending._sum.amount ?? 0))
            .add(Amount.from(activeReceives._sum.amount ?? 0))
            .add(rawAmount)
        if (projected.greaterThan(maxBalance)) {
            fail('BALANCE_LIMIT_EXCEEDED', 'The receive would exceed the reviewed balance boundary')
        }
        return tx.mintOperation.create({
            data: {
                intentId,
                walletId: storedWallet.id,
                amount: rawAmount,
                quotePrivkey: privkey,
                quotePubkey: pubkey,
                state: MintOperationState.CREATING,
            },
        })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    try {
        const wallet = await WalletService.getWallet(storedWallet.mint)
        const quote = await wallet.createLockedMintQuote(rawAmount, pubkey)
        validateInvoice(quote.request, rawAmount)
        const now = Math.floor(Date.now() / 1_000)
        if (
            quote.quote.length === 0
            || quote.quote.length > 1_024
            || quote.pubkey !== pubkey
            || quote.unit !== 'sat'
            || quote.state !== MintQuoteState.UNPAID
            || !quote.amount.equals(rawAmount)
            || !Number.isSafeInteger(quote.expiry)
            || quote.expiry === null
            || quote.expiry <= now
        ) {
            fail('INVALID_MINT_QUOTE', 'The mint returned an unusable locked quote')
        }
        const preview = await wallet.prepareMint('bolt11', rawAmount, quote, { privkey })
        const signature = preview.payload.signature
        if (!signature || !SCHNORR_HEX.test(signature)) {
            fail('INVALID_MINT_PLAN', 'The NUT-20 mint signature is invalid')
        }
        if (preview.legacySignature && !SCHNORR_HEX.test(preview.legacySignature)) {
            fail('INVALID_MINT_PLAN', 'The legacy NUT-20 mint signature is invalid')
        }
        const outputDataJson = JSON.stringify(
            preview.outputData.map(item => OutputData.serialize(item)),
        )
        const outputPlanSha256 = sha256(JSON.stringify({
            keyset_id: preview.keysetId,
            outputs: JSON.parse(outputDataJson),
            signature,
        }))
        operation = await prisma.mintOperation.update({
            where: { intentId },
            data: {
                quoteId: quote.quote,
                request: quote.request,
                expiry: BigInt(quote.expiry),
                keysetId: preview.keysetId,
                outputDataJson,
                signature,
                legacySignature: preview.legacySignature ?? null,
                invoiceSha256: sha256(quote.request.toLowerCase()),
                quoteSha256: sha256(quote.quote),
                outputPlanSha256,
                state: MintOperationState.PREPARED,
                lastQuoteState: MintQuoteState.UNPAID,
                errorCode: null,
            },
        })
        return {
            ...publicEvidence(operation, MintQuoteState.UNPAID),
            approval_payload: approvalPayloadFor(operation, storedWallet),
        }
    } catch (error) {
        await setUnknown(operation, 'receive_prepare_unknown')
        throw error
    }
}

async function reconcile(
    operation: MintOperation,
    storedWallet: StoredWallet,
): Promise<ReceiveEvidence> {
    if (operation.state === MintOperationState.ISSUED) return publicEvidence(operation)
    if (!operation.quoteId) return publicEvidence(operation, null, 'receive_prepare_unknown')

    let quote: MintQuoteBolt11Response
    try {
        const wallet = await WalletService.getWallet(storedWallet.mint)
        quote = await wallet.checkMintQuoteBolt11(operation.quoteId)
    } catch {
        const unknown = await setUnknown(operation, 'reconciliation_unavailable')
        return publicEvidence(unknown, operation.lastQuoteState)
    }
    const mismatches = quoteMismatchFields(operation, quote)
    if (mismatches.length > 0) {
        const unknown = await setUnknown(
            operation,
            `reconciliation_mismatch_${mismatches.join('_')}`,
        )
        return publicEvidence(unknown, quote.state)
    }
    if (quote.state === MintQuoteState.ISSUED) {
        try {
            const proofs = await restoreIssuedProofs(operation, storedWallet)
            const issued = await saveIssuedProofs(operation, proofs)
            return publicEvidence(issued, MintQuoteState.ISSUED)
        } catch {
            const unknown = await setUnknown(operation, 'issued_proof_recovery_failed')
            return publicEvidence(unknown, MintQuoteState.ISSUED)
        }
    }
    if (quote.state === MintQuoteState.PAID) {
        if (operation.executionCount > 0) {
            const unknown = await setUnknown(operation, 'mint_outcome_unknown')
            return publicEvidence(unknown, MintQuoteState.PAID)
        }
        const paid = await prisma.mintOperation.update({
            where: { intentId: operation.intentId },
            data: {
                state: MintOperationState.PAID,
                lastQuoteState: MintQuoteState.PAID,
                errorCode: null,
                reconciledAt: new Date(),
            },
        })
        return publicEvidence(paid, MintQuoteState.PAID)
    }
    if (quote.state === MintQuoteState.UNPAID) {
        const expiry = expiryNumber(operation.expiry)
        if (expiry !== null && expiry <= Math.floor(Date.now() / 1_000)) {
            const expired = await prisma.mintOperation.update({
                where: { intentId: operation.intentId },
                data: {
                    state: MintOperationState.EXPIRED,
                    lastQuoteState: MintQuoteState.UNPAID,
                    errorCode: 'quote_expired',
                    quotePrivkey: null,
                    outputDataJson: null,
                    signature: null,
                    legacySignature: null,
                    reconciledAt: new Date(),
                },
            })
            return publicEvidence(expired, MintQuoteState.UNPAID)
        }
        if (operation.executionCount > 0) {
            const unknown = await setUnknown(operation, 'mint_outcome_unknown')
            return publicEvidence(unknown, MintQuoteState.UNPAID)
        }
        const prepared = await prisma.mintOperation.update({
            where: { intentId: operation.intentId },
            data: {
                state: MintOperationState.PREPARED,
                lastQuoteState: MintQuoteState.UNPAID,
                errorCode: null,
                reconciledAt: new Date(),
            },
        })
        return publicEvidence(prepared, MintQuoteState.UNPAID)
    }
    const unknown = await setUnknown(operation, 'unknown_quote_state')
    return publicEvidence(unknown, String(quote.state))
}

async function execute(
    storedWallet: StoredWallet,
    intentId: string,
    hashes: ReceiveHashes,
    approvalSignature: string,
): Promise<ReceiveEvidence> {
    if (!INTENT_ID.test(intentId)) fail('INVALID_INTENT_ID', 'The receive intent ID is invalid')
    if (Object.values(hashes).some(value => !HASH_HEX.test(value))) {
        fail('INVALID_APPROVAL_HASH', 'The approved receive hashes are invalid')
    }
    let operation = await prisma.mintOperation.findUnique({ where: { intentId } })
    if (!operation || operation.walletId !== storedWallet.id) {
        fail('OPERATION_NOT_FOUND', 'The prepared receive was not found')
    }
    if (
        operation.invoiceSha256 !== hashes.invoiceSha256
        || operation.quoteSha256 !== hashes.quoteSha256
        || operation.outputPlanSha256 !== hashes.outputPlanSha256
    ) {
        fail('APPROVAL_HASH_MISMATCH', 'The approved receive plan changed')
    }
    try {
        verifyApprovalSignature(approvalPayloadFor(operation, storedWallet), approvalSignature)
    } catch (error) {
        if (error instanceof ApprovalCapabilityError) fail(error.code, error.message)
        fail('INVALID_APPROVAL', 'The approval signature could not be verified')
    }
    const checked = await reconcile(operation, storedWallet)
    if (checked.state === MintOperationState.ISSUED) return checked
    operation = await prisma.mintOperation.findUniqueOrThrow({ where: { intentId } })
    const expiresAt = expiryNumber(operation.expiry)
    if (
        operation.executionCount === 0
        && expiresAt !== null
        && expiresAt <= Math.floor(Date.now() / 1_000)
    ) {
        await prisma.mintOperation.updateMany({
            where: {
                intentId,
                walletId: storedWallet.id,
                state: { in: [MintOperationState.PREPARED, MintOperationState.PAID] },
                executionCount: 0,
            },
            data: {
                state: MintOperationState.EXPIRED,
                errorCode: 'approval_expired',
                reconciledAt: new Date(),
            },
        })
        fail('APPROVAL_EXPIRED', 'The receive approval has expired')
    }
    if (operation.state !== MintOperationState.PAID || operation.executionCount !== 0) {
        fail('QUOTE_NOT_PAID', 'The locked mint quote is not ready for one-shot issuance')
    }
    const reserved = await prisma.mintOperation.updateMany({
        where: {
            intentId,
            walletId: storedWallet.id,
            state: MintOperationState.PAID,
            executionCount: 0,
        },
        data: {
            state: MintOperationState.EXECUTING,
            executionCount: { increment: 1 },
            executedAt: new Date(),
            errorCode: null,
        },
    })
    if (reserved.count !== 1) fail('OPERATION_ALREADY_EXECUTED', 'The receive was already executed')
    operation = await prisma.mintOperation.findUniqueOrThrow({ where: { intentId } })
    try {
        const wallet = await WalletService.getWallet(storedWallet.mint)
        const proofs = await wallet.completeMint(restoredPreview(operation))
        const issued = await saveIssuedProofs(operation, proofs)
        return publicEvidence(issued, MintQuoteState.ISSUED)
    } catch {
        return reconcile(operation, storedWallet)
    }
}

async function status(storedWallet: StoredWallet, intentId: string): Promise<ReceiveEvidence> {
    if (!INTENT_ID.test(intentId)) fail('INVALID_INTENT_ID', 'The receive intent ID is invalid')
    const operation = await prisma.mintOperation.findUnique({ where: { intentId } })
    if (!operation || operation.walletId !== storedWallet.id) {
        fail('OPERATION_NOT_FOUND', 'The prepared receive was not found')
    }
    const evidence = await reconcile(operation, storedWallet)
    if (
        evidence.state === MintOperationState.PREPARED
        || evidence.state === MintOperationState.PAID
    ) {
        return {
            ...evidence,
            approval_payload: approvalPayloadFor(operation, storedWallet),
        }
    }
    return evidence
}

export const SplitMintService = {
    prepare,
    execute,
    status,
    sha256,
}
