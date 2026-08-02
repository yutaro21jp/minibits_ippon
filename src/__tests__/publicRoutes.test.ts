import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Amount } from '@cashu/cashu-ts'

// ── hoisted mock fns (available inside vi.mock factories) ───────────────────

const mocks = vi.hoisted(() => ({
    prismaWalletCreate: vi.fn(),
    prismaWalletDelete: vi.fn(),
    prismaProofDeleteMany: vi.fn(),
    receiveToken: vi.fn(),
    getTokenAmount: vi.fn(),
    getProofsAmount: vi.fn(),
}))

// ── mocks ───────────────────────────────────────────────────────────────────

vi.mock('../services/logService', () => ({
    log: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../utils/prismaClient', () => ({
    default: {
        wallet: {
            create: mocks.prismaWalletCreate,
            delete: mocks.prismaWalletDelete,
        },
        proof: {
            deleteMany: mocks.prismaProofDeleteMany,
        },
    },
}))

vi.mock('../services/walletService', () => ({
    WalletService: {
        getMintUrls: vi.fn().mockReturnValue(['https://testmint.example.com']),
        receiveToken: mocks.receiveToken,
        getTokenAmount: mocks.getTokenAmount,
        getProofsAmount: mocks.getProofsAmount,
        getWalletBalance: vi.fn().mockResolvedValue({ balance: 0, pendingBalance: 0 }),
        sendProofs: vi.fn(),
        saveProofs: vi.fn(),
        loadProofs: vi.fn(),
        updateProofsStatus: vi.fn(),
        createMintQuote: vi.fn(),
        checkMintQuote: vi.fn(),
        mintProofs: vi.fn(),
        createMeltQuote: vi.fn(),
        checkMeltQuote: vi.fn(),
        meltProofs: vi.fn(),
        syncProofsStateWithMint: vi.fn(),
        checkTokenState: vi.fn(),
    },
}))

// ── app under test ──────────────────────────────────────────────────────────

import { buildApp } from '../app'

// ── fixtures ────────────────────────────────────────────────────────────────

const CREATED_WALLET = {
    id: 42,
    accessKey: 'test-access-key-hex',
    name: 'test-wallet',
    mint: 'https://testmint.example.com',
    unit: 'sat',
    maxBalance: null,
    maxSend: null,
    maxPay: null,
    createdAt: new Date(),
    updatedAt: null,
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('GET /v1/info', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        app = await buildApp()
        await app.ready()
    })

    it('returns service info with env values', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/info' })
        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.status).toBe('operational')
        expect(body.unit).toBe('sat')
        expect(body.mints).toEqual(['https://testmint.example.com'])
        expect(body.limits.max_balance).toBe(100000)
        expect(body.limits.max_send).toBe(50000)
        expect(body.limits.max_pay).toBe(50000)
    })
})

describe('POST /v1/wallet', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletCreate.mockResolvedValue(CREATED_WALLET)
        mocks.getTokenAmount.mockReturnValue(Amount.from(1))
        app = await buildApp()
        await app.ready()
    })

    it('creates a wallet without a token', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/wallet',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'test-wallet' }),
        })

        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.access_key).toBe(CREATED_WALLET.accessKey)
        expect(body.unit).toBe('sat')
        expect(body.balance).toBe(0)
        expect(mocks.prismaWalletCreate).toHaveBeenCalledOnce()
        expect(mocks.receiveToken).not.toHaveBeenCalled()
    })

    it('creates a wallet and receives initial token', async () => {
        const mockProofs = [{ id: 'p1', amount: 100, secret: 'sec1', C: 'C1' }]
        mocks.receiveToken.mockResolvedValue(mockProofs)
        mocks.getTokenAmount.mockReturnValue(Amount.from(100))
        mocks.getProofsAmount.mockReturnValue(Amount.from(100))

        const res = await app.inject({
            method: 'POST',
            url: '/v1/wallet',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'funded-wallet', token: 'cashuBtest' }),
        })

        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.balance).toBe(100)
        expect(mocks.receiveToken).toHaveBeenCalledWith(CREATED_WALLET.id, 'cashuBtest', CREATED_WALLET.mint)
    })

    it('rejects token that exceeds max balance', async () => {
        const bigProofs = [{ id: 'p1', amount: 999999, secret: 'sec1', C: 'C1' }]
        mocks.receiveToken.mockResolvedValue(bigProofs)
        mocks.getTokenAmount.mockReturnValue(Amount.from(999999))

        const res = await app.inject({
            method: 'POST',
            url: '/v1/wallet',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: 'cashuBbig' }),
        })

        expect(res.statusCode).toBe(400)
        expect(res.json().error.name).toBe('LIMIT_ERROR')
        expect(mocks.prismaWalletDelete).toHaveBeenCalled()
    })

    it('cleans up wallet if token receive fails', async () => {
        mocks.receiveToken.mockRejectedValue(new Error('invalid token'))

        const res = await app.inject({
            method: 'POST',
            url: '/v1/wallet',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: 'cashuBbad' }),
        })

        expect(res.statusCode).toBe(400)
        expect(mocks.prismaWalletDelete).toHaveBeenCalledWith({ where: { id: CREATED_WALLET.id } })
    })
})
