import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots = []
const tool = path.resolve('scripts/approval-tool.mjs')

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})

describe('approval-tool', () => {
    it('generates private key material and signs a canonical unexpired payload', () => {
        const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ippon-approval-'))
        roots.push(root)
        const privatePath = path.join(root, 'approval-private.pem')
        const publicPath = path.join(root, 'approval-public.txt')
        execFileSync(process.execPath, [tool, 'generate', privatePath, publicPath])

        expect(lstatSync(privatePath).mode & 0o777).toBe(0o600)
        expect(lstatSync(publicPath).mode & 0o777).toBe(0o600)

        const payload = JSON.stringify({
            version: 1,
            operation: 'pay',
            wallet_sha256: '00'.repeat(32),
            intent_id: 'wallet_0123456789abcdef01234567',
            amount: 10,
            max_spend: 11,
            expires_at: Math.floor(Date.now() / 1_000) + 3_600,
            invoice_sha256: '11'.repeat(32),
            quote_sha256: '22'.repeat(32),
            plan_sha256: '33'.repeat(32),
        })
        const signature = execFileSync(
            process.execPath,
            [tool, 'sign', privatePath],
            { input: payload, encoding: 'utf8' },
        ).trim()
        const publicKey = crypto.createPublicKey({
            key: Buffer.from(readFileSync(publicPath, 'utf8').trim(), 'base64url'),
            type: 'spki',
            format: 'der',
        })

        expect(crypto.verify(
            null,
            Buffer.from(payload),
            publicKey,
            Buffer.from(signature, 'base64url'),
        )).toBe(true)
    })
})
