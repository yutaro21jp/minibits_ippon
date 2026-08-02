import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Amount, MintQuoteState, MeltQuoteState } from '@cashu/cashu-ts'

// ── hoisted mock fns ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
    prismaWalletFindUnique: vi.fn(),
    prismaWalletCreate: vi.fn(),
    prismaWalletDelete: vi.fn(),
    getWalletBalance: vi.fn(),
    createMintQuote: vi.fn(),
    checkMintQuote: vi.fn(),
    mintProofs: vi.fn(),
    saveProofs: vi.fn(),
    sendProofs: vi.fn(),
    receiveToken: vi.fn(),
    getProofsAmount: vi.fn(),
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

describe('POST /v1/wallet/deposit', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        mocks.getWalletBalance.mockResolvedValue({
            balance: Amount.zero(),
            pendingBalance: Amount.zero(),
        })
        mocks.createMintQuote.mockResolvedValue({
            quote: 'quote-id-123',
            request: 'lnbc...',
            state: MintQuoteState.UNPAID,
            expiry: 3600,
        })
        app = await buildApp()
        await app.ready()
    })

    it('creates a mint quote', async () => {
        const res = await post(app, '/v1/wallet/deposit', { amount: 1000, unit: 'sat' })
        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.quote).toBe('quote-id-123')
        expect(mocks.createMintQuote).toHaveBeenCalledWith(1000, WALLET.mint)
    })

    it('rejects wrong unit', async () => {
        const res = await post(app, '/v1/wallet/deposit', { amount: 1000, unit: 'msat' })
        expect(res.statusCode).toBe(400)
        expect(res.json().error.name).toBe('VALIDATION_ERROR')
    })

    it('rejects missing unit', async () => {
        const res = await post(app, '/v1/wallet/deposit', { amount: 1000 })
        expect(res.statusCode).toBe(400)
    })

    it('rejects zero amount', async () => {
        const res = await post(app, '/v1/wallet/deposit', { amount: 0, unit: 'sat' })
        expect(res.statusCode).toBe(400)
    })

    it('rejects deposit that would exceed max balance', async () => {
        mocks.getWalletBalance.mockResolvedValue({
            balance: Amount.from(99000),
            pendingBalance: Amount.zero(),
        })
        const res = await post(app, '/v1/wallet/deposit', { amount: 5000, unit: 'sat' })
        expect(res.statusCode).toBe(400)
        expect(res.json().error.name).toBe('LIMIT_ERROR')
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

    it('returns quote status when unpaid', async () => {
        mocks.checkMintQuote.mockResolvedValue({
            quote: 'q1', request: 'lnbc...', state: MintQuoteState.UNPAID, expiry: 3600,
        })
        const res = await get(app, '/v1/wallet/deposit/q1')
        expect(res.statusCode).toBe(200)
        expect(res.json().state).toBe(MintQuoteState.UNPAID)
        expect(mocks.mintProofs).not.toHaveBeenCalled()
    })

    it('mints proofs automatically when quote is paid', async () => {
        mocks.checkMintQuote.mockResolvedValue({
            quote: 'q1', request: 'lnbc...', state: MintQuoteState.PAID,
            amount: Amount.from(1000), expiry: 3600,
        })
        mocks.mintProofs.mockResolvedValue([{ id: 'p1', amount: 1000, secret: 's1', C: 'C1' }])
        const res = await get(app, '/v1/wallet/deposit/q1')
        expect(res.statusCode).toBe(200)
        expect(mocks.mintProofs.mock.calls[0][0].toNumber()).toBe(1000)
        expect(mocks.mintProofs.mock.calls[0].slice(1)).toEqual(['q1', WALLET.mint])
        expect(mocks.saveProofs).toHaveBeenCalled()
    })
})

describe('POST /v1/wallet/send', () => {
    let app: FastifyInstance
    const SEND_PROOFS = [{ id: 'p1', amount: Amount.from(500), secret: 's1', C: 'C1' }]

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        mocks.sendProofs.mockResolvedValue({ keep: [], send: SEND_PROOFS })
        mocks.getProofsAmount.mockReturnValue(Amount.from(500))
        app = await buildApp()
        await app.ready()
    })

    it('returns an encoded token', async () => {
        const res = await post(app, '/v1/wallet/send', { amount: 500, unit: 'sat' })
        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.token).toBeTruthy()
        expect(body.amount).toBe(500)
        expect(body.unit).toBe('sat')
    })

    it('passes lock_to_pubkey as p2pk pubkey to sendProofs', async () => {
        const pubkey66 = '02' + '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
        const res = await post(app, '/v1/wallet/send', {
            amount: 500, unit: 'sat', lock_to_pubkey: pubkey66,
        })
        expect(res.statusCode).toBe(200)
        expect(mocks.sendProofs).toHaveBeenCalledWith(WALLET.id, 500, WALLET.mint, pubkey66)
    })

    it('rejects invalid lock_to_pubkey', async () => {
        const res = await post(app, '/v1/wallet/send', {
            amount: 500, unit: 'sat', lock_to_pubkey: 'notakey',
        })
        expect(res.statusCode).toBe(400)
    })

    it('rejects amount exceeding max send', async () => {
        const res = await post(app, '/v1/wallet/send', { amount: 99999, unit: 'sat' })
        expect(res.statusCode).toBe(400)
        expect(res.json().error.name).toBe('LIMIT_ERROR')
    })

    it('rejects cashu_request (not implemented)', async () => {
        const res = await post(app, '/v1/wallet/send', {
            amount: 500, unit: 'sat', cashu_request: 'creqAbc',
        })
        expect(res.statusCode).toBe(400)
    })

    it('rejects wrong unit', async () => {
        const res = await post(app, '/v1/wallet/send', { amount: 500, unit: 'msat' })
        expect(res.statusCode).toBe(400)
    })
})

describe('POST /v1/wallet/receive', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        mocks.getWalletBalance.mockResolvedValue({
            balance: Amount.zero(),
            pendingBalance: Amount.zero(),
        })
        app = await buildApp()
        await app.ready()
    })

    it('rejects missing token field', async () => {
        const res = await post(app, '/v1/wallet/receive', {})
        expect(res.statusCode).toBe(400)
    })
})

describe('POST /v1/wallet/pay', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        mocks.createMeltQuote.mockResolvedValue({
            quote: 'melt-q1', amount: Amount.from(1000), fee_reserve: Amount.from(10),
            state: MeltQuoteState.UNPAID, expiry: 3600,
        })
        mocks.meltProofs.mockResolvedValue({
            quote: {
                quote: 'melt-q1', amount: Amount.from(1000), fee_reserve: Amount.from(10),
                state: MeltQuoteState.PAID, payment_preimage: 'preimage', expiry: 3600,
            },
            change: [],
        })
        app = await buildApp()
        await app.ready()
    })

    it('pays a bolt11 invoice', async () => {
        const res = await post(app, '/v1/wallet/pay', {
            bolt11_request: 'lnbc10u...', amount: 1000, unit: 'sat',
        })
        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.state).toBe(MeltQuoteState.PAID)
        expect(body.payment_preimage).toBe('preimage')
    })

    it('rejects when neither bolt11 nor lightning address provided', async () => {
        const res = await post(app, '/v1/wallet/pay', { amount: 1000, unit: 'sat' })
        expect(res.statusCode).toBe(400)
    })

    it('rejects wrong unit', async () => {
        const res = await post(app, '/v1/wallet/pay', {
            bolt11_request: 'lnbc10u...', amount: 1000, unit: 'msat',
        })
        expect(res.statusCode).toBe(400)
    })

    it('rejects amount exceeding max pay', async () => {
        const res = await post(app, '/v1/wallet/pay', {
            bolt11_request: 'lnbc...', amount: 99999, unit: 'sat',
        })
        expect(res.statusCode).toBe(400)
        expect(res.json().error.name).toBe('LIMIT_ERROR')
    })

    it('resolves lightning address to bolt11 and pays', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                json: () => Promise.resolve({
                    callback: 'https://example.com/callback',
                    minSendable: 1000, maxSendable: 1000000,
                }),
            })
            .mockResolvedValueOnce({
                json: () => Promise.resolve({ pr: 'lnbc10u_from_lnurl' }),
            })
        vi.stubGlobal('fetch', mockFetch)

        const res = await post(app, '/v1/wallet/pay', {
            lightning_address: 'user@example.com', amount: 1000, unit: 'sat',
        })
        expect(res.statusCode).toBe(200)
        expect(mocks.createMeltQuote).toHaveBeenCalledWith('lnbc10u_from_lnurl', WALLET.mint)
    })
})

describe('GET /v1/wallet/pay/:quote', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.prismaWalletFindUnique.mockResolvedValue(WALLET)
        mocks.checkMeltQuote.mockResolvedValue({
            quote: 'melt-q1', amount: Amount.from(1000), fee_reserve: Amount.from(10),
            state: MeltQuoteState.PAID, payment_preimage: 'pi', expiry: 3600,
        })
        app = await buildApp()
        await app.ready()
    })

    it('returns melt quote status', async () => {
        const res = await get(app, '/v1/wallet/pay/melt-q1')
        expect(res.statusCode).toBe(200)
        expect(res.json().state).toBe(MeltQuoteState.PAID)
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
