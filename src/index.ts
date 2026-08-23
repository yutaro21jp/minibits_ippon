import 'dotenv/config'
import os from 'os'
import path from 'path'
import { buildApp } from './app'
import { startCli } from './cli'

const interactionMode = (process.env.INTERACTION_MODE || 'api').toLowerCase()
const dbEngine        = (process.env.DATABASE_ENGINE  || 'postgresql').toLowerCase()

// ── Validate required env vars ────────────────────────────────────────────────

if (!process.env.MINT_URLS) {
    console.error('FATAL: Missing MINT_URLS environment variable')
    process.exit(1)
}

const mintUrls = process.env.MINT_URLS.split(',').map((u: string) => u.trim()).filter((u: string) => u.length > 0)
if (mintUrls.length === 0) {
    console.error('FATAL: MINT_URLS contains no valid URLs')
    process.exit(1)
}

if (dbEngine === 'postgresql' && !process.env.DATABASE_URL) {
    console.error('FATAL: Missing DATABASE_URL (required for DATABASE_ENGINE=postgresql)')
    process.exit(1)
}

// ── Startup configuration log ─────────────────────────────────────────────────

function resolvedSqlitePath(): string {
    const raw = process.env.DATABASE_FILE_PATH || '~/.ippon/database.sqlite'
    return path.resolve(raw.replace(/^~/, os.homedir()))
}

function maskedDbUrl(): string {
    const url = process.env.DATABASE_URL || ''
    try {
        const parsed = new URL(url)
        parsed.username = ''
        parsed.password = ''
        parsed.search = ''
        parsed.hash = ''
        return parsed.toString()
    } catch {
        return '[redacted invalid database URL]'
    }
}

const dbInfo = dbEngine === 'sqlite'
    ? resolvedSqlitePath()
    : maskedDbUrl()

process.stderr.write([
    '',
    '=== Minibits Ippon ==============================',
    `  interaction_mode : ${interactionMode}`,
    `  database_engine  : ${dbEngine}`,
    `  database         : ${dbInfo}`,
    `  mints            : ${mintUrls.join(', ')}`,
    `  unit             : ${process.env.UNIT || 'sat'}`,
    `  limits           : max_balance=${process.env.MAX_BALANCE || '100000'}  max_send=${process.env.MAX_SEND || '50000'}  max_pay=${process.env.MAX_PAY || '50000'}`,
    `  log_level        : ${process.env.LOG_LEVEL || 'error'}`,
    interactionMode === 'api'
        ? `  port             : ${process.env.PORT || '3000'}`
        : '',
    '=================================================',
    '',
].filter(l => l !== undefined).join('\n') + '\n')

// ── Start ─────────────────────────────────────────────────────────────────────

if (interactionMode === 'cli') {
    await startCli()
} else {
    const app = await buildApp()

    app.listen({
        host: '0.0.0.0',
        port: parseInt(process.env.PORT || '3000'),
        listenTextResolver: (address) => `Minibits Ippon API ready at: ${address}`,
    }, (err: any) => {
        if (err) {
            console.error(err)
            process.exit(1)
        }
    })
}
