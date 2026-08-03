import {
    closeSync,
    constants,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
} from 'node:fs'
import path from 'node:path'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

function mode(stat) {
    return stat.mode & 0o777
}

function assertNoSymlinkTraversal(target) {
    let candidate = target
    while (true) {
        if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
            throw new Error(`SQLite path must not traverse a symbolic link: ${candidate}`)
        }
        const parent = path.dirname(candidate)
        if (parent === candidate) return
        candidate = parent
    }
}

function validatePrivateDirectory(directory) {
    const stat = lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`SQLite parent must be a regular directory: ${directory}`)
    }
    if (mode(stat) !== PRIVATE_DIRECTORY_MODE) {
        throw new Error(`SQLite parent must have mode 0700: ${directory}`)
    }
}

function validatePrivateFile(database) {
    const stat = lstatSync(database)
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`SQLite database must be a regular file: ${database}`)
    }
    if (mode(stat) !== PRIVATE_FILE_MODE) {
        throw new Error(`SQLite database must have mode 0600: ${database}`)
    }
}

export function ensurePrivateSqlitePath(databasePath, { onCreate = () => {} } = {}) {
    const database = path.resolve(databasePath)
    const directory = path.dirname(database)
    assertNoSymlinkTraversal(directory)

    if (!existsSync(directory)) {
        mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
        onCreate('directory', directory)
    }
    validatePrivateDirectory(directory)

    if (!existsSync(database)) {
        const noFollow = constants.O_NOFOLLOW || 0
        const descriptor = openSync(
            database,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
            PRIVATE_FILE_MODE,
        )
        closeSync(descriptor)
        onCreate('file', database)
    }
    validatePrivateFile(database)
    return database
}
