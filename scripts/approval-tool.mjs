#!/usr/bin/env node
import crypto from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

process.umask(0o077)

function usage(message) {
    if (message) process.stderr.write(`${message}\n`)
    process.stderr.write([
        'Usage:',
        '  node scripts/approval-tool.mjs generate <private.pem> <public-key.txt>',
        '  node scripts/approval-tool.mjs sign <private.pem>   # approval_payload on stdin',
        '',
        'Keep the private key outside the wallet/agent runtime. The public-key file',
        'contains the base64url SPKI value for IPPON_APPROVAL_PUBLIC_KEY.',
        '',
    ].join('\n'))
    process.exit(2)
}

function generate(privatePath, publicPath) {
    if (!privatePath || !publicPath) usage('Both output paths are required')
    const privateTarget = path.resolve(privatePath)
    const publicTarget = path.resolve(publicPath)
    if (privateTarget === publicTarget) usage('Private and public output paths must differ')

    const keys = crypto.generateKeyPairSync('ed25519')
    const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
    const publicSpki = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
    writeFileSync(privateTarget, privatePem, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    try {
        writeFileSync(publicTarget, `${publicSpki}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    } catch (error) {
        process.stderr.write(`Public-key write failed; remove the newly created private file if it is not needed: ${privateTarget}\n`)
        throw error
    }
    process.stderr.write(`Created private approval key: ${privateTarget}\n`)
    process.stderr.write(`Created wallet public-key value: ${publicTarget}\n`)
}

function readStdin(limit = 32_768) {
    const input = readFileSync(0)
    if (input.length > limit) throw new Error('Approval payload is too large')
    return input.toString('utf8').trim()
}

function sign(privatePath) {
    if (!privatePath) usage('A private-key path is required')
    const payload = readStdin()
    let parsed
    try {
        parsed = JSON.parse(payload)
    } catch {
        throw new Error('stdin must contain the exact approval_payload JSON returned by prepare')
    }
    const required = [
        'version', 'operation', 'wallet_sha256', 'intent_id', 'amount', 'max_spend',
        'expires_at', 'invoice_sha256', 'quote_sha256', 'plan_sha256',
    ]
    if (
        parsed.version !== 1
        || !['pay', 'receive'].includes(parsed.operation)
        || required.some(field => !Object.prototype.hasOwnProperty.call(parsed, field))
        || JSON.stringify(parsed) !== payload
    ) {
        throw new Error('Approval payload is not in the canonical version-1 form')
    }
    if (parsed.expires_at <= Math.floor(Date.now() / 1_000)) {
        throw new Error('Refusing to sign an expired approval payload')
    }

    const key = crypto.createPrivateKey(readFileSync(path.resolve(privatePath), 'utf8'))
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Private key must be Ed25519')
    const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key).toString('base64url')
    process.stdout.write(`${signature}\n`)
}

try {
    const [command, first, second] = process.argv.slice(2)
    if (command === 'generate') generate(first, second)
    else if (command === 'sign') sign(first)
    else usage()
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
}
