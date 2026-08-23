import 'dotenv/config'
import Fastify, { FastifyRequest, FastifyReply, FastifyInstance, FastifyError } from 'fastify'
import AppError from './utils/AppError'
import { publicRoutes } from './routes/publicRoutes'
import { protectedRoutes } from './routes/protectedRoutes'
import { Wallet as PrismaWallet } from '@prisma/client'

declare module 'fastify' {
    interface FastifyRequest {
        wallet: PrismaWallet
    }
}

function configuredTrustProxy(): false | string[] {
    const raw = process.env.TRUST_PROXY?.trim()
    if (!raw || raw === 'false') return false
    const allowlist = raw.split(',').map(item => item.trim()).filter(Boolean)
    if (allowlist.length === 0 || allowlist.some(item => item === 'true' || item === '*')) {
        throw new Error('TRUST_PROXY must be false or a comma-separated proxy IP/CIDR allowlist')
    }
    return allowlist
}

export async function buildApp(): Promise<FastifyInstance> {
    const app: FastifyInstance = Fastify({
        trustProxy: configuredTrustProxy(),
        logger: process.env.NODE_ENV !== 'test'
            ? { timestamp: () => `, "time":"${new Date().toISOString()}"` }
            : false,
    })

    app.setErrorHandler(function (err: FastifyError | AppError, req: FastifyRequest, res: FastifyReply) {
        if (err instanceof AppError) {
            const { statusCode, name, message, params } = err
            res.code(statusCode).send({ error: { statusCode, name, message, params } })
        } else {
            const { statusCode, name, message } = err
            res.code(statusCode || 500).send({ error: { statusCode, name, message } })
        }
    })

    await app.register(import('@fastify/swagger'), {
        openapi: {
            openapi: '3.0.0',
            info: {
                title: 'Minibits Ippon API',
                description: 'Minimalistic, API-driven ecash and Lightning wallet implementing the Cashu protocol. Designed for AI agents and automated systems requiring instant micropayment capability.',
                version: '1.0.0',
            },
            components: {
                securitySchemes: {
                    bearerAuth: {
                        type: 'http',
                        scheme: 'bearer',
                        description: 'Wallet access key returned at wallet creation. Pass as: Authorization: Bearer <access_key>',
                    },
                },
            },
        },
    })

    await app.register(import('@fastify/swagger-ui'), {
        routePrefix: '/v1',
        uiConfig: { docExpansion: 'list', deepLinking: true },
    })

    await app.register(import('@fastify/rate-limit'), {
        global: true,
        max: parseInt(process.env.RATE_LIMIT_MAX || '100'),
        timeWindow: process.env.RATE_LIMIT_WINDOW || '1 minute',
    })

    app.register(publicRoutes, { prefix: '/v1' })
    app.register(protectedRoutes, { prefix: '/v1' })

    return app
}
