#!/usr/bin/env node

import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FAULT_ACKNOWLEDGEMENT = 'local-regtest-fake-ecash-only'
const POSTGRES_ACKNOWLEDGEMENT = 'local-disposable-postgresql-only'
const POSTGRES_IMAGE = 'docker.io/library/postgres@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3'
const PRIMARY_DATABASE = 'ippon_regtest_primary'
const RESTORE_DATABASE = 'ippon_regtest_restore'
const PROCESS_TIMEOUT_MS = 300_000

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const faultHarnessPath = path.join(root, 'scripts', 'regtest-split-melt-fault.mjs')

class SafeFailure extends Error {
    constructor(code) {
        super(code)
        this.code = code
    }
}

function requireCondition(condition, code) {
    if (!condition) throw new SafeFailure(code)
}

async function runProcess(executable, args, { env = process.env, label, inherit = false } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            cwd: root,
            env,
            stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        const timeout = setTimeout(() => {
            timedOut = true
            child.kill('SIGTERM')
        }, PROCESS_TIMEOUT_MS)

        if (!inherit) {
            child.stdout.on('data', chunk => {
                if (stdout.length < 1_000_000) stdout += chunk.toString()
            })
            child.stderr.on('data', chunk => {
                if (stderr.length < 1_000_000) stderr += chunk.toString()
            })
        }
        child.on('error', () => {
            clearTimeout(timeout)
            reject(new SafeFailure(`${label}_spawn_failed`))
        })
        child.on('close', code => {
            clearTimeout(timeout)
            if (timedOut) {
                reject(new SafeFailure(`${label}_timed_out`))
                return
            }
            resolve({ code, stdout, stderr })
        })
    })
}

async function reserveLoopbackPort() {
    const server = net.createServer()
    await new Promise((resolve, reject) => {
        server.once('error', () => reject(new SafeFailure('postgres_port_unavailable')))
        server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    requireCondition(typeof address === 'object' && address !== null, 'postgres_port_unavailable')
    const port = address.port
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    return port
}

async function dockerSuccess(dockerPath, args, label) {
    const result = await runProcess(dockerPath, args, { label })
    requireCondition(result.code === 0, `${label}_failed`)
    return result
}

async function waitForPostgresql(dockerPath, containerName) {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
        const logs = await runProcess(dockerPath, ['logs', containerName], {
            label: 'postgres_startup_logs',
        })
        const initComplete = logs.code === 0
            && `${logs.stdout}\n${logs.stderr}`.includes('PostgreSQL init process complete; ready for start up.')
        const result = await runProcess(dockerPath, [
            'exec',
            '--user',
            'postgres',
            containerName,
            'psql',
            '--username',
            'postgres',
            '--dbname',
            PRIMARY_DATABASE,
            '--tuples-only',
            '--no-align',
            '--command',
            'SELECT 1',
        ], { label: 'postgres_readiness' })
        if (initComplete && result.code === 0 && result.stdout.trim() === '1') return
        await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new SafeFailure('postgres_readiness_timed_out')
}

async function main() {
    requireCondition(
        process.env.IPPON_REGTEST_FAULT_ACK === FAULT_ACKNOWLEDGEMENT,
        'explicit_local_regtest_ack_required',
    )
    requireCondition(
        process.env.IPPON_REGTEST_POSTGRES_ACK === POSTGRES_ACKNOWLEDGEMENT,
        'explicit_disposable_postgres_ack_required',
    )
    const dockerPath = process.env.IPPON_REGTEST_DOCKER_BIN || 'docker'
    const containerName = `ippon-regtest-postgres-${crypto.randomBytes(8).toString('hex')}`
    const password = crypto.randomBytes(32).toString('base64url')
    const port = await reserveLoopbackPort()
    const primaryUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/${PRIMARY_DATABASE}?schema=public`
    const restoreUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/${RESTORE_DATABASE}?schema=public`
    let containerMayExist = false

    try {
        await dockerSuccess(dockerPath, ['version'], 'docker_version')
        const image = await runProcess(dockerPath, ['image', 'inspect', POSTGRES_IMAGE], {
            label: 'postgres_image_inspect',
        })
        if (image.code !== 0) {
            await dockerSuccess(dockerPath, ['pull', POSTGRES_IMAGE], 'postgres_image_pull')
        }
        // Mark the random exact name for cleanup before `docker run`: a timeout
        // can make container creation successful while the CLI outcome is
        // unknown, and that must not leave the disposable database running.
        containerMayExist = true
        await dockerSuccess(dockerPath, [
            'run',
            '--detach',
            '--rm',
            '--name',
            containerName,
            '--user',
            'postgres',
            '--publish',
            `127.0.0.1:${port}:5432`,
            '--tmpfs',
            '/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777',
            '--memory',
            '512m',
            '--cpus',
            '0.5',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--env',
            `POSTGRES_PASSWORD=${password}`,
            '--env',
            `POSTGRES_DB=${PRIMARY_DATABASE}`,
            '--env',
            'PGDATA=/tmp/pgdata',
            '--env',
            'POSTGRES_INITDB_ARGS=--data-checksums',
            POSTGRES_IMAGE,
        ], 'postgres_container_start')
        await waitForPostgresql(dockerPath, containerName)
        await dockerSuccess(dockerPath, [
            'exec',
            '--user',
            'postgres',
            containerName,
            'createdb',
            '--username',
            'postgres',
            RESTORE_DATABASE,
        ], 'postgres_restore_database_create')

        const result = await runProcess(process.execPath, [faultHarnessPath], {
            env: {
                ...process.env,
                IPPON_REGTEST_DATABASE_ENGINE: 'postgresql',
                IPPON_REGTEST_DATABASE_URL: primaryUrl,
                IPPON_REGTEST_RESTORE_DATABASE_URL: restoreUrl,
                IPPON_REGTEST_POSTGRES_CONTAINER: containerName,
                IPPON_REGTEST_DOCKER_BIN: dockerPath,
            },
            label: 'postgres_fault_harness',
            inherit: true,
        })
        requireCondition(result.code === 0, 'postgres_fault_harness_failed')
    } finally {
        if (containerMayExist) {
            await runProcess(dockerPath, ['rm', '--force', containerName], {
                label: 'postgres_container_cleanup',
            })
            const remaining = await runProcess(dockerPath, ['inspect', containerName], {
                label: 'postgres_container_cleanup_verify',
            })
            requireCondition(remaining.code !== 0, 'postgres_container_cleanup_failed')
        }
    }
    process.stdout.write(`${JSON.stringify({
        ok: true,
        postgres_image_digest: POSTGRES_IMAGE.split('@')[1],
        postgres_container_removed: true,
    })}\n`)
}

main().catch(error => {
    const code = error instanceof SafeFailure ? error.code : 'unexpected_postgres_harness_failure'
    process.stderr.write(`${JSON.stringify({ ok: false, error_code: code })}\n`)
    process.exitCode = 1
})
