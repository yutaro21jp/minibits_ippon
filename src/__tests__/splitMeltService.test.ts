import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Amount, CheckStateEnum, MeltQuoteState, OutputData } from '@cashu/cashu-ts'
import { MeltOperationState, ProofStatus } from '@prisma/client'

const PAYMENT_HASH = '02d449a31fbb267c8f352e9968a79e3e5fc95c1bbeaa502fd6454ebde5a4bedc'
const PAYMENT_PREIMAGE = '11'.repeat(32)
const INVOICE = 'lnbc1testinvoice'
const INTENT_ID = 'wallet_0123456789abcdef01234567'
const NOW = 2_000_000_000

const mocks = vi.hoisted(() => ({
    getWallet: vi.fn(),
    loadProofs: vi.fn(),
    proofStorageData: vi.fn(),
    createMeltQuoteBolt11: vi.fn(),
    selectProofsToSend: vi.fn(),
    getFeesForProofs: vi.fn(),
    prepareMelt: vi.fn(),
    completeMelt: vi.fn(),
    checkMeltQuoteBolt11: vi.fn(),
    checkProofsStates: vi.fn(),
    createMeltChangeProofs: vi.fn(),
    meltOperationFindUnique: vi.fn(),
    meltOperationFindUniqueOrThrow: vi.fn(),
    meltOperationCreate: vi.fn(),
    meltOperationUpdate: vi.fn(),
    meltOperationUpdateMany: vi.fn(),
    proofUpdateMany: vi.fn(),
    proofCount: vi.fn(),
    proofFindMany: vi.fn(),
    proofFindUnique: vi.fn(),
    proofCreate: vi.fn(),
    walletFindUniqueOrThrow: vi.fn(),
    transaction: vi.fn(),
}))

vi.mock('@gandlaf21/bolt11-decode', () => ({
    decode: vi.fn(() => ({
        paymentRequest: 'lnbc1testinvoice',
        sections: [{
            name: 'payment_hash',
            value: Buffer.from('02d449a31fbb267c8f352e9968a79e3e5fc95c1bbeaa502fd6454ebde5a4bedc', 'hex'),
        }],
        expiry: 2_000_003_600,
        route_hints: [],
    })),
}))

vi.mock('../services/walletService', () => ({
    WalletService: {
        getWallet: mocks.getWallet,
        loadProofs: mocks.loadProofs,
        proofStorageData: mocks.proofStorageData,
    },
}))

vi.mock('../utils/prismaClient', () => ({
    default: {
        meltOperation: {
            findUnique: mocks.meltOperationFindUnique,
            findUniqueOrThrow: mocks.meltOperationFindUniqueOrThrow,
            create: mocks.meltOperationCreate,
            update: mocks.meltOperationUpdate,
            updateMany: mocks.meltOperationUpdateMany,
        },
        proof: {
            updateMany: mocks.proofUpdateMany,
            count: mocks.proofCount,
            findMany: mocks.proofFindMany,
            findUnique: mocks.proofFindUnique,
            create: mocks.proofCreate,
        },
        wallet: { findUniqueOrThrow: mocks.walletFindUniqueOrThrow },
        $transaction: mocks.transaction,
    },
}))

import { SplitMeltService } from '../services/splitMeltService'

const storedWallet = {
    id: 1,
    accessKey: 'abc123',
    name: 'test',
    mint: 'https://mint.example.com',
    unit: 'sat',
    maxBalance: null,
    maxSend: null,
    maxPay: null,
    createdAt: new Date(0),
    updatedAt: null,
}

const selectedProof = {
    id: 'keyset-1',
    amount: Amount.from(107),
    secret: 'selected-secret',
    C: 'selected-C',
}

function quote(state: MeltQuoteState = MeltQuoteState.UNPAID, preimage: string | null = null) {
    return {
        quote: 'private-quote-id',
        request: INVOICE,
        amount: Amount.from(100),
        fee_reserve: Amount.from(5),
        unit: 'sat',
        state,
        expiry: NOW + 3_600,
        payment_preimage: preimage,
    }
}

function approval(prepared: Awaited<ReturnType<typeof SplitMeltService.prepare>>) {
    return {
        invoiceSha256: prepared.invoice_sha256,
        quoteSha256: prepared.quote_sha256,
        proofPlanSha256: prepared.proof_plan_sha256,
    }
}

describe('SplitMeltService', () => {
    let operation: any
    let proofStatus: ProofStatus
    let reservedByIntentId: string | null
    const storedChange = new Map<string, any>()
    const wallet = {
        createMeltQuoteBolt11: mocks.createMeltQuoteBolt11,
        selectProofsToSend: mocks.selectProofsToSend,
        getFeesForProofs: mocks.getFeesForProofs,
        prepareMelt: mocks.prepareMelt,
        completeMelt: mocks.completeMelt,
        checkMeltQuoteBolt11: mocks.checkMeltQuoteBolt11,
        checkProofsStates: mocks.checkProofsStates,
        createMeltChangeProofs: mocks.createMeltChangeProofs,
    }

    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
        operation = null
        proofStatus = ProofStatus.UNSPENT
        reservedByIntentId = null
        storedChange.clear()

        mocks.getWallet.mockResolvedValue(wallet)
        mocks.loadProofs.mockResolvedValue([selectedProof])
        mocks.createMeltQuoteBolt11.mockResolvedValue(quote())
        mocks.selectProofsToSend.mockReturnValue({ keep: [], send: [selectedProof] })
        mocks.getFeesForProofs.mockReturnValue(Amount.from(2))
        mocks.prepareMelt.mockResolvedValue({
            method: 'bolt11',
            inputs: [selectedProof],
            outputData: [OutputData.createSingleRandomData(1, 'keyset-1')],
            keysetId: 'keyset-1',
            quote: quote(),
        })
        mocks.completeMelt.mockResolvedValue({
            quote: quote(MeltQuoteState.PAID, PAYMENT_PREIMAGE),
            change: [],
            outputData: [],
        })
        mocks.checkMeltQuoteBolt11.mockResolvedValue(quote(MeltQuoteState.PAID, PAYMENT_PREIMAGE))
        mocks.checkProofsStates.mockResolvedValue([{ state: CheckStateEnum.SPENT }])
        mocks.walletFindUniqueOrThrow.mockResolvedValue(storedWallet)

        mocks.meltOperationFindUnique.mockImplementation(async () => operation)
        mocks.meltOperationFindUniqueOrThrow.mockImplementation(async () => {
            if (!operation) throw new Error('not found')
            return operation
        })
        mocks.meltOperationCreate.mockImplementation(async ({ data }: any) => {
            operation = {
                ...data,
                executionCount: 0,
                lastQuoteState: null,
                errorCode: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                executedAt: null,
                reconciledAt: null,
            }
            return operation
        })
        mocks.meltOperationUpdate.mockImplementation(async ({ data }: any) => {
            operation = { ...operation, ...data, updatedAt: new Date() }
            return operation
        })
        mocks.meltOperationUpdateMany.mockImplementation(async ({ where, data }: any) => {
            if (!operation
                || operation.intentId !== where.intentId
                || operation.state !== where.state
                || operation.executionCount !== where.executionCount) {
                return { count: 0 }
            }
            operation = {
                ...operation,
                ...data,
                executionCount: data.executionCount?.increment
                    ? operation.executionCount + data.executionCount.increment
                    : operation.executionCount,
            }
            return { count: 1 }
        })
        mocks.proofUpdateMany.mockImplementation(async ({ where, data }: any) => {
            const reservationMatches = !Object.prototype.hasOwnProperty.call(where, 'reservedByIntentId')
                || where.reservedByIntentId === reservedByIntentId
            if (where.secret?.in?.includes(selectedProof.secret)
                && where.status === proofStatus
                && reservationMatches) {
                proofStatus = data.status
                if (Object.prototype.hasOwnProperty.call(data, 'reservedByIntentId')) {
                    reservedByIntentId = data.reservedByIntentId
                }
                return { count: 1 }
            }
            return { count: 0 }
        })
        mocks.proofCount.mockImplementation(async ({ where }: any) => {
            const reservationMatches = !Object.prototype.hasOwnProperty.call(where, 'reservedByIntentId')
                || where.reservedByIntentId === reservedByIntentId
            return where.status === proofStatus && reservationMatches ? 1 : 0
        })
        mocks.proofFindMany.mockImplementation(async ({ where }: any) => {
            const available = []
            if (
                where.status === ProofStatus.UNSPENT
                && where.reservedByIntentId === null
                && proofStatus === ProofStatus.UNSPENT
                && reservedByIntentId === null
            ) {
                available.push({ amount: selectedProof.amount.toNumber() })
            }
            for (const proof of storedChange.values()) {
                if (proof.status === ProofStatus.UNSPENT && proof.reservedByIntentId === null) {
                    available.push({ amount: proof.amount })
                }
            }
            return available
        })
        mocks.proofFindUnique.mockImplementation(async ({ where }: any) => storedChange.get(where.secret) ?? null)
        mocks.proofStorageData.mockImplementation((walletId: number, proof: any, status: ProofStatus) => ({
            walletId,
            proofId: proof.id,
            amount: proof.amount.toNumber(),
            secret: proof.secret,
            C: proof.C,
            dleq: null,
            witness: null,
            p2pkE: null,
            status,
            reservedByIntentId: null,
        }))
        mocks.proofCreate.mockImplementation(async ({ data }: any) => {
            storedChange.set(data.secret, data)
            return data
        })
        mocks.transaction.mockImplementation(async (callback: any) => {
            const operationBefore = operation ? { ...operation } : null
            const statusBefore = proofStatus
            const reservationBefore = reservedByIntentId
            const changeBefore = new Map(storedChange)
            try {
                return await callback({
                    meltOperation: {
                        findUnique: mocks.meltOperationFindUnique,
                        findUniqueOrThrow: mocks.meltOperationFindUniqueOrThrow,
                        create: mocks.meltOperationCreate,
                        update: mocks.meltOperationUpdate,
                        updateMany: mocks.meltOperationUpdateMany,
                    },
                    proof: {
                        updateMany: mocks.proofUpdateMany,
                        count: mocks.proofCount,
                        findMany: mocks.proofFindMany,
                        findUnique: mocks.proofFindUnique,
                        create: mocks.proofCreate,
                    },
                })
            } catch (error) {
                operation = operationBefore
                proofStatus = statusBefore
                reservedByIntentId = reservationBefore
                storedChange.clear()
                for (const [key, value] of changeBefore) storedChange.set(key, value)
                throw error
            }
        })
    })

    it('prepares an exact proof plan without spending or reserving proofs', async () => {
        const result = await SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE)

        expect(result).toMatchObject({
            state: MeltOperationState.PREPARED,
            amount: 100,
            fee_reserve: 5,
            input_fee: 2,
            max_spend: 107,
            proof_input_total: 107,
            minimum_change: 0,
            payment_hash: PAYMENT_HASH,
        })
        expect(proofStatus).toBe(ProofStatus.UNSPENT)
        expect(reservedByIntentId).toBeNull()
        expect(operation.keysetId).toBe('keyset-1')
        expect(operation.request).toBe(INVOICE)
        expect(operation.quoteId).toBe('private-quote-id')
        expect(result.invoice_sha256).toBe(SplitMeltService.sha256(operation.request))
        expect(result.quote_sha256).toBe(SplitMeltService.sha256(operation.quoteId))
        expect(result.proof_plan_sha256).toBe(SplitMeltService.sha256(operation.selectedProofsJson))
        expect(JSON.stringify(result)).not.toContain(INVOICE)
        expect(JSON.stringify(result)).not.toContain('private-quote-id')
        expect(JSON.stringify(result)).not.toContain(selectedProof.secret)
        expect(mocks.completeMelt).not.toHaveBeenCalled()
    })

    it('prepares a proof selection with deterministic minimum change without swapping', async () => {
        mocks.selectProofsToSend.mockReturnValue({
            keep: [],
            send: [{ ...selectedProof, amount: Amount.from(108) }],
        })
        mocks.prepareMelt.mockResolvedValueOnce({
            method: 'bolt11',
            inputs: [{ ...selectedProof, amount: Amount.from(108) }],
            outputData: [OutputData.createSingleRandomData(1, 'keyset-1')],
            keysetId: 'keyset-1',
            quote: quote(),
        })

        const result = await SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE)

        expect(result).toMatchObject({
            max_spend: 107,
            proof_input_total: 108,
            minimum_change: 1,
        })
        expect(mocks.prepareMelt).toHaveBeenCalledTimes(1)
        expect(operation).not.toBeNull()
    })

    it('rejects a selected proof set that cannot cover the maximum spend', async () => {
        mocks.selectProofsToSend.mockReturnValue({
            keep: [],
            send: [{ ...selectedProof, amount: Amount.from(106) }],
        })

        await expect(SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
        expect(mocks.prepareMelt).not.toHaveBeenCalled()
        expect(mocks.proofUpdateMany).not.toHaveBeenCalled()
        expect(operation).toBeNull()
    })

    it('rejects a preview that changes the selected proof inputs', async () => {
        mocks.prepareMelt.mockResolvedValueOnce({
            method: 'bolt11',
            inputs: [{ ...selectedProof, secret: 'different-secret' }],
            outputData: [OutputData.createSingleRandomData(1, 'keyset-1')],
            keysetId: 'keyset-1',
            quote: quote(),
        })

        await expect(SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE))
            .rejects.toMatchObject({ code: 'INVALID_PROOF_PLAN' })
        expect(mocks.proofUpdateMany).not.toHaveBeenCalled()
        expect(operation).toBeNull()
    })

    it('rejects a change-bearing preview without recovery outputs', async () => {
        mocks.prepareMelt.mockResolvedValueOnce({
            method: 'bolt11',
            inputs: [selectedProof],
            outputData: [],
            keysetId: 'keyset-1',
            quote: quote(),
        })

        await expect(SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE))
            .rejects.toMatchObject({ code: 'INVALID_PROOF_PLAN' })
        expect(mocks.proofUpdateMany).not.toHaveBeenCalled()
        expect(operation).toBeNull()
    })

    it('leaves proofs available while approval is pending', async () => {
        await SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE)

        expect(mocks.meltOperationCreate).toHaveBeenCalledTimes(1)
        expect(mocks.proofUpdateMany).not.toHaveBeenCalled()
        expect(proofStatus).toBe(ProofStatus.UNSPENT)
        expect(reservedByIntentId).toBeNull()
    })

    it('fails closed at execution when the approved proofs are no longer available', async () => {
        const prepared = await SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE)
        proofStatus = ProofStatus.SPENT

        await expect(SplitMeltService.execute(storedWallet, INTENT_ID, approval(prepared)))
            .rejects.toMatchObject({ code: 'PROOF_RESERVATION_MISMATCH' })

        expect(operation.state).toBe(MeltOperationState.PREPARED)
        expect(operation.executionCount).toBe(0)
        expect(mocks.completeMelt).not.toHaveBeenCalled()
    })

    it('reconstructs the persisted preview, executes once, and verifies the preimage', async () => {
        const prepared = await SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE)
        const result = await SplitMeltService.execute(storedWallet, INTENT_ID, approval(prepared))

        expect(result).toMatchObject({
            state: MeltOperationState.PAID,
            quote_state: MeltQuoteState.PAID,
            proof_states: [CheckStateEnum.SPENT],
            payment_preimage: PAYMENT_PREIMAGE,
            fee_paid: 7,
            total_spent: 107,
            balance_after: 0,
        })
        expect(proofStatus).toBe(ProofStatus.SPENT)
        expect(reservedByIntentId).toBeNull()
        expect(operation.executionCount).toBe(1)
        expect(mocks.completeMelt).toHaveBeenCalledTimes(1)
        expect(mocks.completeMelt.mock.calls[0][0]).toMatchObject({
            method: 'bolt11',
            keysetId: 'keyset-1',
            quote: { quote: 'private-quote-id' },
        })

        await expect(SplitMeltService.execute(storedWallet, INTENT_ID, approval(prepared)))
            .rejects.toMatchObject({ code: 'OPERATION_ALREADY_EXECUTED' })
        expect(mocks.completeMelt).toHaveBeenCalledTimes(1)
    })

    it('never retries an ambiguous melt and reconciles it after restart', async () => {
        const prepared = await SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE)
        mocks.completeMelt.mockRejectedValueOnce(new Error('connection lost'))
        mocks.checkMeltQuoteBolt11.mockRejectedValueOnce(new Error('mint unavailable'))

        const unknown = await SplitMeltService.execute(storedWallet, INTENT_ID, approval(prepared))
        expect(unknown).toMatchObject({
            state: MeltOperationState.UNKNOWN,
            error_code: 'reconciliation_unavailable',
        })
        expect(mocks.completeMelt).toHaveBeenCalledTimes(1)

        mocks.checkMeltQuoteBolt11.mockResolvedValueOnce(quote(MeltQuoteState.PENDING))
        mocks.checkProofsStates.mockResolvedValueOnce([{ state: CheckStateEnum.PENDING }])
        const pending = await SplitMeltService.status(storedWallet, INTENT_ID)
        expect(pending).toMatchObject({ state: MeltOperationState.PENDING })
        expect(mocks.completeMelt).toHaveBeenCalledTimes(1)
        expect(operation.executionCount).toBe(1)
    })

    it('expires without executing and leaves proofs unreserved', async () => {
        const prepared = await SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE)
        vi.spyOn(Date, 'now').mockReturnValue((NOW + 3_601) * 1000)

        const result = await SplitMeltService.execute(storedWallet, INTENT_ID, approval(prepared))

        expect(result).toMatchObject({
            state: MeltOperationState.EXPIRED,
            error_code: 'quote_expired',
        })
        expect(proofStatus).toBe(ProofStatus.UNSPENT)
        expect(reservedByIntentId).toBeNull()
        expect(operation.executionCount).toBe(0)
        expect(mocks.completeMelt).not.toHaveBeenCalled()
    })

    it('also closes an expired PREPARED operation during status polling', async () => {
        await SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE)
        vi.spyOn(Date, 'now').mockReturnValue((NOW + 3_601) * 1000)

        const result = await SplitMeltService.status(storedWallet, INTENT_ID)

        expect(result).toMatchObject({ state: MeltOperationState.EXPIRED })
        expect(proofStatus).toBe(ProofStatus.UNSPENT)
        expect(reservedByIntentId).toBeNull()
        expect(operation.executionCount).toBe(0)
    })

    it('rejects approval hash tampering before reserving execution', async () => {
        const prepared = await SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE)

        await expect(SplitMeltService.execute(storedWallet, INTENT_ID, {
            ...approval(prepared),
            quoteSha256: '00'.repeat(32),
        })).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' })

        expect(operation.executionCount).toBe(0)
        expect(mocks.completeMelt).not.toHaveBeenCalled()
    })

    it('keeps a paid-looking result UNKNOWN when the preimage is wrong', async () => {
        const prepared = await SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE)
        mocks.completeMelt.mockResolvedValueOnce({
            quote: quote(MeltQuoteState.PAID, '22'.repeat(32)),
            change: [],
            outputData: [],
        })

        const result = await SplitMeltService.execute(storedWallet, INTENT_ID, approval(prepared))
        expect(result).toMatchObject({
            state: MeltOperationState.UNKNOWN,
            error_code: 'preimage_mismatch',
            payment_preimage: null,
        })
        expect(proofStatus).toBe(ProofStatus.PENDING)
    })

    it('marks UNPAID only when every selected proof is UNSPENT', async () => {
        const prepared = await SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE)
        mocks.completeMelt.mockResolvedValueOnce({
            quote: quote(MeltQuoteState.UNPAID),
            change: [],
            outputData: [],
        })
        mocks.checkProofsStates.mockResolvedValueOnce([{ state: CheckStateEnum.UNSPENT }])

        const result = await SplitMeltService.execute(storedWallet, INTENT_ID, approval(prepared))
        expect(result).toMatchObject({ state: MeltOperationState.UNPAID })
        expect(proofStatus).toBe(ProofStatus.UNSPENT)
        expect(reservedByIntentId).toBeNull()
    })

    it('stores recovered change idempotently across later PAID reconciliation', async () => {
        const changeProof = {
            id: 'change-keyset',
            amount: Amount.from(3),
            secret: 'change-secret',
            C: 'change-C',
        }
        const prepared = await SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE)
        mocks.completeMelt.mockResolvedValueOnce({
            quote: quote(MeltQuoteState.PAID, PAYMENT_PREIMAGE),
            change: [changeProof],
            outputData: [],
        })
        const paid = await SplitMeltService.execute(storedWallet, INTENT_ID, approval(prepared))
        expect(paid).toMatchObject({
            fee_paid: 4,
            total_spent: 104,
            balance_after: 3,
        })
        expect(mocks.proofCreate).toHaveBeenCalledTimes(1)

        mocks.checkMeltQuoteBolt11.mockResolvedValueOnce({
            ...quote(MeltQuoteState.PAID, PAYMENT_PREIMAGE),
            change: [{}],
        })
        mocks.checkProofsStates.mockResolvedValueOnce([{ state: CheckStateEnum.SPENT }])
        mocks.createMeltChangeProofs.mockReturnValueOnce([changeProof])
        const recovered = await SplitMeltService.status(storedWallet, INTENT_ID)

        expect(mocks.proofCreate).toHaveBeenCalledTimes(1)
        expect(operation.state).toBe(MeltOperationState.PAID)
        expect(recovered).toMatchObject({
            fee_paid: 4,
            total_spent: 104,
            balance_after: 3,
        })
    })

    it('fails closed when recovered change would make the paid receipt impossible', async () => {
        const impossibleChange = {
            id: 'change-keyset',
            amount: Amount.from(108),
            secret: 'impossible-change-secret',
            C: 'impossible-change-C',
        }
        const prepared = await SplitMeltService.prepare(storedWallet, INTENT_ID, INVOICE)
        mocks.completeMelt.mockResolvedValueOnce({
            quote: quote(MeltQuoteState.PAID, PAYMENT_PREIMAGE),
            change: [impossibleChange],
            outputData: [],
        })

        const result = await SplitMeltService.execute(storedWallet, INTENT_ID, approval(prepared))

        expect(result).toMatchObject({
            state: MeltOperationState.UNKNOWN,
            fee_paid: null,
            total_spent: null,
            balance_after: null,
            error_code: 'invalid_paid_receipt',
        })
        expect(proofStatus).toBe(ProofStatus.PENDING)
    })
})
