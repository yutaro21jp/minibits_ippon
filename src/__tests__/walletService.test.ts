import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Amount, MeltQuoteState, CheckStateEnum, MintOperationError } from '@cashu/cashu-ts'
import { ProofStatus } from '@prisma/client'

// ── hoisted mock fns ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
    walletLoadMint: vi.fn(),
    walletSend: vi.fn(),
    walletReceive: vi.fn(),
    walletCheckProofsStates: vi.fn(),
    walletCreateMintQuoteBolt11: vi.fn(),
    walletCheckMintQuoteBolt11: vi.fn(),
    walletMintProofsBolt11: vi.fn(),
    walletCreateMeltQuoteBolt11: vi.fn(),
    walletCheckMeltQuoteBolt11: vi.fn(),
    walletMeltProofsBolt11: vi.fn(),
    prismaProofAggregate: vi.fn(),
    prismaProofFindMany: vi.fn(),
    prismaProofCreate: vi.fn(),
    prismaProofUpdateMany: vi.fn(),
}))

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../services/logService', () => ({
    log: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@cashu/cashu-ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@cashu/cashu-ts')>()
    return {
        ...actual,
        Wallet: vi.fn().mockImplementation(() => ({
            loadMint: mocks.walletLoadMint,
            send: mocks.walletSend,
            receive: mocks.walletReceive,
            checkProofsStates: mocks.walletCheckProofsStates,
            createMintQuoteBolt11: mocks.walletCreateMintQuoteBolt11,
            checkMintQuoteBolt11: mocks.walletCheckMintQuoteBolt11,
            mintProofsBolt11: mocks.walletMintProofsBolt11,
            createMeltQuoteBolt11: mocks.walletCreateMeltQuoteBolt11,
            checkMeltQuoteBolt11: mocks.walletCheckMeltQuoteBolt11,
            meltProofsBolt11: mocks.walletMeltProofsBolt11,
        })),
    }
})

vi.mock('../utils/prismaClient', () => ({
    default: {
        proof: {
            aggregate: mocks.prismaProofAggregate,
            findMany: mocks.prismaProofFindMany,
            create: mocks.prismaProofCreate,
            updateMany: mocks.prismaProofUpdateMany,
        },
        wallet: { create: vi.fn(), findUnique: vi.fn() },
    },
}))

// ── import service after mocks ─────────────────────────────────────────────────

import { WalletService } from '../services/walletService'

// ── fixtures ───────────────────────────────────────────────────────────────────

const makeProof = (secret: string, amount = 100) => ({
    id: `id-${secret}`, amount: Amount.from(amount), secret, C: `C-${secret}`,
})

const makeDbProof = (secret: string, amount = 100) => ({
    id: 1, walletId: 1, proofId: `id-${secret}`, amount, secret,
    C: `C-${secret}`, dleq: null, witness: null, status: ProofStatus.UNSPENT,
    createdAt: new Date(),
})

// ── tests ─────────────────────────────────────────────────────────────────────

describe('WalletService.getProofsAmount', () => {
    it('sums proof amounts', () => {
        const proofs = [makeProof('a', 100), makeProof('b', 200), makeProof('c', 50)]
        expect(WalletService.getProofsAmount(proofs).toNumber()).toBe(350)
    })

    it('returns 0 for empty array', () => {
        expect(WalletService.getProofsAmount([]).toNumber()).toBe(0)
    })
})

describe('WalletService.getWalletBalance', () => {
    beforeEach(() => vi.clearAllMocks())

    it('returns unspent and pending balance', async () => {
        mocks.prismaProofAggregate
            .mockResolvedValueOnce({ _sum: { amount: 5000 } })
            .mockResolvedValueOnce({ _sum: { amount: 300 } })

        const result = await WalletService.getWalletBalance(1)
        expect(result.balance.toNumber()).toBe(5000)
        expect(result.pendingBalance.toNumber()).toBe(300)
    })

    it('returns 0 when no proofs exist', async () => {
        mocks.prismaProofAggregate
            .mockResolvedValueOnce({ _sum: { amount: null } })
            .mockResolvedValueOnce({ _sum: { amount: null } })

        const result = await WalletService.getWalletBalance(1)
        expect(result.balance.toNumber()).toBe(0)
        expect(result.pendingBalance.toNumber()).toBe(0)
    })
})

describe('WalletService.syncProofsStateWithMint', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.walletLoadMint.mockResolvedValue(undefined)
    })

    it('returns zeros when no pending proofs exist', async () => {
        mocks.prismaProofFindMany.mockResolvedValue([])
        const result = await WalletService.syncProofsStateWithMint(1, 'https://testmint.example.com')
        expect(result).toEqual({ spent: 0, pending: 0, unspent: 0 })
        expect(mocks.walletCheckProofsStates).not.toHaveBeenCalled()
        expect(mocks.prismaProofFindMany).toHaveBeenCalledWith({
            where: {
                walletId: 1,
                status: ProofStatus.PENDING,
                reservedByIntentId: null,
            },
        })
    })

    it('marks SPENT proofs correctly', async () => {
        const pendingProofs = [makeDbProof('s1'), makeDbProof('s2')]
        mocks.prismaProofFindMany.mockResolvedValue(pendingProofs)
        mocks.walletCheckProofsStates.mockResolvedValue([
            { state: CheckStateEnum.SPENT },
            { state: CheckStateEnum.SPENT },
        ])

        const result = await WalletService.syncProofsStateWithMint(1, 'https://testmint.example.com')
        expect(result.spent).toBe(2)
        expect(result.unspent).toBe(0)
        expect(mocks.prismaProofUpdateMany).toHaveBeenCalledWith({
            where: { walletId: 1, secret: { in: ['s1', 's2'] } },
            data: { status: ProofStatus.SPENT },
        })
    })

    it('marks UNSPENT proofs correctly', async () => {
        const pendingProofs = [makeDbProof('s1'), makeDbProof('s2')]
        mocks.prismaProofFindMany.mockResolvedValue(pendingProofs)
        mocks.walletCheckProofsStates.mockResolvedValue([
            { state: CheckStateEnum.UNSPENT },
            { state: CheckStateEnum.UNSPENT },
        ])

        const result = await WalletService.syncProofsStateWithMint(1, 'https://testmint.example.com')
        expect(result.unspent).toBe(2)
        expect(result.spent).toBe(0)
        expect(mocks.prismaProofUpdateMany).toHaveBeenCalledWith({
            where: { walletId: 1, secret: { in: ['s1', 's2'] } },
            data: { status: ProofStatus.UNSPENT },
        })
    })

    it('leaves PENDING proofs untouched', async () => {
        mocks.prismaProofFindMany.mockResolvedValue([makeDbProof('s1')])
        mocks.walletCheckProofsStates.mockResolvedValue([{ state: CheckStateEnum.PENDING }])

        const result = await WalletService.syncProofsStateWithMint(1, 'https://testmint.example.com')
        expect(result).toEqual({ spent: 0, unspent: 0, pending: 1 })
        expect(mocks.prismaProofUpdateMany).not.toHaveBeenCalled()
    })

    it('handles mixed states correctly', async () => {
        const pendingProofs = [makeDbProof('s1'), makeDbProof('s2'), makeDbProof('s3')]
        mocks.prismaProofFindMany.mockResolvedValue(pendingProofs)
        mocks.walletCheckProofsStates.mockResolvedValue([
            { state: CheckStateEnum.SPENT },
            { state: CheckStateEnum.UNSPENT },
            { state: CheckStateEnum.PENDING },
        ])

        const result = await WalletService.syncProofsStateWithMint(1, 'https://testmint.example.com')
        expect(result).toEqual({ spent: 1, unspent: 1, pending: 1 })
    })
})

describe('WalletService.sendProofs', () => {
    const WALLET_ID = 1

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.walletLoadMint.mockResolvedValue(undefined)
    })

    it('throws VALIDATION_ERROR when balance insufficient', async () => {
        mocks.prismaProofFindMany.mockResolvedValue([makeDbProof('s1', 50)])

        await expect(WalletService.sendProofs(WALLET_ID, 100, 'https://testmint.example.com'))
            .rejects.toMatchObject({ name: 'VALIDATION_ERROR' })
    })

    it('passes P2PK pubkey as outputConfig to wallet.send', async () => {
        mocks.prismaProofFindMany.mockResolvedValue([makeDbProof('s1', 200)])
        mocks.walletSend.mockResolvedValue({
            keep: [makeProof('k1', 100)],
            send: [makeProof('send1', 100)],
        })
        mocks.prismaProofCreate.mockResolvedValue({})
        mocks.prismaProofUpdateMany.mockResolvedValue({})

        const pubkey = '02' + '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
        await WalletService.sendProofs(WALLET_ID, 100, 'https://testmint.example.com', pubkey)

        expect(mocks.walletSend.mock.calls[0][0].toNumber()).toBe(100)
        expect(mocks.walletSend.mock.calls[0].slice(1)).toEqual([
            expect.any(Array),
            { includeFees: true },
            { send: { type: 'p2pk', options: { pubkey } } },
        ])
    })

    it('calls wallet.send without outputConfig when no pubkey', async () => {
        mocks.prismaProofFindMany.mockResolvedValue([makeDbProof('s1', 200)])
        mocks.walletSend.mockResolvedValue({
            keep: [makeProof('k1', 100)],
            send: [makeProof('send1', 100)],
        })
        mocks.prismaProofCreate.mockResolvedValue({})
        mocks.prismaProofUpdateMany.mockResolvedValue({})

        await WalletService.sendProofs(WALLET_ID, 100, 'https://testmint.example.com')

        expect(mocks.walletSend.mock.calls[0][0].toNumber()).toBe(100)
        expect(mocks.walletSend.mock.calls[0].slice(1)).toEqual([
            expect.any(Array), { includeFees: true }, undefined,
        ])
    })
})

describe('WalletService.meltProofs — error handling', () => {
    const WALLET_ID = 1
    const MELT_QUOTE = {
        quote: 'mq1', amount: Amount.from(500), fee_reserve: Amount.from(10),
        state: MeltQuoteState.UNPAID, expiry: 3600,
        unit: 'sat', request: 'lnbc...', payment_preimage: null,
    }

    beforeEach(() => {
        vi.resetAllMocks()
        mocks.walletLoadMint.mockResolvedValue(undefined)
        mocks.prismaProofFindMany.mockResolvedValue([makeDbProof('s1', 1000)])
        mocks.walletSend.mockResolvedValue({
            keep: [makeProof('k1', 490)],
            send: [makeProof('send1', 510)],
        })
        mocks.prismaProofCreate.mockResolvedValue({})
        mocks.prismaProofUpdateMany.mockResolvedValue({})
    })

    it('marks send proofs SPENT and saves change on successful melt', async () => {
        mocks.walletMeltProofsBolt11.mockResolvedValue({
            quote: { ...MELT_QUOTE, state: MeltQuoteState.PAID, payment_preimage: 'pi' },
            change: [makeProof('change1', 5)],
        })

        const result = await WalletService.meltProofs(WALLET_ID, MELT_QUOTE, 'https://testmint.example.com')
        expect(result.quote.state).toBe(MeltQuoteState.PAID)
        expect(mocks.prismaProofUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: ProofStatus.SPENT } })
        )
        expect(mocks.prismaProofCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: ProofStatus.UNSPENT }),
            })
        )
    })

    it('throws 202 TIMEOUT_ERROR when quote is PENDING after melt failure', async () => {
        mocks.walletMeltProofsBolt11.mockRejectedValue(new Error('network error'))
        mocks.walletCheckMeltQuoteBolt11.mockResolvedValue({
            ...MELT_QUOTE, state: MeltQuoteState.PENDING,
        })

        await expect(WalletService.meltProofs(WALLET_ID, MELT_QUOTE, 'https://testmint.example.com'))
            .rejects.toMatchObject({ statusCode: 202, name: 'TIMEOUT_ERROR' })
    })

    it('reverts send proofs to UNSPENT on generic UNPAID error', async () => {
        mocks.walletMeltProofsBolt11.mockRejectedValue(new Error('some generic error'))
        mocks.walletCheckMeltQuoteBolt11.mockResolvedValue({
            ...MELT_QUOTE, state: MeltQuoteState.UNPAID,
        })

        await expect(WalletService.meltProofs(WALLET_ID, MELT_QUOTE, 'https://testmint.example.com'))
            .rejects.toMatchObject({ statusCode: 500, name: 'CONNECTION_ERROR' })

        expect(mocks.prismaProofUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: ProofStatus.UNSPENT } })
        )
    })

    it('throws 202 TIMEOUT_ERROR on mint error code 11002 (proofs pending)', async () => {
        const mintErr = new MintOperationError(11002, 'proofs pending')
        mocks.walletMeltProofsBolt11.mockRejectedValue(mintErr)
        mocks.walletCheckMeltQuoteBolt11.mockResolvedValue({
            ...MELT_QUOTE, state: MeltQuoteState.UNPAID,
        })
        // second findMany is for syncProofsStateWithMint — return empty so it's a no-op
        mocks.prismaProofFindMany
            .mockResolvedValueOnce([makeDbProof('s1', 1000)])
            .mockResolvedValueOnce([])

        await expect(WalletService.meltProofs(WALLET_ID, MELT_QUOTE, 'https://testmint.example.com'))
            .rejects.toMatchObject({ statusCode: 202, name: 'TIMEOUT_ERROR' })
    })

    it('calls syncProofsStateWithMint on mint error code 11001 (proofs already spent)', async () => {
        const mintErr = new MintOperationError(11001, 'proofs already spent')
        mocks.walletMeltProofsBolt11.mockRejectedValue(mintErr)
        mocks.walletCheckMeltQuoteBolt11.mockResolvedValue({
            ...MELT_QUOTE, state: MeltQuoteState.UNPAID,
        })
        mocks.walletCheckProofsStates.mockResolvedValue([{ state: CheckStateEnum.SPENT }])
        mocks.prismaProofFindMany
            .mockResolvedValueOnce([makeDbProof('s1', 1000)])
            .mockResolvedValueOnce([makeDbProof('s1', 1000)])

        await expect(WalletService.meltProofs(WALLET_ID, MELT_QUOTE, 'https://testmint.example.com'))
            .rejects.toMatchObject({ statusCode: 500, name: 'CONNECTION_ERROR' })

        expect(mocks.walletCheckProofsStates).toHaveBeenCalled()
    })

    it('throws 500 CONNECTION_ERROR when mint is unreachable after melt failure', async () => {
        mocks.walletMeltProofsBolt11.mockRejectedValue(new Error('connection refused'))
        mocks.walletCheckMeltQuoteBolt11.mockRejectedValue(new Error('timeout'))

        await expect(WalletService.meltProofs(WALLET_ID, MELT_QUOTE, 'https://testmint.example.com'))
            .rejects.toMatchObject({ statusCode: 500, name: 'CONNECTION_ERROR' })
    })
})
