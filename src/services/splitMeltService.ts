import crypto from 'crypto'
import {
    Amount,
    CheckStateEnum,
    deserializeProofs,
    MeltPreview,
    MeltProofsResponse,
    MeltQuoteBolt11Response,
    MeltQuoteState,
    OutputData,
    Proof,
    serializeProofs,
    SerializedOutputData,
    sumProofs,
} from '@cashu/cashu-ts'
import {
    MeltOperation,
    MeltOperationState,
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
const SHA256_HEX = /^[0-9a-f]{64}$/
const PREIMAGE_HEX = /^[0-9a-fA-F]{64}$/
const MAX_BOUNDARY_AMOUNT = Amount.from(2_147_483_647)
const MAX_INVOICE_LENGTH = 8_192

type Hashes = {
    invoiceSha256: string
    quoteSha256: string
    proofPlanSha256: string
}

type ReconciliationEvidence = {
    intent_id: string
    state: string
    quote_state: string | null
    proof_states: string[]
    payment_preimage: string | null
    fee_paid: number | null
    total_spent: number | null
    balance_after: number | null
    error_code: string | null
    approval_payload?: string
}

type PaidReceipt = {
    feePaid: number
    totalSpent: number
    balanceAfter: number
}

type PreparedPayment = ReconciliationEvidence & {
    amount: number
    fee_reserve: number
    input_fee: number
    max_spend: number
    proof_input_total: number
    minimum_change: number
    expiry: number
    payment_hash: string
    invoice_sha256: string
    quote_sha256: string
    proof_plan_sha256: string
    approval_payload: string
}

export class SplitMeltError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message)
        this.name = 'SplitMeltError'
    }
}

function fail(code: string, message: string): never {
    throw new SplitMeltError(code, message)
}

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function boundaryNumber(value: Amount, field: string): number {
    if (value.lessThan(Amount.zero()) || value.greaterThan(MAX_BOUNDARY_AMOUNT)) {
        fail('AMOUNT_OUT_OF_RANGE', `${field} is outside the supported integer range`)
    }
    return value.toNumber()
}

function expiryNumber(value: bigint): number {
    const numeric = Number(value)
    if (!Number.isSafeInteger(numeric) || numeric < 0) {
        fail('INVALID_OPERATION', 'Stored quote expiry is invalid')
    }
    return numeric
}

function validateInvoice(invoice: string): string {
    if (
        typeof invoice !== 'string'
        || invoice.length === 0
        || invoice.length > MAX_INVOICE_LENGTH
        || /\s/.test(invoice)
        || !invoice.toLowerCase().startsWith('lnbc')
    ) {
        fail('INVALID_INVOICE', 'A valid mainnet BOLT11 invoice is required')
    }
    try {
        decodeBolt11(invoice)
    } catch {
        fail('INVALID_INVOICE', 'The BOLT11 invoice could not be decoded')
    }
    return invoice
}

function paymentHash(invoice: string): string {
    let decoded: ReturnType<typeof decodeBolt11>
    try {
        decoded = decodeBolt11(invoice)
    } catch {
        fail('INVALID_INVOICE', 'The BOLT11 invoice could not be decoded')
    }
    const section = decoded.sections.find(item => item?.name === 'payment_hash')
    const value = section?.value
    if (value === undefined || value === null) {
        fail('INVALID_INVOICE', 'The BOLT11 invoice has no payment hash')
    }
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    if (bytes.length !== 32) {
        fail('INVALID_INVOICE', 'The BOLT11 payment hash is invalid')
    }
    return bytes.toString('hex')
}

function validPreimage(expectedPaymentHash: string, preimage: string | null): boolean {
    if (!preimage || !PREIMAGE_HEX.test(preimage)) return false
    const digest = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest()
    const expected = Buffer.from(expectedPaymentHash, 'hex')
    return expected.length === digest.length && crypto.timingSafeEqual(expected, digest)
}

function hashesFor(operation: MeltOperation): Hashes {
    return {
        invoiceSha256: sha256(operation.request),
        quoteSha256: sha256(operation.quoteId),
        proofPlanSha256: sha256(operation.selectedProofsJson),
    }
}

function approvalPayloadFor(operation: MeltOperation, storedWallet: StoredWallet): string {
    const hashes = hashesFor(operation)
    return buildApprovalPayload({
        operation: 'pay',
        wallet_sha256: walletApprovalId(storedWallet.accessKey),
        intent_id: operation.intentId,
        amount: operation.amount,
        max_spend: operation.maxSpend,
        expires_at: expiryNumber(operation.expiry),
        invoice_sha256: hashes.invoiceSha256,
        quote_sha256: hashes.quoteSha256,
        plan_sha256: hashes.proofPlanSha256,
    })
}

function effectiveMaxPay(storedWallet: StoredWallet): number {
    const configured = Number(process.env.MAX_PAY ?? 50_000)
    if (!Number.isSafeInteger(configured) || configured <= 0) {
        fail('INVALID_LIMIT_CONFIG', 'MAX_PAY must be a positive safe integer')
    }
    return storedWallet.maxPay === null ? configured : Math.min(storedWallet.maxPay, configured)
}

function restoredProofs(operation: MeltOperation): Proof[] {
    try {
        return deserializeProofs(JSON.parse(operation.selectedProofsJson) as string[])
    } catch {
        fail('INVALID_OPERATION', 'Stored melt proofs could not be restored')
    }
}

function restoredOutputs(operation: MeltOperation): OutputData[] {
    try {
        const stored = JSON.parse(operation.changeOutputsJson) as SerializedOutputData[]
        if (!Array.isArray(stored)) throw new Error('not an array')
        return stored.map(item => OutputData.deserialize(item))
    } catch {
        fail('INVALID_OPERATION', 'Stored melt change outputs could not be restored')
    }
}

function restoredQuote(operation: MeltOperation): MeltQuoteBolt11Response {
    return {
        quote: operation.quoteId,
        request: operation.request,
        amount: Amount.from(operation.amount),
        fee_reserve: Amount.from(operation.feeReserve),
        unit: 'sat',
        state: MeltQuoteState.UNPAID,
        expiry: expiryNumber(operation.expiry),
        payment_preimage: null,
    }
}

function restoredPreview(operation: MeltOperation): MeltPreview<MeltQuoteBolt11Response> {
    return {
        method: 'bolt11',
        inputs: restoredProofs(operation),
        outputData: restoredOutputs(operation),
        keysetId: operation.keysetId,
        quote: restoredQuote(operation),
    }
}

function publicEvidence(
    operation: MeltOperation,
    quoteState: string | null = operation.lastQuoteState,
    proofStates: string[] = [],
    paymentPreimage: string | null = null,
    paidReceipt: PaidReceipt | null = null,
): ReconciliationEvidence {
    return {
        intent_id: operation.intentId,
        state: operation.state,
        quote_state: quoteState,
        proof_states: proofStates,
        payment_preimage: paymentPreimage,
        fee_paid: paidReceipt?.feePaid ?? null,
        total_spent: paidReceipt?.totalSpent ?? null,
        balance_after: paidReceipt?.balanceAfter ?? null,
        error_code: operation.errorCode,
    }
}

function quoteMatches(operation: MeltOperation, quote: MeltQuoteBolt11Response): boolean {
    try {
        return quote.quote === operation.quoteId
            && quote.request.toLowerCase() === operation.request.toLowerCase()
            && quote.unit === 'sat'
            && quote.amount.equals(operation.amount)
            && quote.fee_reserve.equals(operation.feeReserve)
            && quote.expiry === expiryNumber(operation.expiry)
    } catch {
        return false
    }
}

async function setUnknown(operation: MeltOperation, code: string): Promise<MeltOperation> {
    await prisma.meltOperation.updateMany({
        where: {
            intentId: operation.intentId,
            state: { notIn: [MeltOperationState.PAID, MeltOperationState.EXPIRED] },
        },
        data: {
            state: MeltOperationState.UNKNOWN,
            errorCode: code,
            reconciledAt: new Date(),
        },
    })
    return prisma.meltOperation.findUniqueOrThrow({ where: { intentId: operation.intentId } })
}

async function saveChangeProofs(
    tx: Prisma.TransactionClient,
    walletId: number,
    change: Proof[],
): Promise<void> {
    for (const proof of change) {
        const existing = await tx.proof.findUnique({ where: { secret: proof.secret } })
        if (existing) {
            const expected = WalletService.proofStorageData(walletId, proof, ProofStatus.UNSPENT)
            if (
                existing.walletId !== expected.walletId
                || existing.proofId !== expected.proofId
                || existing.amount !== expected.amount
                || existing.C !== expected.C
                || existing.dleq !== expected.dleq
                || existing.witness !== expected.witness
                || existing.p2pkE !== expected.p2pkE
            ) {
                fail('CHANGE_CONFLICT', 'Stored melt change conflicts with an existing proof')
            }
            continue
        }
        await tx.proof.create({
            data: WalletService.proofStorageData(walletId, proof, ProofStatus.UNSPENT),
        })
    }
}

async function expirePrepared(operation: MeltOperation, proofs: Proof[]): Promise<MeltOperation> {
    try {
        return await prisma.$transaction(async tx => {
            const current = await tx.meltOperation.findUnique({ where: { intentId: operation.intentId } })
            if (!current || current.state !== MeltOperationState.PREPARED || current.executionCount !== 0) {
                fail('OPERATION_ALREADY_EXECUTED', 'The prepared payment is no longer executable')
            }
            const secrets = proofs.map(proof => proof.secret)
            const reserved = await tx.proof.count({
                where: {
                    walletId: operation.walletId,
                    secret: { in: secrets },
                    status: ProofStatus.PENDING,
                    reservedByIntentId: operation.intentId,
                },
            })
            if (reserved !== 0 && reserved !== secrets.length) {
                return tx.meltOperation.update({
                    where: { intentId: operation.intentId },
                    data: {
                        state: MeltOperationState.UNKNOWN,
                        errorCode: 'proof_reservation_mismatch',
                        reconciledAt: new Date(),
                    },
                })
            }
            if (reserved === secrets.length) {
                const released = await tx.proof.updateMany({
                    where: {
                        walletId: operation.walletId,
                        secret: { in: secrets },
                        status: ProofStatus.PENDING,
                        reservedByIntentId: operation.intentId,
                    },
                    data: { status: ProofStatus.UNSPENT, reservedByIntentId: null },
                })
                if (released.count !== secrets.length) {
                    fail('PROOF_RESERVATION_MISMATCH', 'The prepared proofs could not be released atomically')
                }
            }
            return tx.meltOperation.update({
                where: { intentId: operation.intentId },
                data: {
                    state: MeltOperationState.EXPIRED,
                    errorCode: 'quote_expired',
                    reconciledAt: new Date(),
                },
            })
        })
    } catch (error) {
        if (error instanceof SplitMeltError && error.code === 'PROOF_RESERVATION_MISMATCH') {
            return setUnknown(operation, 'proof_reservation_mismatch')
        }
        throw error
    }
}

async function reserveExecution(operation: MeltOperation, proofs: Proof[]): Promise<MeltOperation> {
    return prisma.$transaction(async tx => {
        const current = await tx.meltOperation.findUnique({ where: { intentId: operation.intentId } })
        if (!current || current.state !== MeltOperationState.PREPARED || current.executionCount !== 0) {
            fail('OPERATION_ALREADY_EXECUTED', 'The prepared payment is no longer executable')
        }
        const secrets = proofs.map(proof => proof.secret)
        const alreadyReserved = await tx.proof.count({
            where: {
                walletId: operation.walletId,
                secret: { in: secrets },
                status: ProofStatus.PENDING,
                reservedByIntentId: operation.intentId,
            },
        })
        if (alreadyReserved !== 0 && alreadyReserved !== secrets.length) {
            fail('PROOF_RESERVATION_MISMATCH', 'The prepared proof reservation is incomplete')
        }
        if (alreadyReserved === 0) {
            const reserved = await tx.proof.updateMany({
                where: {
                    walletId: operation.walletId,
                    secret: { in: secrets },
                    status: ProofStatus.UNSPENT,
                    reservedByIntentId: null,
                },
                data: { status: ProofStatus.PENDING, reservedByIntentId: operation.intentId },
            })
            if (reserved.count !== secrets.length) {
                fail('PROOF_RESERVATION_MISMATCH', 'The approved proofs are no longer available')
            }
        }
        const updated = await tx.meltOperation.updateMany({
            where: {
                intentId: operation.intentId,
                state: MeltOperationState.PREPARED,
                executionCount: 0,
            },
            data: {
                state: MeltOperationState.EXECUTING,
                executionCount: { increment: 1 },
                executedAt: new Date(),
                errorCode: null,
            },
        })
        if (updated.count !== 1) {
            fail('OPERATION_ALREADY_EXECUTED', 'The prepared payment was reserved by another process')
        }
        return tx.meltOperation.findUniqueOrThrow({ where: { intentId: operation.intentId } })
    })
}

async function reconcile(
    operation: MeltOperation,
    directResult?: MeltProofsResponse<MeltQuoteBolt11Response>,
): Promise<ReconciliationEvidence> {
    let proofs: Proof[]
    let wallet: Awaited<ReturnType<typeof WalletService.getWallet>>
    let quote: MeltQuoteBolt11Response
    let remoteProofStates: string[]
    try {
        proofs = restoredProofs(operation)
        const storedWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: operation.walletId } })
        wallet = await WalletService.getWallet(storedWallet.mint)
        quote = directResult?.quote ?? await wallet.checkMeltQuoteBolt11(operation.quoteId)
        const checked = await wallet.checkProofsStates(proofs)
        remoteProofStates = checked.map(item => item.state)
    } catch {
        const unknown = await setUnknown(operation, 'reconciliation_unavailable')
        return publicEvidence(unknown)
    }

    if (!quoteMatches(operation, quote) || remoteProofStates.length !== proofs.length) {
        const unknown = await setUnknown(operation, 'reconciliation_mismatch')
        return publicEvidence(unknown, quote.state, remoteProofStates)
    }

    let expectedHash: string
    try {
        expectedHash = paymentHash(operation.request)
    } catch {
        const unknown = await setUnknown(operation, 'invalid_stored_invoice')
        return publicEvidence(unknown, quote.state, remoteProofStates)
    }
    const allSpent = remoteProofStates.every(state => state === CheckStateEnum.SPENT)
    const allUnspent = remoteProofStates.every(state => state === CheckStateEnum.UNSPENT)
    const allPending = remoteProofStates.every(state => state === CheckStateEnum.PENDING)

    if (quote.state === MeltQuoteState.PAID && allSpent && validPreimage(expectedHash, quote.payment_preimage)) {
        let change = directResult?.change ?? []
        try {
            if (change.length === 0 && quote.change && quote.change.length > 0) {
                change = wallet.createMeltChangeProofs(restoredOutputs(operation), quote.change)
            }
            const selectedTotal = sumProofs(proofs)
            const changeTotal = change.length > 0 ? sumProofs(change) : Amount.zero()
            const invoiceAmount = Amount.from(operation.amount)
            const maxFee = Amount.from(operation.feeReserve).add(Amount.from(operation.inputFee))
            if (changeTotal.greaterThan(selectedTotal)) {
                fail('INVALID_PAID_RECEIPT', 'Melt change exceeds the selected proof total')
            }
            const totalSpentAmount = selectedTotal.subtract(changeTotal)
            if (totalSpentAmount.lessThan(invoiceAmount)) {
                fail('INVALID_PAID_RECEIPT', 'Melt total spent is below the invoice amount')
            }
            const feePaidAmount = totalSpentAmount.subtract(invoiceAmount)
            if (feePaidAmount.greaterThan(maxFee)) {
                fail('INVALID_PAID_RECEIPT', 'Melt fee exceeds the approved maximum')
            }
            const feePaid = boundaryNumber(feePaidAmount, 'paid fee')
            const totalSpent = boundaryNumber(totalSpentAmount, 'total spent')
            const receipt = await prisma.$transaction(async tx => {
                await tx.proof.updateMany({
                    where: {
                        walletId: operation.walletId,
                        secret: { in: proofs.map(proof => proof.secret) },
                        status: ProofStatus.PENDING,
                        reservedByIntentId: operation.intentId,
                    },
                    data: { status: ProofStatus.SPENT, reservedByIntentId: null },
                })
                const spent = await tx.proof.count({
                    where: {
                        walletId: operation.walletId,
                        secret: { in: proofs.map(proof => proof.secret) },
                        status: ProofStatus.SPENT,
                    },
                })
                if (spent !== proofs.length) {
                    fail('PROOF_STATE_MISMATCH', 'Local melt proof state does not match the mint')
                }
                await saveChangeProofs(tx, operation.walletId, change)
                const available = await tx.proof.findMany({
                    where: {
                        walletId: operation.walletId,
                        status: ProofStatus.UNSPENT,
                        reservedByIntentId: null,
                    },
                    select: { amount: true },
                })
                let balanceAfterAmount = Amount.zero()
                for (const proof of available) {
                    balanceAfterAmount = balanceAfterAmount.add(Amount.from(proof.amount))
                }
                const balanceAfter = boundaryNumber(balanceAfterAmount, 'balance after payment')
                const paid = await tx.meltOperation.update({
                    where: { intentId: operation.intentId },
                    data: {
                        state: MeltOperationState.PAID,
                        lastQuoteState: quote.state,
                        errorCode: null,
                        reconciledAt: new Date(),
                    },
                })
                return { paid, balanceAfter }
            })
            return publicEvidence(
                receipt.paid,
                quote.state,
                remoteProofStates,
                quote.payment_preimage,
                { feePaid, totalSpent, balanceAfter: receipt.balanceAfter },
            )
        } catch (error) {
            const errorCode = error instanceof SplitMeltError && error.code === 'INVALID_PAID_RECEIPT'
                ? 'invalid_paid_receipt'
                : 'change_recovery_failed'
            const unknown = await setUnknown(operation, errorCode)
            return publicEvidence(unknown, quote.state, remoteProofStates)
        }
    }

    if (quote.state === MeltQuoteState.UNPAID && allUnspent && quote.payment_preimage === null) {
        const unpaid = await prisma.$transaction(async tx => {
            await tx.proof.updateMany({
                where: {
                    walletId: operation.walletId,
                    secret: { in: proofs.map(proof => proof.secret) },
                    status: ProofStatus.PENDING,
                    reservedByIntentId: operation.intentId,
                },
                data: { status: ProofStatus.UNSPENT, reservedByIntentId: null },
            })
            const released = await tx.proof.count({
                where: {
                    walletId: operation.walletId,
                    secret: { in: proofs.map(proof => proof.secret) },
                    status: ProofStatus.UNSPENT,
                },
            })
            if (released !== proofs.length) {
                fail('PROOF_STATE_MISMATCH', 'Local melt proof state does not match the mint')
            }
            return tx.meltOperation.update({
                where: { intentId: operation.intentId },
                data: {
                    state: MeltOperationState.UNPAID,
                    lastQuoteState: quote.state,
                    errorCode: null,
                    reconciledAt: new Date(),
                },
            })
        })
        return publicEvidence(unpaid, quote.state, remoteProofStates)
    }

    if (quote.state === MeltQuoteState.PENDING && allPending && quote.payment_preimage === null) {
        const pending = await prisma.meltOperation.update({
            where: { intentId: operation.intentId },
            data: {
                state: MeltOperationState.PENDING,
                lastQuoteState: quote.state,
                errorCode: null,
                reconciledAt: new Date(),
            },
        })
        return publicEvidence(pending, quote.state, remoteProofStates)
    }

    const errorCode = quote.state === MeltQuoteState.PAID
        && allSpent
        && !validPreimage(expectedHash, quote.payment_preimage)
        ? 'preimage_mismatch'
        : 'reconciliation_mismatch'
    const unknown = await setUnknown(operation, errorCode)
    return publicEvidence(unknown, quote.state, remoteProofStates)
}

async function prepare(
    storedWallet: StoredWallet,
    intentId: string,
    rawInvoice: string,
): Promise<PreparedPayment> {
    if (!INTENT_ID.test(intentId)) fail('INVALID_INTENT_ID', 'The payment intent ID is invalid')
    const invoice = validateInvoice(rawInvoice)
    const existing = await prisma.meltOperation.findUnique({ where: { intentId } })
    if (existing) fail('DUPLICATE_INTENT', 'The payment intent already exists')

    const wallet = await WalletService.getWallet(storedWallet.mint)
    const quote = await wallet.createMeltQuoteBolt11(invoice)
    const now = Math.floor(Date.now() / 1000)
    if (
        quote.request.toLowerCase() !== invoice.toLowerCase()
        || quote.unit !== 'sat'
        || quote.state !== MeltQuoteState.UNPAID
        || !Number.isSafeInteger(quote.expiry)
        || quote.expiry <= now
    ) {
        fail('INVALID_MELT_QUOTE', 'The mint returned an unusable melt quote')
    }

    const amount = boundaryNumber(quote.amount, 'amount')
    if (amount <= 0) fail('INVALID_MELT_QUOTE', 'The melt quote amount must be positive')
    const feeReserve = boundaryNumber(quote.fee_reserve, 'fee reserve')
    const baseAmount = quote.amount.add(quote.fee_reserve)
    boundaryNumber(baseAmount, 'amount plus fee reserve')
    const maxPay = effectiveMaxPay(storedWallet)
    if (baseAmount.greaterThan(maxPay)) {
        fail('PAYMENT_LIMIT_EXCEEDED', `The quote's maximum wallet spend exceeds the payment limit of ${maxPay}`)
    }

    const available = await WalletService.loadProofs(storedWallet.id, ProofStatus.UNSPENT)
    let selected: Proof[]
    try {
        selected = wallet.selectProofsToSend(available, baseAmount, true, false).send
    } catch {
        fail('INSUFFICIENT_BALANCE', 'No suitable proof set is available for this payment')
    }
    if (selected.length === 0) fail('INSUFFICIENT_BALANCE', 'No suitable proof set is available')
    const inputFeeAmount = wallet.getFeesForProofs(selected)
    const maxSpendAmount = baseAmount.add(inputFeeAmount)
    if (maxSpendAmount.greaterThan(maxPay)) {
        fail('PAYMENT_LIMIT_EXCEEDED', `The prepared maximum wallet spend exceeds the payment limit of ${maxPay}`)
    }
    const selectedTotal = sumProofs(selected)
    if (selectedTotal.lessThan(maxSpendAmount)) {
        fail('INSUFFICIENT_BALANCE', 'The selected proof set does not cover the maximum spend')
    }
    const inputFee = boundaryNumber(inputFeeAmount, 'input fee')
    const maxSpend = boundaryNumber(maxSpendAmount, 'maximum spend')
    const proofInputTotal = boundaryNumber(selectedTotal, 'proof input total')
    const minimumChange = boundaryNumber(
        selectedTotal.subtract(maxSpendAmount),
        'minimum change',
    )

    const preview = await wallet.prepareMelt('bolt11', quote, selected)
    const selectedSecrets = new Set(selected.map(proof => proof.secret))
    if (
        preview.inputs.length !== selected.length
        || preview.inputs.some(proof => !selectedSecrets.has(proof.secret))
        || !sumProofs(preview.inputs).equals(selectedTotal)
        || !wallet.getFeesForProofs(preview.inputs).equals(inputFeeAmount)
    ) {
        fail('INVALID_PROOF_PLAN', 'The prepared melt inputs changed during preview')
    }
    if (
        selectedTotal.greaterThan(quote.amount.add(inputFeeAmount))
        && preview.outputData.length === 0
    ) {
        fail('INVALID_PROOF_PLAN', 'The prepared melt omitted required change recovery outputs')
    }
    const selectedProofsJson = JSON.stringify(serializeProofs(preview.inputs))
    const changeOutputsJson = JSON.stringify(preview.outputData.map(item => OutputData.serialize(item)))
    const secrets = preview.inputs.map(proof => proof.secret)
    if (secrets.length === 0 || new Set(secrets).size !== secrets.length) {
        fail('INVALID_PROOF_PLAN', 'The prepared proof plan is invalid')
    }

    const operation = await prisma.$transaction(async tx => {
        const duplicate = await tx.meltOperation.findUnique({ where: { intentId } })
        if (duplicate) fail('DUPLICATE_INTENT', 'The payment intent already exists')
        return tx.meltOperation.create({
            data: {
                intentId,
                walletId: storedWallet.id,
                quoteId: quote.quote,
                request: invoice,
                amount,
                feeReserve,
                inputFee,
                maxSpend,
                expiry: BigInt(quote.expiry),
                keysetId: preview.keysetId,
                selectedProofsJson,
                changeOutputsJson,
                state: MeltOperationState.PREPARED,
            },
        })
    })

    const hashes = hashesFor(operation)
    return {
        ...publicEvidence(operation),
        amount,
        fee_reserve: feeReserve,
        input_fee: inputFee,
        max_spend: maxSpend,
        proof_input_total: proofInputTotal,
        minimum_change: minimumChange,
        expiry: quote.expiry,
        payment_hash: paymentHash(invoice),
        invoice_sha256: hashes.invoiceSha256,
        quote_sha256: hashes.quoteSha256,
        proof_plan_sha256: hashes.proofPlanSha256,
        approval_payload: approvalPayloadFor(operation, storedWallet),
    }
}

async function execute(
    storedWallet: StoredWallet,
    intentId: string,
    approved: Hashes,
    approvalSignature: string,
): Promise<ReconciliationEvidence> {
    if (!INTENT_ID.test(intentId)) fail('INVALID_INTENT_ID', 'The payment intent ID is invalid')
    if (!SHA256_HEX.test(approved.invoiceSha256)
        || !SHA256_HEX.test(approved.quoteSha256)
        || !SHA256_HEX.test(approved.proofPlanSha256)) {
        fail('INVALID_APPROVAL', 'The approved payment hashes are invalid')
    }
    const operation = await prisma.meltOperation.findUnique({ where: { intentId } })
    if (!operation || operation.walletId !== storedWallet.id) {
        fail('OPERATION_NOT_FOUND', 'The prepared payment was not found')
    }
    const expected = hashesFor(operation)
    if (
        expected.invoiceSha256 !== approved.invoiceSha256
        || expected.quoteSha256 !== approved.quoteSha256
        || expected.proofPlanSha256 !== approved.proofPlanSha256
    ) {
        fail('APPROVAL_MISMATCH', 'The approved payment does not match the prepared operation')
    }
    try {
        verifyApprovalSignature(approvalPayloadFor(operation, storedWallet), approvalSignature)
    } catch (error) {
        if (error instanceof ApprovalCapabilityError) fail(error.code, error.message)
        fail('INVALID_APPROVAL', 'The approval signature could not be verified')
    }
    if (operation.state !== MeltOperationState.PREPARED || operation.executionCount !== 0) {
        fail('OPERATION_ALREADY_EXECUTED', 'The payment has already left the prepared state')
    }

    const proofs = restoredProofs(operation)
    if (expiryNumber(operation.expiry) <= Math.floor(Date.now() / 1000)) {
        const expired = await expirePrepared(operation, proofs)
        return publicEvidence(expired)
    }

    const executing = await reserveExecution(operation, proofs)
    try {
        const wallet = await WalletService.getWallet(storedWallet.mint)
        const result = await wallet.completeMelt(restoredPreview(executing))
        return await reconcile(executing, result)
    } catch {
        return await reconcile(executing)
    }
}

async function status(storedWallet: StoredWallet, intentId: string): Promise<ReconciliationEvidence> {
    if (!INTENT_ID.test(intentId)) fail('INVALID_INTENT_ID', 'The payment intent ID is invalid')
    const operation = await prisma.meltOperation.findUnique({ where: { intentId } })
    if (!operation || operation.walletId !== storedWallet.id) {
        fail('OPERATION_NOT_FOUND', 'The prepared payment was not found')
    }
    if (operation.state === MeltOperationState.PREPARED) {
        if (expiryNumber(operation.expiry) <= Math.floor(Date.now() / 1000)) {
            const expired = await expirePrepared(operation, restoredProofs(operation))
            return publicEvidence(expired)
        }
        return {
            ...publicEvidence(operation),
            approval_payload: approvalPayloadFor(operation, storedWallet),
        }
    }
    if (operation.state === MeltOperationState.EXPIRED) {
        return publicEvidence(operation)
    }
    return reconcile(operation)
}

export const SplitMeltService = {
    prepare,
    execute,
    status,
    sha256,
}
