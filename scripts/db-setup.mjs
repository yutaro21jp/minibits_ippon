#!/usr/bin/env node
/**
 * Database setup script — reads DATABASE_ENGINE from .env, copies the matching
 * prisma/schema.{engine}.prisma to prisma/schema.prisma, then runs
 * `prisma generate` and `prisma db push`.
 *
 * Usage:
 *   node scripts/db-setup.mjs              # reads DATABASE_ENGINE from .env
 *   DATABASE_ENGINE=sqlite node scripts/db-setup.mjs
 */

import { config } from 'dotenv'
import { copyFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { ensurePrivateSqlitePath } from './private-sqlite-path.mjs'

config()   // load .env
process.umask(0o077)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const engine = (process.env.DATABASE_ENGINE || 'postgresql').toLowerCase()
console.log(`[db-setup] DATABASE_ENGINE = ${engine}`)

// ── Validate engine ──────────────────────────────────────────────────────────

const supported = ['postgresql', 'sqlite']
if (!supported.includes(engine)) {
    console.error(`[db-setup] Unsupported engine "${engine}". Supported: ${supported.join(', ')}`)
    process.exit(1)
}

// ── Copy schema ───────────────────────────────────────────────────────────────

const src = path.join(root, 'prisma', `schema.${engine}.prisma`)
const dst = path.join(root, 'prisma', 'schema.prisma')

if (!existsSync(src)) {
    console.error(`[db-setup] Schema file not found: ${src}`)
    process.exit(1)
}

copyFileSync(src, dst)
console.log(`[db-setup] Copied ${path.relative(root, src)} → prisma/schema.prisma`)

// ── Resolve DATABASE_URL ──────────────────────────────────────────────────────

if (engine === 'sqlite') {
    const raw = process.env.DATABASE_FILE_PATH || '~/.ippon/database.sqlite'
    const expanded = raw.replace(/^~/, os.homedir())
    const absolute = ensurePrivateSqlitePath(expanded, {
        onCreate: (kind, target) => {
            console.log(`[db-setup] Created private ${kind}: ${target}`)
        },
    })

    process.env.DATABASE_URL = `file:${absolute}`
    console.log(`[db-setup] DATABASE_URL = file:${absolute}`)
} else {
    if (!process.env.DATABASE_URL) {
        console.error('[db-setup] DATABASE_URL is required for postgresql engine')
        process.exit(1)
    }
    console.log('[db-setup] Using DATABASE_URL from environment')
}

// ── prisma generate ───────────────────────────────────────────────────────────

console.log('[db-setup] Running: prisma generate')
execSync('npx prisma generate', { stdio: 'inherit', cwd: root })

// ── prisma db push ────────────────────────────────────────────────────────────

console.log('[db-setup] Running: prisma db push')
execSync('npx prisma db push --skip-generate', {
    stdio: 'inherit',
    cwd: root,
    env: process.env,
})

console.log('[db-setup] Done.')
