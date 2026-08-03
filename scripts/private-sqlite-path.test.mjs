import {
    chmodSync,
    lstatSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ensurePrivateSqlitePath } from './private-sqlite-path.mjs'

const roots = []

afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    for (const root of roots.splice(0)) {
        await rm(root, { force: true, recursive: true })
    }
})

function temporaryRoot() {
    const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ippon-db-path-'))
    roots.push(root)
    return root
}

function permissions(target) {
    return lstatSync(target).mode & 0o777
}

describe('ensurePrivateSqlitePath', () => {
    it('creates a private directory and empty database before Prisma connects', () => {
        const root = temporaryRoot()
        const database = path.join(root, 'wallet', 'ippon.sqlite')
        const created = []

        expect(ensurePrivateSqlitePath(database, {
            onCreate: (kind, target) => created.push([kind, target]),
        })).toBe(database)
        expect(permissions(path.dirname(database))).toBe(0o700)
        expect(permissions(database)).toBe(0o600)
        expect(readFileSync(database)).toHaveLength(0)
        expect(created).toEqual([
            ['directory', path.dirname(database)],
            ['file', database],
        ])
    })

    it('does not truncate an existing private database', () => {
        const root = temporaryRoot()
        const directory = path.join(root, 'wallet')
        const database = path.join(directory, 'ippon.sqlite')
        ensurePrivateSqlitePath(database)
        writeFileSync(database, 'existing-data')

        ensurePrivateSqlitePath(database)

        expect(readFileSync(database, 'utf8')).toBe('existing-data')
    })

    it('rejects a database symbolic link', () => {
        const root = temporaryRoot()
        const directory = path.join(root, 'wallet')
        const target = path.join(root, 'target.sqlite')
        const database = path.join(directory, 'ippon.sqlite')
        ensurePrivateSqlitePath(target)
        ensurePrivateSqlitePath(path.join(directory, 'placeholder.sqlite'))
        symlinkSync(target, database)

        expect(() => ensurePrivateSqlitePath(database)).toThrow('regular file')
    })

    it('rejects a non-private database directory', () => {
        const root = temporaryRoot()
        const directory = path.join(root, 'wallet')
        const database = path.join(directory, 'ippon.sqlite')
        ensurePrivateSqlitePath(database)
        chmodSync(directory, 0o755)

        expect(() => ensurePrivateSqlitePath(database)).toThrow('mode 0700')
    })

    it('rejects a non-private database file', () => {
        const root = temporaryRoot()
        const database = path.join(root, 'wallet', 'ippon.sqlite')
        ensurePrivateSqlitePath(database)
        chmodSync(database, 0o644)

        expect(() => ensurePrivateSqlitePath(database)).toThrow('mode 0600')
    })
})
