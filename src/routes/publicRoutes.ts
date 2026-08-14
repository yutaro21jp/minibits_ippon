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

// receiveToken persists successful swap batches immediately. If a later batch
// fails, remove child proofs before discarding the just-created wallet row.
async function discardWallet(walletId: number) {
    await prisma.proof.deleteMany({ where: { walletId } })
    await prisma.wallet.delete({ where: { id: walletId } })
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
        }
    })


    // POST /v1/wallet
    instance.post('/wallet', {
        schema: {
            description: 'Create a new short-lived wallet. Optionally specify a supported mint URL (defaults to the first configured mint), provide a name, wallet-level limits, and an initial Cashu token to fund it immediately.',
            tags: ['Wallet'],
            body: {
                type: 'object',
                properties: {
                    name:     { type: 'string', description: 'Optional label for the wallet' },
                    token:    { type: 'string', description: 'Optional Cashu token (cashuB...) to deposit on creation' },
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

        const mintUrls = WalletService.getMintUrls()
        if (mintUrls.length === 0) {
            throw new AppError(500, Err.VALIDATION_ERROR, 'No supported mints configured on this server', { caller: 'CreateWallet' })
        }

        const resolvedMintUrl = mint_url || mintUrls[0]
        if (!mintUrls.includes(resolvedMintUrl)) {
            throw new AppError(400, Err.VALIDATION_ERROR, `Mint '${resolvedMintUrl}' is not in the list of supported mints`, { caller: 'CreateWallet' })
        }

        const accessKey = crypto.randomBytes(32).toString('hex')

        const wallet = await prisma.wallet.create({
            data: {
                accessKey,
                name:       name || null,
                mint:       resolvedMintUrl,
                unit,
                maxBalance: limits?.max_balance ?? null,
                maxSend:    limits?.max_send    ?? null,
                maxPay:     limits?.max_pay     ?? null,
            },
        })

        let balance = 0
        let pendingBalance = 0

        // If a token was provided, receive it immediately
        if (token) {
            try {
                const maxBalance = wallet.maxBalance ?? parseInt(process.env.MAX_BALANCE || '100000')
                const tokenAmount = WalletService.getTokenAmount(token)
                if (tokenAmount.greaterThan(maxBalance)) {
                    throw new AppError(400, Err.LIMIT_ERROR, `Token amount ${tokenAmount.toString()} exceeds max balance ${maxBalance}`, { caller: 'CreateWallet' })
                }

                const newProofs = await WalletService.receiveToken(wallet.id, token, resolvedMintUrl)
                balance = WalletService.getProofsAmount(newProofs).toNumber()
            } catch (e: any) {
                await discardWallet(wallet.id)
                if (e instanceof AppError) throw e
                throw new AppError(400, Err.VALIDATION_ERROR, `Failed to receive initial token: ${e.message}`, { caller: 'CreateWallet' })
            }
        }

        log.info('POST /v1/wallet', { walletId: wallet.id, name, mint: resolvedMintUrl, hasToken: !!token, reqId: req.id })

        const walletLimits = (wallet.maxBalance != null || wallet.maxSend != null || wallet.maxPay != null)
            ? { max_balance: wallet.maxBalance, max_send: wallet.maxSend, max_pay: wallet.maxPay }
            : null

        return {
            name:            wallet.name || '',
            access_key:      wallet.accessKey,
            mint:            wallet.mint,
            unit:            wallet.unit,
            balance,
            pending_balance: pendingBalance,
            limits:          walletLimits,
        }
    })

    done()
}
