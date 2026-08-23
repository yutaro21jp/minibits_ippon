import os from 'os'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { ensurePrivateSqlitePath } from '../../scripts/private-sqlite-path.mjs'

process.umask(0o077)

// For SQLite: resolve DATABASE_FILE_PATH (which may start with ~) to an
// absolute file: URL before PrismaClient reads it from the environment.
if (process.env.DATABASE_ENGINE === 'sqlite') {
    const raw = process.env.DATABASE_FILE_PATH || '~/.ippon/database.sqlite'
    const expanded = raw.replace(/^~/, os.homedir())
    const database = ensurePrivateSqlitePath(path.resolve(expanded))
    process.env.DATABASE_URL = `file:${database}`
}

const prisma = new PrismaClient()

export default prisma
