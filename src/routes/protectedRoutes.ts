import 'dotenv/config'
import { Wallet as PrismaWallet } from '@prisma/client'
import { FastifyRequest, FastifyPluginCallback, FastifyReply } from 'fastify'
import {
    getTokenMetadata,
    CheckStateEnum,
    decodePaymentRequest,
} from '@cashu/cashu-ts'
import { decode as bolt11Decode } from '@gandlaf21/bolt11-decode'
import { bearerAuthHandler } from '../handlers/bearerAuth'
import { log } from '../services/logService'
import { WalletService } from '../services/walletService'
import { getExchangeRate, isSupportedCurrency } from '../services/exchangeRateService'
import AppError, { Err } from '../utils/AppError'
import {
    WalletResponse,
    WalletDepositRequest,
    DepositCheckRequest,
    WalletDepositResponse,
    WalletSendRequest,
    WalletSendResponse,
    WalletCheckRequest,
    WalletCheckResponse,
    WalletDecodeRequest,
    WalletDecodeResponse,
    WalletPayRequest,
    PayCheckRequest,
    WalletPayResponse,
    WalletReceiveRequest,
    WalletReceiveResponse,
    RateRequest,
    RateResponse,
} from './routeTypes'


// ── Shared schema constants ────────────────────────────────────────────────────

const BEARER = [{ bearerAuth: [] }]

const meltQuoteProps = {
    quote:            { type: 'string' },
    amount:           { type: 'integer' },
    fee_reserve:      { type: 'integer' },
    state:            { type: 'string', enum: ['UNPAID', 'PENDING', 'PAID'] },
    payment_preimage: { type: 'string', nullable: true },
    expiry:           { type: 'integer' },
}

const depositQuoteProps = {
    quote:   { type: 'string' },
    request: { type: 'string', description: 'BOLT11 Lightning invoice' },
    state:   { type: 'string', enum: ['UNPAID', 'PAID', 'ISSUED', 'EXPIRED'] },
    expiry:  { type: 'integer', nullable: true },
}

// ── Helper to get the wallet from the request (attached by bearerAuthHandler)
function getAuthWallet(req: FastifyRequest): PrismaWallet {
    return (req as any).wallet as PrismaWallet
}


function rejectUnsafeMutation(caller: string, reqId: string): never {
    throw new AppError(
        403,
        Err.UNAUTHORIZED_ERROR,
        'One-step REST wallet mutations are permanently disabled; use the signed local prepare/execute/status flow',
        { caller, reqId },
    )
}


export const protectedRoutes: FastifyPluginCallback = (instance, opts, done) => {

    instance.addHook('onRequest', async (request, reply) => {
        await bearerAuthHandler(request, reply)
    })


    // GET /v1/wallet
    instance.get('/wallet', {
        schema: {
            description: 'Get the current wallet details including name, unit, mint, confirmed balance, and pending balance. Any pending proofs are checked against the mint first and their state updated before the balances are calculated.',
            tags: ['Wallet'],
            security: BEARER,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        name:            { type: 'string' },
                        access_key:      { type: 'string' },
                        mint:            { type: 'string' },
                        unit:            { type: 'string' },
                        balance:         { type: 'integer' },
                        pending_balance: { type: 'integer' },
                        limits: {
                            type: 'object',
                            nullable: true,
                            properties: {
                                max_balance: { type: 'integer', nullable: true },
                                max_send:    { type: 'integer', nullable: true },
                                max_pay:     { type: 'integer', nullable: true },
                            },
                        },
                    },
                },
            },
        },
    }, async (req: FastifyRequest, res: FastifyReply): Promise<WalletResponse> => {
        const wallet = getAuthWallet(req)

        try {
            await WalletService.syncProofsStateWithMint(wallet.id, wallet.mint)
        } catch (e: any) {
            log.warn('GET /v1/wallet - pending proof sync failed', { walletId: wallet.id, error: e.message, reqId: req.id })
        }

        const { balance, pendingBalance } = await WalletService.getWalletBalance(wallet.id)

        log.info('GET /v1/wallet', { walletId: wallet.id, reqId: req.id })

        return {
            name:            wallet.name || '',
            access_key:      wallet.accessKey,
            mint:            wallet.mint,
            unit:            wallet.unit,
            balance: balance.toNumber(),
            pending_balance: pendingBalance.toNumber(),
            limits: (wallet.maxBalance != null || wallet.maxSend != null || wallet.maxPay != null) ? {
                max_balance: wallet.maxBalance,
                max_send:    wallet.maxSend,
                max_pay:     wallet.maxPay,
            } : null,
        }
    })


    // POST /v1/wallet/deposit
    instance.post('/wallet/deposit', {
        schema: {
            description: 'Disabled in this fork. Use the signed local receive prepare/execute/status flow.',
            tags: ['Deposit'],
            security: BEARER,
            body: {
                type: 'object',
                required: ['amount', 'unit'],
                properties: {
                    amount: { type: 'integer', description: 'Amount to deposit (in wallet unit)' },
                    unit:   { type: 'string', enum: ['sat', 'msat'] },
                },
            },
            response: {
                200: { type: 'object', properties: depositQuoteProps },
            },
        },
    }, async (req: WalletDepositRequest, res: FastifyReply): Promise<WalletDepositResponse> => {
        return rejectUnsafeMutation('Deposit', req.id)
    })


    // GET /v1/wallet/deposit/:quote
    instance.get('/wallet/deposit/:quote', {
        schema: {
            description: 'Disabled because raw mint quote IDs are not wallet-bound. Use signed local receive-status.',
            tags: ['Deposit'],
            security: BEARER,
            params: {
                type: 'object',
                properties: { quote: { type: 'string', description: 'Quote ID returned by POST /wallet/deposit' } },
            },
            response: {
                200: { type: 'object', properties: depositQuoteProps },
            },
        },
    }, async (req: DepositCheckRequest, res: FastifyReply): Promise<WalletDepositResponse> => {
        return rejectUnsafeMutation('DepositCheck', req.id)
    })


    // POST /v1/wallet/send
    instance.post('/wallet/send', {
        schema: {
            description: 'Disabled until ecash export has a durable signed approval and recovery model.',
            tags: ['Send'],
            security: BEARER,
            body: {
                type: 'object',
                required: ['amount', 'unit'],
                properties: {
                    amount:         { type: 'integer' },
                    unit:           { type: 'string', enum: ['sat', 'msat'] },
                    memo:           { type: 'string', description: 'Optional memo embedded in the token' },
                    lock_to_pubkey: { type: 'string', description: 'Lock token to a pubkey (NUT-11 P2PK). Accepts npub, 64-char x-only hex, or 66-char compressed hex.' },
                    cashu_request:  { type: 'string', description: 'Pay a Cashu payment request (not yet implemented)' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        token:  { type: 'string', description: 'Encoded Cashu token (cashuB...)' },
                        amount: { type: 'integer' },
                        unit:   { type: 'string' },
                        memo:   { type: 'string', nullable: true },
                    },
                },
            },
        },
    }, async (req: WalletSendRequest, res: FastifyReply): Promise<WalletSendResponse> => {
        return rejectUnsafeMutation('Send', req.id)
    })


    // POST /v1/wallet/check
    instance.post('/wallet/check', {
        schema: {
            description: 'Check the current state of an exported Cashu token (e.g., whether it has been spent or swapped by the recipient).',
            tags: ['Send'],
            security: BEARER,
            body: {
                type: 'object',
                required: ['token'],
                properties: {
                    token: { type: 'string', description: 'Cashu token to check' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        amount: { type: 'integer' },
                        unit:   { type: 'string' },
                        memo:   { type: 'string', nullable: true },
                        state:  { type: 'string', enum: ['UNSPENT', 'SPENT', 'PENDING', 'MIXED', 'UNKNOWN'] },
                        mint_proof_states: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    Y:       { type: 'string', description: 'Hash-to-curve of the proof secret' },
                                    state:   { type: 'string', enum: ['UNSPENT', 'PENDING', 'SPENT'] },
                                    witness: { type: 'string', nullable: true },
                                },
                                additionalProperties: true,
                            },
                        },
                    },
                },
            },
        },
    }, async (req: WalletCheckRequest, res: FastifyReply): Promise<WalletCheckResponse> => {
        const wallet = getAuthWallet(req)
        const { token: tokenStr } = req.body

        if (!tokenStr) {
            throw new AppError(400, Err.VALIDATION_ERROR, 'Token is required', { caller: 'Check', reqId: req.id })
        }

        const { proofStates, token } = await WalletService.checkTokenState(tokenStr, wallet.mint)

        // Determine overall state
        const states = proofStates.map(s => s.state)
        let overallState: string = 'UNKNOWN'

        if (states.every(s => s === CheckStateEnum.UNSPENT)) {
            overallState = 'UNSPENT'
        } else if (states.every(s => s === CheckStateEnum.SPENT)) {
            overallState = 'SPENT'
        } else if (states.every(s => s === CheckStateEnum.PENDING)) {
            overallState = 'PENDING'
        } else {
            overallState = 'MIXED'
        }

        // Update local proof status based on mint state
        const spentSecrets = token.proofs
            .filter((_, i) => proofStates[i]?.state === CheckStateEnum.SPENT)
            .map(p => p.secret)

        if (spentSecrets.length > 0) {
            await WalletService.updateProofsStatus(wallet.id, spentSecrets, 'SPENT')
        }

        const pendingSecrets = token.proofs
            .filter((_, i) => proofStates[i]?.state === CheckStateEnum.PENDING)
            .map(p => p.secret)

        if (pendingSecrets.length > 0) {
            await WalletService.updateProofsStatus(wallet.id, pendingSecrets, 'PENDING')
        }

        log.info('POST /v1/wallet/check', { walletId: wallet.id, state: overallState, reqId: req.id })

        return {
            amount: WalletService.getProofsAmount(token.proofs).toNumber(),
            unit: token.unit || wallet.unit,
            memo: token.memo,
            state: overallState,
            mint_proof_states: proofStates,
        }
    })


    // POST /v1/wallet/decode
    instance.post('/wallet/decode', {
        schema: {
            description: 'Decode a Cashu token, Cashu payment request, or BOLT11 invoice and return structured information.',
            tags: ['Utils'],
            security: BEARER,
            body: {
                type: 'object',
                required: ['type', 'data'],
                properties: {
                    type: { type: 'string', enum: ['CASHU_TOKEN_V4', 'CASHU_TOKEN_V3', 'BOLT11_REQUEST', 'CASHU_REQUEST'] },
                    data: { type: 'string' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        type:    { type: 'string' },
                        decoded: { type: 'object', additionalProperties: true },
                    },
                },
            },
        },
    }, async (req: WalletDecodeRequest, res: FastifyReply): Promise<WalletDecodeResponse> => {
        const wallet = getAuthWallet(req)
        const { type, data } = req.body

        if (!type || !data) {
            throw new AppError(400, Err.VALIDATION_ERROR, 'Both type and data are required', { caller: 'Decode', reqId: req.id })
        }

        let decoded: any

        switch (type) {
            case 'CASHU_TOKEN_V4':
            case 'CASHU_TOKEN_V3': {
                const metadata = getTokenMetadata(data)
                decoded = {
                    mint: metadata.mint,
                    unit: metadata.unit,
                    amount: metadata.amount.toNumber(),
                    incomplete_proofs: metadata.incompleteProofs,
                }
                break
            }

            case 'BOLT11_REQUEST': {
                const invoice = bolt11Decode(data)
                decoded = invoice
                break
            }

            case 'CASHU_REQUEST': {
                const paymentRequest = decodePaymentRequest(data)
                decoded = {
                    id: paymentRequest.id,
                    amount: paymentRequest.amount?.toNumber(),
                    unit: paymentRequest.unit,
                    mints: paymentRequest.mints,
                    description: paymentRequest.description,
                    single_use: paymentRequest.singleUse,
                }
                break
            }

            default:
                throw new AppError(400, Err.VALIDATION_ERROR, `Unsupported type: ${type}`, { caller: 'Decode', reqId: req.id })
        }

        log.info('POST /v1/wallet/decode', { walletId: wallet.id, type, reqId: req.id })

        return { type, decoded }
    })


    // POST /v1/wallet/pay
    instance.post('/wallet/pay', {
        schema: {
            description: 'Disabled in this fork. Use signed local pay-prepare/pay-execute/pay-status.',
            tags: ['Pay'],
            security: BEARER,
            body: {
                type: 'object',
                required: ['amount', 'unit'],
                properties: {
                    bolt11_request:    { type: 'string', description: 'BOLT11 invoice to pay' },
                    lightning_address: { type: 'string', description: 'Rejected in this fork; resolve to BOLT11 in a trusted client' },
                    amount:            { type: 'integer' },
                    unit:              { type: 'string', enum: ['sat', 'msat'] },
                },
            },
            response: {
                200: { type: 'object', properties: meltQuoteProps },
            },
        },
    }, async (req: WalletPayRequest, res: FastifyReply): Promise<WalletPayResponse> => {
        return rejectUnsafeMutation('Pay', req.id)
    })


    // GET /v1/wallet/pay/:quote
    instance.get('/wallet/pay/:quote', {
        schema: {
            description: 'Disabled because raw melt quote IDs are not wallet-bound. Use signed local pay-status.',
            tags: ['Pay'],
            security: BEARER,
            params: {
                type: 'object',
                properties: { quote: { type: 'string', description: 'Quote ID returned by POST /wallet/pay' } },
            },
            response: {
                200: { type: 'object', properties: meltQuoteProps },
            },
        },
    }, async (req: PayCheckRequest, res: FastifyReply): Promise<WalletPayResponse> => {
        return rejectUnsafeMutation('PayCheck', req.id)
    })


    // POST /v1/wallet/receive
    instance.post('/wallet/receive', {
        schema: {
            description: 'Disabled until token import has a durable signed approval and ambiguity-safe recovery model.',
            tags: ['Receive'],
            security: BEARER,
            body: {
                type: 'object',
                required: ['token'],
                properties: {
                    token: { type: 'string', description: 'Cashu token to receive (cashuB...)' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        amount:          { type: 'integer' },
                        unit:            { type: 'string' },
                        balance:         { type: 'integer' },
                        pending_balance: { type: 'integer' },
                    },
                },
            },
        },
    }, async (req: WalletReceiveRequest, res: FastifyReply): Promise<WalletReceiveResponse> => {
        return rejectUnsafeMutation('Receive', req.id)
    })


    // GET /v1/rate/:currency
    instance.get('/rate/:currency', {
        schema: {
            description: "Get the current fiat exchange rate for the wallet's unit (e.g., satoshis per USD).",
            tags: ['Utils'],
            security: BEARER,
            params: {
                type: 'object',
                properties: {
                    currency: { type: 'string', description: 'ISO 4217 currency code (e.g. USD, EUR)' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        currency:  { type: 'string' },
                        rate:      { type: 'number', description: 'Satoshis per 1 unit of currency' },
                        timestamp: { type: 'integer', description: 'Unix timestamp of the rate' },
                    },
                },
            },
        },
    }, async (req: RateRequest, res: FastifyReply): Promise<RateResponse> => {
        const { currency } = req.params

        if (!isSupportedCurrency(currency)) {
            throw new AppError(400, Err.VALIDATION_ERROR, `Unsupported currency: ${currency}`, { caller: 'Rate', reqId: req.id })
        }

        try {
            const rateResponse = await getExchangeRate(currency, req.id)
            log.info('GET /v1/rate/' + currency, { rateResponse, reqId: req.id })
            return rateResponse
        } catch (e: any) {
            throw new AppError(404, Err.NOTFOUND_ERROR, e.message, { caller: 'Rate', reqId: req.id })
        }
    })

    done()
}
