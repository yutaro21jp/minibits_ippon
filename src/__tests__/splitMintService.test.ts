import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Amount, MintQuoteState, OutputData } from '@cashu/cashu-ts'
import { MintOperationState, ProofStatus } from '@prisma/client'

const INTENT_ID = 'wallet_0123456789abcdef01234567'
const INVOICE = 'lnbc1lockedtestinvoice'
const QUOTE_ID = 'private-locked-quote'
const NOW = 2_000_000_000

const mocks = vi.hoisted(() => ({
    getWallet: vi.fn(),
    getWalletBalance: vi.fn(),
    proofStorageData: vi.fn(),
    createLockedMintQuote: vi.fn(),
    prepareMint: vi.fn(),
    completeMint: vi.fn(),
    checkMintQuoteBolt11: vi.fn(),
    restore: vi.fn(),
    ensureKeysetKeys: vi.fn(),
    getKeyset: vi.fn(),
    mintOperationFindUnique: vi.fn(),
    mintOperationFindUniqueOrThrow: vi.fn(),
    mintOperationCreate: vi.fn(),
    mintOperationUpdate: vi.fn(),
    mintOperationUpdateMany: vi.fn(),
    mintOperationAggregate: vi.fn(),
    proofFindUnique: vi.fn(),
    proofCreate: vi.fn(),
    proofAggregate: vi.fn(),
    transaction: vi.fn(),
}))

vi.mock('@gandlaf21/bolt11-decode', () => ({
    decode: vi.fn(() => ({ paymentRequest: INVOICE, sections: [], route_hints: [] })),
}))

vi.mock('../services/walletService', () => ({
    WalletService: {
        getWallet: mocks.getWallet,
        getWalletBalance: mocks.getWalletBalance,
        proofStorageData: mocks.proofStorageData,
    },
}))

vi.mock('../utils/prismaClient', () => ({
    default: {
        mintOperation: {
            findUnique: mocks.mintOperationFindUnique,
            findUniqueOrThrow: mocks.mintOperationFindUniqueOrThrow,
            create: mocks.mintOperationCreate,
            update: mocks.mintOperationUpdate,
            updateMany: mocks.mintOperationUpdateMany,
            aggregate: mocks.mintOperationAggregate,
        },
        proof: {
            findUnique: mocks.proofFindUnique,
            create: mocks.proofCreate,
            aggregate: mocks.proofAggregate,
        },
        $transaction: mocks.transaction,
    },
}))

import { SplitMintService } from '../services/splitMintService'

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

const output = OutputData.createSingleRandomData(64, 'keyset-1')
const issuedProof = {
    id: 'keyset-1',
    amount: Amount.from(64),
    secret: 'issued-secret',
    C: 'issued-C',
}

function quote(state: MintQuoteState, pubkey: string) {
    return {
        quote: QUOTE_ID,
        request: INVOICE,
        unit: 'sat',
        amount: Amount.from(64),
        state,
        expiry: NOW + 3_600,
        pubkey,
    }
}

function hashes(prepared: Awaited<ReturnType<typeof SplitMintService.prepare>>) {
    return {
        invoiceSha256: prepared.invoice_sha256!,
        quoteSha256: prepared.quote_sha256!,
        outputPlanSha256: prepared.output_plan_sha256!,
    }
}

describe('SplitMintService', () => {
    let operation: any
    const storedProofs = new Map<string, any>()
    const wallet = {
        createLockedMintQuote: mocks.createLockedMintQuote,
        prepareMint: mocks.prepareMint,
        completeMint: mocks.completeMint,
        checkMintQuoteBolt11: mocks.checkMintQuoteBolt11,
        mint: { restore: mocks.restore },
        keyChain: { ensureKeysetKeys: mocks.ensureKeysetKeys },
        getKeyset: mocks.getKeyset,
    }

    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000)
        operation = null
        storedProofs.clear()

        mocks.getWallet.mockResolvedValue(wallet)
        mocks.getWalletBalance.mockResolvedValue({
            balance: Amount.zero(),
            pendingBalance: Amount.zero(),
        })
        mocks.createLockedMintQuote.mockImplementation(async (_amount, pubkey) => (
            quote(MintQuoteState.UNPAID, pubkey)
        ))
        mocks.prepareMint.mockResolvedValue({
            method: 'bolt11',
            payload: {
                quote: QUOTE_ID,
                outputs: [output.blindedMessage],
                signature: '11'.repeat(64),
            },
            outputData: [output],
            keysetId: 'keyset-1',
            quote: { quote: QUOTE_ID },
            legacySignature: '22'.repeat(64),
        })
        mocks.completeMint.mockResolvedValue([issuedProof])
        mocks.checkMintQuoteBolt11.mockImplementation(async () => (
            quote(MintQuoteState.PAID, operation.quotePubkey)
        ))
        mocks.ensureKeysetKeys.mockResolvedValue({})
        mocks.getKeyset.mockReturnValue({ id: 'keyset-1', unit: 'sat', keys: {} })

        mocks.mintOperationFindUnique.mockImplementation(async () => operation)
        mocks.mintOperationAggregate.mockResolvedValue({ _sum: { amount: null } })
        mocks.mintOperationFindUniqueOrThrow.mockImplementation(async () => {
            if (!operation) throw new Error('not found')
            return operation
        })
        mocks.mintOperationCreate.mockImplementation(async ({ data }: any) => {
            operation = {
                quoteId: null,
                request: null,
                expiry: null,
                keysetId: null,
                outputDataJson: null,
                signature: null,
                legacySignature: null,
                invoiceSha256: null,
                quoteSha256: null,
                outputPlanSha256: null,
                executionCount: 0,
                proofsIssued: 0,
                balanceAfter: null,
                lastQuoteState: null,
                errorCode: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                executedAt: null,
                reconciledAt: null,
                ...data,
            }
            return operation
        })
        mocks.mintOperationUpdate.mockImplementation(async ({ data }: any) => {
            operation = { ...operation, ...data, updatedAt: new Date() }
            return operation
        })
        mocks.mintOperationUpdateMany.mockImplementation(async ({ where, data }: any) => {
            if (
                !operation
                || operation.intentId !== where.intentId
                || operation.walletId !== where.walletId
                || operation.state !== where.state
                || operation.executionCount !== where.executionCount
            ) {
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
        mocks.proofStorageData.mockImplementation((walletId, proof, status) => ({
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
        mocks.proofFindUnique.mockImplementation(async ({ where }: any) => (
            storedProofs.get(where.secret) ?? null
        ))
        mocks.proofCreate.mockImplementation(async ({ data }: any) => {
            storedProofs.set(data.secret, data)
            return data
        })
        mocks.proofAggregate.mockImplementation(async () => ({
            _sum: {
                amount: [...storedProofs.values()]
                    .filter(item => item.status === ProofStatus.UNSPENT)
                    .reduce((total, item) => total + item.amount, 0),
            },
        }))
        mocks.transaction.mockImplementation(async (callback: any) => callback({
            mintOperation: {
                findUniqueOrThrow: mocks.mintOperationFindUniqueOrThrow,
                update: mocks.mintOperationUpdate,
            },
            proof: {
                findUnique: mocks.proofFindUnique,
                create: mocks.proofCreate,
                aggregate: mocks.proofAggregate,
            },
        }))
    })

    it('creates a unique NUT-20 locked quote without exposing the quote key or id', async () => {
        const result = await SplitMintService.prepare(storedWallet, INTENT_ID, 64)

        expect(mocks.createLockedMintQuote).toHaveBeenCalledWith(
            64,
            expect.stringMatching(/^(02|03)[0-9a-f]{64}$/),
        )
        expect(result).toMatchObject({
            state: MintOperationState.PREPARED,
            quote_state: MintQuoteState.UNPAID,
            amount: 64,
            request: INVOICE,
            proofs_issued: 0,
        })
        expect(operation.quotePrivkey).toMatch(/^[0-9a-f]{64}$/)
        expect(operation.quotePubkey).toMatch(/^(02|03)[0-9a-f]{64}$/)
        expect(operation.outputDataJson).toContain(output.blindedMessage.B_)
        expect(JSON.stringify(result)).not.toContain(QUOTE_ID)
        expect(JSON.stringify(result)).not.toContain(operation.quotePrivkey)
        expect(JSON.stringify(result)).not.toContain(issuedProof.secret)
        expect(mocks.completeMint).not.toHaveBeenCalled()
    })

    it('rejects an unlocked quote and leaves the intent permanently unknown', async () => {
        mocks.createLockedMintQuote.mockResolvedValueOnce(
            quote(MintQuoteState.UNPAID, '02' + 'ab'.repeat(32)),
        )

        await expect(SplitMintService.prepare(storedWallet, INTENT_ID, 64))
            .rejects.toMatchObject({ code: 'INVALID_MINT_QUOTE' })

        expect(operation.state).toBe(MintOperationState.UNKNOWN)
        expect(operation.executionCount).toBe(0)
        expect(mocks.completeMint).not.toHaveBeenCalled()
    })

    it('rejects a receive that would cross the reviewed balance boundary', async () => {
        mocks.getWalletBalance.mockResolvedValueOnce({
            balance: Amount.from(2_147_483_647),
            pendingBalance: Amount.zero(),
        })

        await expect(SplitMintService.prepare(storedWallet, INTENT_ID, 1))
            .rejects.toMatchObject({ code: 'BALANCE_LIMIT_EXCEEDED' })

        expect(mocks.createLockedMintQuote).not.toHaveBeenCalled()
        expect(operation).toBeNull()
    })

    it('reserves unresolved receive amounts within the balance boundary', async () => {
        mocks.mintOperationAggregate.mockResolvedValueOnce({ _sum: { amount: 480 } })

        await expect(SplitMintService.prepare(
            { ...storedWallet, maxBalance: 512 },
            INTENT_ID,
            64,
        ))
            .rejects.toMatchObject({ code: 'BALANCE_LIMIT_EXCEEDED' })

        expect(mocks.createLockedMintQuote).not.toHaveBeenCalled()
        expect(operation).toBeNull()
    })

    it('issues once, stores proofs atomically, and clears bearer recovery material', async () => {
        const prepared = await SplitMintService.prepare(storedWallet, INTENT_ID, 64)
        const result = await SplitMintService.execute(storedWallet, INTENT_ID, hashes(prepared))

        expect(result).toMatchObject({
            state: MintOperationState.ISSUED,
            quote_state: MintQuoteState.ISSUED,
            proofs_issued: 1,
            balance: 64,
        })
        expect(operation.executionCount).toBe(1)
        expect(operation.quotePrivkey).toBeNull()
        expect(operation.outputDataJson).toBeNull()
        expect(operation.signature).toBeNull()
        expect(storedProofs.get(issuedProof.secret)).toMatchObject({
            amount: 64,
            status: ProofStatus.UNSPENT,
        })
        expect(mocks.completeMint).toHaveBeenCalledTimes(1)
    })

    it('never retries an ambiguous mint while the quote remains paid', async () => {
        const prepared = await SplitMintService.prepare(storedWallet, INTENT_ID, 64)
        mocks.completeMint.mockRejectedValueOnce(new Error('response lost'))

        const unknown = await SplitMintService.execute(storedWallet, INTENT_ID, hashes(prepared))
        expect(unknown).toMatchObject({
            state: MintOperationState.UNKNOWN,
            quote_state: MintQuoteState.PAID,
            error_code: 'mint_outcome_unknown',
        })

        const afterRestart = await SplitMintService.status(storedWallet, INTENT_ID)
        expect(afterRestart.state).toBe(MintOperationState.UNKNOWN)
        expect(operation.executionCount).toBe(1)
        expect(mocks.completeMint).toHaveBeenCalledTimes(1)
    })

    it('accepts status with optional NUT-20 pubkey and expiry omitted', async () => {
        await SplitMintService.prepare(storedWallet, INTENT_ID, 64)
        mocks.checkMintQuoteBolt11.mockResolvedValueOnce({
            ...quote(MintQuoteState.PAID, operation.quotePubkey),
            pubkey: undefined,
            expiry: null,
        })

        const paid = await SplitMintService.status(storedWallet, INTENT_ID)

        expect(paid).toMatchObject({
            state: MintOperationState.PAID,
            quote_state: MintQuoteState.PAID,
        })
    })

    it('recovers a pre-mint status outage without treating it as an attempted mint', async () => {
        await SplitMintService.prepare(storedWallet, INTENT_ID, 64)
        mocks.checkMintQuoteBolt11
            .mockRejectedValueOnce(new Error('status unavailable'))
            .mockResolvedValueOnce(quote(MintQuoteState.PAID, operation.quotePubkey))

        const unknown = await SplitMintService.status(storedWallet, INTENT_ID)
        const paid = await SplitMintService.status(storedWallet, INTENT_ID)

        expect(unknown).toMatchObject({
            state: MintOperationState.UNKNOWN,
            error_code: 'reconciliation_unavailable',
        })
        expect(paid).toMatchObject({
            state: MintOperationState.PAID,
            error_code: null,
        })
        expect(operation.executionCount).toBe(0)
        expect(mocks.completeMint).not.toHaveBeenCalled()
    })

    it('rejects a different NUT-20 pubkey when status includes one', async () => {
        await SplitMintService.prepare(storedWallet, INTENT_ID, 64)
        mocks.checkMintQuoteBolt11.mockResolvedValueOnce(
            quote(MintQuoteState.PAID, '02' + 'ab'.repeat(32)),
        )

        const unknown = await SplitMintService.status(storedWallet, INTENT_ID)

        expect(unknown).toMatchObject({
            state: MintOperationState.UNKNOWN,
            error_code: 'reconciliation_mismatch_pubkey',
        })
    })

    it('recovers issued proofs through NUT-09 without resending the mint request', async () => {
        const prepared = await SplitMintService.prepare(storedWallet, INTENT_ID, 64)
        mocks.completeMint.mockRejectedValueOnce(new Error('response lost'))
        mocks.checkMintQuoteBolt11
            .mockResolvedValueOnce(quote(MintQuoteState.PAID, operation.quotePubkey))
            .mockResolvedValueOnce(quote(MintQuoteState.ISSUED, operation.quotePubkey))
        mocks.restore.mockResolvedValueOnce({
            outputs: [output.blindedMessage],
            signatures: [{ id: 'keyset-1', amount: Amount.from(64), C_: 'restored-C' }],
        })
        vi.spyOn(OutputData.prototype, 'toProof').mockReturnValueOnce(issuedProof as any)

        const recovered = await SplitMintService.execute(storedWallet, INTENT_ID, hashes(prepared))

        expect(recovered.state).toBe(MintOperationState.ISSUED)
        expect(mocks.restore).toHaveBeenCalledTimes(1)
        expect(mocks.completeMint).toHaveBeenCalledTimes(1)
        expect(storedProofs.has(issuedProof.secret)).toBe(true)
    })

    it('expires an unpaid quote without minting and clears the private plan', async () => {
        await SplitMintService.prepare(storedWallet, INTENT_ID, 64)
        mocks.checkMintQuoteBolt11.mockResolvedValueOnce(
            quote(MintQuoteState.UNPAID, operation.quotePubkey),
        )
        vi.spyOn(Date, 'now').mockReturnValue((NOW + 3_601) * 1_000)

        const expired = await SplitMintService.status(storedWallet, INTENT_ID)

        expect(expired).toMatchObject({
            state: MintOperationState.EXPIRED,
            error_code: 'quote_expired',
        })
        expect(operation.quotePrivkey).toBeNull()
        expect(operation.outputDataJson).toBeNull()
        expect(mocks.completeMint).not.toHaveBeenCalled()
    })
})
