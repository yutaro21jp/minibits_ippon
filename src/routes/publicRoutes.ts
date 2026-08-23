import 'dotenv/config'
import crypto from 'crypto'
import { FastifyPluginCallback, FastifyRequest, FastifyReply } from 'fastify'
import prisma from '../utils/prismaClient'
import { log } from '../services/logService'
import { WalletService } from '../services/walletService'
import AppError, { Err } from '../utils/AppError'
import {
    InfoResponse,
    WalletCreateRequest,
    WalletResponse,
} from './routeTypes'

const limitsSchema = {
    type: 'object',
    properties: {
        max_balance:                  { type: 'integer' },
        max_send:                     { type: 'integer' },
        max_pay:                      { type: 'integer' },
        rate_limit_max:               { type: 'integer', description: 'Max requests per time window (global)' },
        rate_limit_create_wallet_max: { type: 'integer', description: 'Max wallet creations per time window per IP' },
        rate_limit_window:            { type: 'string',  description: 'Rate-limit time window (e.g. "1 minute")' },
    },
}

function configuredLimit(envKey: string, fallback: number): number {
    const value = Number(process.env[envKey] ?? fallback)
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new AppError(500, Err.SERVER_ERROR, `${envKey} must be a positive safe integer`, {
            caller: 'CreateWallet',
        })
    }
    return value
}

function walletLimit(requested: number | undefined, global: number, field: string): number | null {
    if (requested === undefined) return null
    if (!Number.isSafeInteger(requested) || requested <= 0) {
        throw new AppError(400, Err.VALIDATION_ERROR, `${field} must be a positive safe integer`, {
            caller: 'CreateWallet',
        })
    }
    return Math.min(requested, global)
}

export const publicRoutes: FastifyPluginCallback = (instance, opts, done) => {

    // GET /v1/info
    instance.get('/info', {
        schema: {
            description: 'Returns machine-readable information about the wallet service: status, supported mints, unit, and global balance/payment limits (including rate limits).',
            tags: ['Info'],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        status: { type: 'string', example: 'operational' },
                        help:   { type: 'string' },
                        terms:  { type: 'string' },
                        unit:   { type: 'string', enum: ['sat', 'msat'] },
                        mints:  { type: 'array', items: { type: 'string' }, description: 'List of supported Cashu mint URLs' },
                        limits: limitsSchema,
                        features: {
                            type: 'object',
                            properties: {
                                signed_cli_approval: { type: 'boolean' },
                                legacy_api_mutations: { type: 'boolean' },
                                lightning_address_resolution: { type: 'boolean' },
                            },
                        },
                    },
                },
            },
        },
    }, async (req: FastifyRequest, res: FastifyReply): Promise<InfoResponse> => {
        const unit = process.env.UNIT || 'sat'

        log.info('GET /v1/info', { reqId: req.id })

        return {
            status: process.env.SERVICE_STATUS || 'operational',
            help:   process.env.SERVICE_HELP  || '',
            terms:  process.env.SERVICE_TERMS || '',
            unit,
            mints:  WalletService.getMintUrls(),
            limits: {
                max_balance:                  parseInt(process.env.MAX_BALANCE || '100000'),
                max_send:                     parseInt(process.env.MAX_SEND    || '50000'),
                max_pay:                      parseInt(process.env.MAX_PAY     || '50000'),
                rate_limit_max:               parseInt(process.env.RATE_LIMIT_MAX               || '100'),
                rate_limit_create_wallet_max: parseInt(process.env.RATE_LIMIT_CREATE_WALLET_MAX || '3'),
                rate_limit_window:            process.env.RATE_LIMIT_WINDOW || '1 minute',
            },
            features: {
                signed_cli_approval: true,
                legacy_api_mutations: false,
                lightning_address_resolution: false,
            },
        }
    })


    // POST /v1/wallet
    instance.post('/wallet', {
        schema: {
            description: 'Create a new short-lived wallet. Optionally specify a supported mint URL (defaults to the first configured mint), a name, and wallet-level limits. Initial token import is rejected; use the signed local receive flow.',
            tags: ['Wallet'],
            body: {
                type: 'object',
                properties: {
                    name:     { type: 'string', description: 'Optional label for the wallet' },
                    token:    { type: 'string', description: 'Rejected in this fork; use the signed local receive flow' },
                    mint_url: { type: 'string', description: 'Mint URL to bind this wallet to. Must be one of the supported mints. Defaults to the first configured mint.' },
                    limits: {
                        type: 'object',
                        description: 'Optional per-wallet spending caps. Values are capped to the global operator limits.',
                        properties: {
                            max_balance: { type: 'integer', description: 'Max wallet balance (in unit). Capped to global MAX_BALANCE.' },
                            max_send:    { type: 'integer', description: 'Max ecash send amount. Capped to global MAX_SEND.' },
                            max_pay:     { type: 'integer', description: 'Max Lightning payment amount. Capped to global MAX_PAY.' },
                        },
                    },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        name:            { type: 'string' },
                        access_key:      { type: 'string', description: 'Bearer token for all subsequent authenticated requests' },
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
        config: {
            rateLimit: {
                max: parseInt(process.env.RATE_LIMIT_CREATE_WALLET_MAX || '3'),
                timeWindow: process.env.RATE_LIMIT_WINDOW || '1 minute',
            },
        },
    }, async (req: WalletCreateRequest, res: FastifyReply): Promise<WalletResponse> => {
        const { name, token, mint_url, limits } = req.body || {}
        const unit = process.env.UNIT || 'sat'

        if (token) {
            throw new AppError(
                403,
                Err.UNAUTHORIZED_ERROR,
                'Initial token import is permanently disabled; create the wallet first and use the signed local receive flow',
                { caller: 'CreateWallet', reqId: req.id },
            )
        }

        const mintUrls = WalletService.getMintUrls()
        if (mintUrls.length === 0) {
            throw new AppError(500, Err.VALIDATION_ERROR, 'No supported mints configured on this server', { caller: 'CreateWallet' })
        }

        const resolvedMintUrl = mint_url || mintUrls[0]
        if (!mintUrls.includes(resolvedMintUrl)) {
            throw new AppError(400, Err.VALIDATION_ERROR, `Mint '${resolvedMintUrl}' is not in the list of supported mints`, { caller: 'CreateWallet' })
        }

        const accessKey = crypto.randomBytes(32).toString('hex')
        const maxBalance = configuredLimit('MAX_BALANCE', 100_000)
        const maxSend = configuredLimit('MAX_SEND', 50_000)
        const maxPay = configuredLimit('MAX_PAY', 50_000)

        const wallet = await prisma.wallet.create({
            data: {
                accessKey,
                name:       name || null,
                mint:       resolvedMintUrl,
                unit,
                maxBalance: walletLimit(limits?.max_balance, maxBalance, 'limits.max_balance'),
                maxSend:    walletLimit(limits?.max_send, maxSend, 'limits.max_send'),
                maxPay:     walletLimit(limits?.max_pay, maxPay, 'limits.max_pay'),
            },
        })

        log.info('POST /v1/wallet', { walletId: wallet.id, name, mint: resolvedMintUrl, hasToken: !!token, reqId: req.id })

        const walletLimits = (wallet.maxBalance != null || wallet.maxSend != null || wallet.maxPay != null)
            ? { max_balance: wallet.maxBalance, max_send: wallet.maxSend, max_pay: wallet.maxPay }
            : null

        return {
            name:            wallet.name || '',
            access_key:      wallet.accessKey,
            mint:            wallet.mint,
            unit:            wallet.unit,
            balance: 0,
            pending_balance: 0,
            limits:          walletLimits,
        }
    })

    done()
}
