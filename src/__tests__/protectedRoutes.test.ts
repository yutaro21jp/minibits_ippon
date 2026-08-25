import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Amount } from '@cashu/cashu-ts'

// ── hoisted mock fns ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
    prismaWalletFindUnique: vi.fn(),
    prismaWalletCreate: vi.fn(),
    prismaWalletDelete: vi.fn(),
    prismaMeltOperationFindMany: vi.fn(),
    prismaMintOperationFindMany: vi.fn(),
    getWalletBalance: vi.fn(),
    createMintQuote: vi.fn(),
    checkMintQuote: vi.fn(),
    mintProofs: vi.fn(),
    saveProofs: vi.fn(),
    sendProofs: vi.fn(),
    receiveToken: vi.fn(),
    getProofsAmount: vi.fn(),
    getTokenAmount: vi.fn(),
    createMeltQuote: vi.fn(),
    meltProofs: vi.fn(),
    checkMeltQuote: vi.fn(),
    checkTokenState: vi.fn(),
    updateProofsStatus: vi.fn(),
    isSupportedCurrency: vi.fn(),
    getExchangeRate: vi.fn(),
}))

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../services/logService', () => ({
    log: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../utils/prismaClient', () => ({
    default: {
        wallet: {
            findUnique: mocks.prismaWalletFindUnique,
            create: mocks.prismaWalletCreate,
            delete: mocks.prismaWalletDelete,
        },
        proof: {
            aggregate: vi.fn(),
            findMany: vi.fn(),
            create: vi.fn(),
            updateMany: vi.fn(),
            deleteMany: vi.fn(),
        },
        meltOperation: {
            findMany: mocks.prismaMeltOperationFindMany,
        },
        mintOperation: {
            findMany: mocks.prismaMintOperationFindMany,
        },
    },
}))

vi.mock('../services/walletService', () => ({
    WalletService: {
        getWalletBalance: mocks.getWalletBalance,
        createMintQuote: mocks.createMintQuote,
        checkMintQuote: mocks.checkMintQuote,
        mintProofs: mocks.mintProofs,
        saveProofs: mocks.saveProofs,
        sendProofs: mocks.sendProofs,
        receiveToken: mocks.receiveToken,
        getProofsAmount: mocks.getProofsAmount,
        getTokenAmount: mocks.getTokenAmount,
        createMeltQuote: mocks.createMeltQuote,
        meltProofs: mocks.meltProofs,
        checkMeltQuote: mocks.checkMeltQuote,
        checkTokenState: mocks.checkTokenState,
        updateProofsStatus: mocks.updateProofsStatus,
    },
}))

vi.mock('../services/exchangeRateService', () => ({
    isSupportedCurrency: mocks.isSupportedCurrency,
    getExchangeRate: mocks.getExchangeRate,
}))

vi.mock('@cashu/cashu-ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@cashu/cashu-ts')>()
    return {
        ...actual,
        getEncodedToken: vi.fn().mockReturnValue('cashuBmocked_token'),
    }
})

vi.stubGlobal('fetch', vi.fn())

// ── app under test ────────────────────────────────────────────────────────────

import { buildApp } from '../app'

// ── fixtures ──────────────────────────────────────────────────────────────────

const WALLET = {
    id: 1,
    accessKey: 'valid-key',
    name: 'Test',
    mint: 'https://testmint.example.com',
    unit: 'sat',
    maxBalance: null,
    maxSend: null,
    maxPay: null,
    createdAt: new Date(),
    updatedAt: null,
}

const AUTH = { authorization: 'Bearer valid-key' }

async function post(app: FastifyInstance, url: string, body: object, headers = AUTH) {
    return app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    })
}

async function get(app: FastifyInstance, url: string, headers: Record<string, string> = AUTH) {
    return app.inject({ method: 'GET', url, headers })
}

beforeEach(() => {
    process.env.ENABLE_LEGACY_API_MUTATIONS = 'true'
    process.env.TRUST_PROXY = 'false'
})

// ── tests ─────────────────────────────────────────────────────────────────────

describe('Authentication', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        app = await buildApp()
        await app.ready()
    })

    it('rejects missing Authorization header', async () => {
        const res = await get(app, '/v1/wallet', {})
        expect(res.statusCode).toBe(401)
    })

    it('rejects non-Bearer Authorization', async () => {
        const res = await get(app, '/v1/wallet', { authorization: 'Basic abc' })
        expect(res.statusCode).toBe(401)
    })

    it('rejects unknown access key', async () => {
        mocks.prismaWalletFindUnique.mockResolvedValue(null)
        const res = await get(app, '/v1/wallet', { authorization: 'Bearer unknown-key' })
        expect(res.statusCode).toBe(401)
    })
})

describe('GET /v1/wallet', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        mocks.getWalletBalance.mockResolvedValue({
            balance: Amount.from(5000),
            pendingBalance: Amount.zero(),
        })
        app = await buildApp()
        await app.ready()
    })

    it('returns wallet info with balance', async () => {
        const res = await get(app, '/v1/wallet')
        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.balance).toBe(5000)
        expect(body.pending_balance).toBe(0)
        expect(body.unit).toBe('sat')
        expect(body.access_key).toBe(WALLET.accessKey)
    })
})

describe('GET /v1/wallet/transactions', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        mocks.prismaMeltOperationFindMany.mockResolvedValue([])
        mocks.prismaMintOperationFindMany.mockResolvedValue([])
        app = await buildApp()
        await app.ready()
    })

    it('returns a wallet-scoped, newest-first projection without payment secrets', async () => {
        mocks.prismaMeltOperationFindMany.mockResolvedValue([{
            intentId: 'wallet_pay_1',
            amount: 50,
            maxSpend: 52,
            state: 'PAID',
            errorCode: null,
            createdAt: new Date('2026-08-24T10:00:00.000Z'),
            updatedAt: new Date('2026-08-24T10:01:00.000Z'),
            executedAt: new Date('2026-08-24T10:00:30.000Z'),
            reconciledAt: null,
            quoteId: 'must-not-leak',
            request: 'lnbc-must-not-leak',
            selectedProofsJson: 'must-not-leak',
        }])
        mocks.prismaMintOperationFindMany.mockResolvedValue([{
            intentId: 'wallet_receive_1',
            amount: 100,
            state: 'ISSUED',
            errorCode: null,
            createdAt: new Date('2026-08-24T11:00:00.000Z'),
            updatedAt: new Date('2026-08-24T11:01:00.000Z'),
            executedAt: new Date('2026-08-24T11:00:30.000Z'),
            reconciledAt: new Date('2026-08-24T11:01:00.000Z'),
            quoteId: 'must-not-leak',
            request: 'lnbc-must-not-leak',
            quotePrivkey: 'must-not-leak',
            signature: 'must-not-leak',
        }])

        const res = await get(app, '/v1/wallet/transactions?limit=2&offset=0')

        expect(res.statusCode).toBe(200)
        expect(mocks.prismaMeltOperationFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { walletId: WALLET.id },
            take: 3,
        }))
        expect(mocks.prismaMintOperationFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { walletId: WALLET.id },
            take: 3,
        }))

        const body = res.json()
        expect(body).toEqual({
            transactions: [
                {
                    intent_id: 'wallet_receive_1',
                    type: 'LIGHTNING_RECEIVE',
                    direction: 'INCOMING',
                    amount: 100,
                    max_spend: null,
                    unit: 'sat',
                    state: 'ISSUED',
                    created_at: '2026-08-24T11:00:00.000Z',
                    updated_at: '2026-08-24T11:01:00.000Z',
                    executed_at: '2026-08-24T11:00:30.000Z',
                    reconciled_at: '2026-08-24T11:01:00.000Z',
                    error_code: null,
                },
                {
                    intent_id: 'wallet_pay_1',
                    type: 'LIGHTNING_PAYMENT',
                    direction: 'OUTGOING',
                    amount: 50,
                    max_spend: 52,
                    unit: 'sat',
                    state: 'PAID',
                    created_at: '2026-08-24T10:00:00.000Z',
                    updated_at: '2026-08-24T10:01:00.000Z',
                    executed_at: '2026-08-24T10:00:30.000Z',
                    reconciled_at: null,
                    error_code: null,
                },
            ],
            limit: 2,
            offset: 0,
            has_more: false,
        })
        expect(JSON.stringify(body)).not.toMatch(/quoteId|request|proof|privkey|signature|preimage|access_key|must-not-leak/i)
    })

    it('paginates the merged operation history with bounded queries', async () => {
        const operation = (intentId: string, hour: number) => ({
            intentId,
            amount: 1,
            maxSpend: 1,
            state: 'PREPARED',
            errorCode: null,
            createdAt: new Date(`2026-08-24T${hour.toString().padStart(2, '0')}:00:00.000Z`),
            updatedAt: new Date(`2026-08-24T${hour.toString().padStart(2, '0')}:00:00.000Z`),
            executedAt: null,
            reconciledAt: null,
        })
        mocks.prismaMeltOperationFindMany.mockResolvedValue([
            operation('wallet_pay_3', 12),
            operation('wallet_pay_1', 10),
        ])
        mocks.prismaMintOperationFindMany.mockResolvedValue([{
            ...operation('wallet_receive_2', 11),
        }])

        const res = await get(app, '/v1/wallet/transactions?limit=1&offset=1')

        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.transactions).toHaveLength(1)
        expect(body.transactions[0].intent_id).toBe('wallet_receive_2')
        expect(body.has_more).toBe(true)
        expect(mocks.prismaMeltOperationFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }))
        expect(mocks.prismaMintOperationFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }))
    })

    it('rejects unbounded pagination before querying operation history', async () => {
        const res = await get(app, '/v1/wallet/transactions?limit=101&offset=0')

        expect(res.statusCode).toBe(400)
        expect(mocks.prismaMeltOperationFindMany).not.toHaveBeenCalled()
        expect(mocks.prismaMintOperationFindMany).not.toHaveBeenCalled()
    })

    it('requires the wallet bearer credential', async () => {
        const res = await get(app, '/v1/wallet/transactions', {})

        expect(res.statusCode).toBe(401)
        expect(mocks.prismaMeltOperationFindMany).not.toHaveBeenCalled()
        expect(mocks.prismaMintOperationFindMany).not.toHaveBeenCalled()
    })
})

describe('POST /v1/wallet/deposit', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        app = await buildApp()
        await app.ready()
    })

    it('remains disabled even when the legacy opt-in variable is set', async () => {
        const res = await post(app, '/v1/wallet/deposit', { amount: 1000, unit: 'sat' })
        expect(res.statusCode).toBe(403)
        expect(mocks.createMintQuote).not.toHaveBeenCalled()
    })
})

describe('GET /v1/wallet/deposit/:quote', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        app = await buildApp()
        await app.ready()
    })

    it('rejects raw quote status without querying or minting', async () => {
        const res = await get(app, '/v1/wallet/deposit/q1')
        expect(res.statusCode).toBe(403)
        expect(mocks.checkMintQuote).not.toHaveBeenCalled()
        expect(mocks.mintProofs).not.toHaveBeenCalled()
    })
})

describe('POST /v1/wallet/send', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        app = await buildApp()
        await app.ready()
    })

    it('never exports bearer ecash through the REST compatibility route', async () => {
        const res = await post(app, '/v1/wallet/send', { amount: 500, unit: 'sat' })
        expect(res.statusCode).toBe(403)
        expect(mocks.sendProofs).not.toHaveBeenCalled()
    })
})

describe('POST /v1/wallet/receive', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        app = await buildApp()
        await app.ready()
    })

    it('never imports bearer ecash through the REST compatibility route', async () => {
        const res = await post(app, '/v1/wallet/receive', { token: 'cashuBtest' })
        expect(res.statusCode).toBe(403)
        expect(mocks.receiveToken).not.toHaveBeenCalled()
    })
})

describe('POST /v1/wallet/check', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        mocks.checkTokenState.mockResolvedValue({
            proofStates: [{ state: 'UNSPENT' }],
            token: {
                mint: WALLET.mint,
                unit: 'sat',
                proofs: [{ id: 'proof-id', amount: Amount.from(1), secret: 'secret', C: 'C' }],
            },
        })
        mocks.getProofsAmount.mockReturnValue(Amount.from(1))
        app = await buildApp()
        await app.ready()
    })

    it('binds token-state lookup to the authenticated wallet mint', async () => {
        const res = await post(app, '/v1/wallet/check', { token: 'cashuBtest' })

        expect(res.statusCode).toBe(200)
        expect(mocks.checkTokenState).toHaveBeenCalledWith('cashuBtest', WALLET.mint)
    })
})

describe('POST /v1/wallet/pay', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        app = await buildApp()
        await app.ready()
    })

    it('remains disabled even when the legacy opt-in variable is set', async () => {
        const res = await post(app, '/v1/wallet/pay', {
            bolt11_request: 'lnbc10u...', amount: 1000, unit: 'sat',
        })
        expect(res.statusCode).toBe(403)
        expect(mocks.createMeltQuote).not.toHaveBeenCalled()
        expect(mocks.meltProofs).not.toHaveBeenCalled()
    })
})

describe('GET /v1/wallet/pay/:quote', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        app = await buildApp()
        await app.ready()
    })

    it('rejects raw quote status without querying the mint', async () => {
        const res = await get(app, '/v1/wallet/pay/melt-q1')
        expect(res.statusCode).toBe(403)
        expect(mocks.checkMeltQuote).not.toHaveBeenCalled()
    })
})

describe('GET /v1/rate/:currency', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        mocks.isSupportedCurrency.mockReturnValue(true)
        mocks.getExchangeRate.mockResolvedValue({ currency: 'USD', rate: 100000, timestamp: 1700000000 })
        app = await buildApp()
        await app.ready()
    })

    it('returns exchange rate', async () => {
        const res = await get(app, '/v1/rate/USD')
        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.currency).toBe('USD')
        expect(body.rate).toBe(100000)
    })

    it('rejects unsupported currency', async () => {
        mocks.isSupportedCurrency.mockReturnValue(false)
        const res = await get(app, '/v1/rate/XYZ')
        expect(res.statusCode).toBe(400)
    })
})
