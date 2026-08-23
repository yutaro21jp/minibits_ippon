import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Amount } from '@cashu/cashu-ts'

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
