#!/usr/bin/env node

import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ACKNOWLEDGEMENT = 'local-regtest-fake-ecash-only'
const FUNDING_FAKE_SATS = 25
const PAYMENT_FAKE_SATS = 1
const RECEIVE_FAKE_SATS = 2
const PROCESS_TIMEOUT_MS = 45_000
const MAX_STATUS_ATTEMPTS = 15
const DATABASE_ENGINE = (process.env.IPPON_REGTEST_DATABASE_ENGINE || 'sqlite').toLowerCase()
const approvalKeys = crypto.generateKeyPairSync('ed25519')
const approvalPublicKey = approvalKeys.publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64url')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appPath = path.join(root, 'dist', 'index.js')
const hookPath = path.join(root, 'scripts', 'regtest-fault-fetch-hook.mjs')
const pythonHookPath = path.join(root, 'scripts', 'regtest-python')
const prismaCliPath = path.join(root, 'node_modules', 'prisma', 'build', 'index.js')
const sqliteSchemaPath = path.join(root, 'prisma', 'schema.sqlite.prisma')
const postgresqlSchemaPath = path.join(root, 'prisma', 'schema.postgresql.prisma')
const schemaPath = DATABASE_ENGINE === 'postgresql' ? postgresqlSchemaPath : sqliteSchemaPath

class SafeFailure extends Error {
    constructor(code) {
        super(code)
        this.code = code
    }
}

function requireCondition(condition, code) {
    if (!condition) throw new SafeFailure(code)
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function approvalSignature(prepared) {
    requireCondition(typeof prepared?.approval_payload === 'string', 'approval_payload_missing')
    return crypto.sign(
        null,
        Buffer.from(prepared.approval_payload, 'utf8'),
        approvalKeys.privateKey,
    ).toString('base64url')
}

async function runProcess(executable, args, { env, input, label }) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            cwd: root,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        const timeout = setTimeout(() => {
            timedOut = true
            child.kill('SIGTERM')
        }, PROCESS_TIMEOUT_MS)

        child.stdout.on('data', chunk => {
            if (stdout.length < 1_000_000) stdout += chunk.toString()
        })
        child.stderr.on('data', chunk => {
            if (stderr.length < 1_000_000) stderr += chunk.toString()
        })
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

        if (input) child.stdin.end(input)
        else child.stdin.end()
    })
}

function lastJsonLine(stdout, label) {
    const values = []
    for (const line of stdout.split(/\r?\n/)) {
        const start = line.indexOf('{')
        if (start < 0) continue
        try {
            values.push(JSON.parse(line.slice(start)))
        } catch {
            // Prompts and non-JSON process output are intentionally ignored.
        }
    }
    requireCondition(values.length > 0, `${label}_missing_json_response`)
    return values.at(-1)
}

function cliEnvironment(context, mode) {
    const existingNodeOptions = process.env.NODE_OPTIONS?.trim()
    const importHook = `--import=${hookPath}`
    return {
        ...process.env,
        DATABASE_ENGINE,
        DATABASE_FILE_PATH: context.databasePath || '',
        DATABASE_URL: context.databaseUrl,
        INTERACTION_MODE: 'cli',
        MINT_URLS: process.env.IPPON_REGTEST_ALLOWED_ORIGINS,
        UNIT: 'sat',
        MAX_BALANCE: '512',
        MAX_SEND: '32',
        MAX_PAY: '32',
        IPPON_APPROVAL_PUBLIC_KEY: approvalPublicKey,
        LOG_LEVEL: 'error',
        IPPON_REGTEST_FAULT_ACK: ACKNOWLEDGEMENT,
        IPPON_REGTEST_FAULT_STATE_PATH: context.faultStatePath,
        IPPON_REGTEST_REQUEST_LOG_PATH: context.requestLogPath,
        IPPON_REGTEST_FAULT_MODE: mode,
        IPPON_REGTEST_ALLOWED_ORIGINS: process.env.IPPON_REGTEST_ALLOWED_ORIGINS,
        IPPON_REGTEST_FAULT_ORIGIN: process.env.IPPON_REGTEST_FAULT_ORIGIN,
        NODE_OPTIONS: existingNodeOptions ? `${existingNodeOptions} ${importHook}` : importHook,
    }
}

async function runCli(command, context, mode = 'observe') {
    const result = await runProcess(process.execPath, [appPath], {
        env: cliEnvironment(context, mode),
        input: `${command}\nexit\n`,
        label: context.label,
    })
    requireCondition(result.code === 0, `${context.label}_process_failed`)
    return lastJsonLine(result.stdout, context.label)
}

async function runCliSuccess(command, context, mode = 'observe') {
    const response = await runCli(command, context, mode)
    requireCondition(response?.error !== true, `${context.label}_${response?.code || 'cli_error'}`)
    return response
}

async function reserveLoopbackPort() {
    const server = net.createServer()
    await new Promise((resolve, reject) => {
        server.once('error', () => reject(new SafeFailure('regtest_port_unavailable')))
        server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    requireCondition(typeof address === 'object' && address !== null, 'regtest_port_unavailable')
    const port = address.port
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    return port
}

async function startLocalNutshell(
    nutshellPath,
    temporaryDirectory,
    role,
    createPreimage,
    extraPreimages = [],
) {
    const port = await reserveLoopbackPort()
    const origin = `http://127.0.0.1:${port}`
    const mintDatabase = path.join(temporaryDirectory, `nutshell-${role}-mint`)
    const cashuDirectory = path.join(temporaryDirectory, `nutshell-${role}-cashu`)
    const pythonPath = process.env.PYTHONPATH
        ? `${pythonHookPath}${path.delimiter}${process.env.PYTHONPATH}`
        : pythonHookPath
    const child = spawn('uv', [
        'run',
        '--isolated',
        '--no-project',
        '--with-editable',
        nutshellPath,
        '--with',
        'marshmallow<4',
        '--with',
        'limits==4.0.1',
        '--python',
        '3.12',
        '--no-progress',
        'mint',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
    ], {
        cwd: nutshellPath,
        env: {
            ...process.env,
            PYTHONPATH: pythonPath,
            PYTHONDONTWRITEBYTECODE: '1',
            CASHU_DIR: cashuDirectory,
            MINT_DATABASE: mintDatabase,
            MINT_PRIVATE_KEY: crypto.randomBytes(32).toString('hex'),
            MINT_INFO_NAME: `Ippon local regtest ${role}`,
            MINT_BACKEND_BOLT11_SAT: 'FakeWallet',
            MINT_URL: origin,
            MINT_HOST: '127.0.0.1',
            MINT_PORT: String(port),
            MINT_LISTEN_HOST: '127.0.0.1',
            MINT_LISTEN_PORT: String(port),
            MINT_RATE_LIMIT: 'FALSE',
            MINT_INPUT_FEE_PPK: '100',
            LIGHTNING_FEE_PERCENT: '1',
            LIGHTNING_RESERVE_FEE_MIN: '1',
            FAKEWALLET_BRR: 'TRUE',
            FAKEWALLET_DELAY_INCOMING_PAYMENT: '0',
            FAKEWALLET_DELAY_OUTGOING_PAYMENT: '0',
            FAKEWALLET_PAYMENT_STATE: 'SETTLED',
            FAKEWALLET_PAY_INVOICE_STATE: 'SETTLED',
            IPPON_NUTSHELL_REGTEST_ACK: ACKNOWLEDGEMENT,
            IPPON_NUTSHELL_CREATE_PREIMAGE: createPreimage,
            IPPON_NUTSHELL_EXTRA_PREIMAGES: extraPreimages.join(','),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    let exited = false
    child.once('exit', () => { exited = true })
    child.stdout.resume()
    child.stderr.resume()

    const deadline = Date.now() + 300_000
    while (Date.now() < deadline) {
        if (exited) throw new SafeFailure('local_nutshell_exited_during_startup')
        let response
        try {
            response = await fetch(`${origin}/v1/info`, { redirect: 'error' })
        } catch {
            // Dependency setup and local mint startup can take a few minutes.
        }
        if (response?.ok) {
            const info = await response.json()
            requireCondition(/^Nutshell\//.test(info?.version || ''), 'local_nutshell_identity_changed')
            requireCondition(info?.nuts?.['4']?.disabled === false, 'local_nutshell_minting_disabled')
            requireCondition(Array.isArray(info?.nuts?.['5']?.methods), 'local_nutshell_melting_unavailable')
            requireCondition(info?.nuts?.['20']?.supported === true, 'local_nutshell_nut20_unavailable')
            return { child, origin }
        }
        await delay(500)
    }
    child.kill('SIGTERM')
    throw new SafeFailure('local_nutshell_startup_timed_out')
}

async function stopProcess(child) {
    if (!child || child.exitCode !== null) return
    child.kill('SIGTERM')
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        delay(5_000),
    ])
    if (child.exitCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve))
        child.kill('SIGKILL')
        await exited
    }
}

async function generatePrismaClient(targetSchemaPath, label) {
    const result = await runProcess(process.execPath, [
        prismaCliPath,
        'generate',
        '--schema',
        targetSchemaPath,
    ], {
        env: process.env,
        label,
    })
    requireCondition(result.code === 0, `${label}_failed`)
}

async function setupDatabase(context) {
    const result = await runProcess(process.execPath, [
        prismaCliPath,
        'db',
        'push',
        '--schema',
        schemaPath,
        '--skip-generate',
    ], {
        env: { ...process.env, DATABASE_URL: context.databaseUrl },
        label: 'database_setup',
    })
    requireCondition(result.code === 0, 'database_setup_failed')
}

function validatedPostgresqlUrl(raw, expectedDatabase, label) {
    let url
    try {
        url = new URL(raw)
    } catch {
        throw new SafeFailure(`${label}_invalid`)
    }
    requireCondition(
        url.protocol === 'postgresql:'
        && url.hostname === '127.0.0.1'
        && /^\d+$/.test(url.port)
        && url.username === 'postgres'
        && Boolean(url.password)
        && url.pathname === `/${expectedDatabase}`
        && (url.search === '' || url.search === '?schema=public')
        && url.hash === '',
        `${label}_must_be_disposable_loopback_database`,
    )
    return url.toString()
}

async function restoreDatabase(context) {
    if (DATABASE_ENGINE === 'sqlite') {
        const restoredDatabasePath = path.join(context.temporaryDirectory, 'ippon-restored.sqlite')
        await copyFile(context.databasePath, restoredDatabasePath)
        await chmod(restoredDatabasePath, 0o600)
        return {
            ...context,
            databasePath: restoredDatabasePath,
            databaseUrl: `file:${restoredDatabasePath}`,
        }
    }

    const containerName = process.env.IPPON_REGTEST_POSTGRES_CONTAINER || ''
    requireCondition(
        /^ippon-regtest-postgres-[0-9a-f]{16}$/.test(containerName),
        'postgres_container_name_invalid',
    )
    const dockerPath = process.env.IPPON_REGTEST_DOCKER_BIN || 'docker'
    const dumpPath = `/tmp/ippon-regtest-${crypto.randomBytes(8).toString('hex')}.dump`
    const primaryDatabase = 'ippon_regtest_primary'
    const restoreDatabaseName = 'ippon_regtest_restore'
    const dump = await runProcess(dockerPath, [
        'exec',
        '--user',
        'postgres',
        containerName,
        'pg_dump',
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--file',
        dumpPath,
        '--username',
        'postgres',
        primaryDatabase,
    ], {
        env: process.env,
        label: 'postgres_logical_dump',
    })
    requireCondition(dump.code === 0, 'postgres_logical_dump_failed')
    const restored = await runProcess(dockerPath, [
        'exec',
        '--user',
        'postgres',
        containerName,
        'pg_restore',
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '--dbname',
        restoreDatabaseName,
        '--username',
        'postgres',
        dumpPath,
    ], {
        env: process.env,
        label: 'postgres_logical_restore',
    })
    requireCondition(restored.code === 0, 'postgres_logical_restore_failed')
    return {
        ...context,
        databasePath: undefined,
        databaseUrl: validatedPostgresqlUrl(
            process.env.IPPON_REGTEST_RESTORE_DATABASE_URL || '',
            restoreDatabaseName,
            'postgres_restore_database_url',
        ),
    }
}

async function fundDisposableWallet(context) {
    const created = await runCliSuccess(
        `wallet create fault-source ${process.env.IPPON_REGTEST_FAULT_ORIGIN}`,
        { ...context, label: 'source_wallet_create' },
    )
    requireCondition(typeof created.access_key === 'string', 'source_wallet_key_missing')

    const intentId = `wallet_${crypto.randomBytes(12).toString('hex')}`
    const prepared = await runCliSuccess(
        `wallet ${created.access_key} receive-prepare ${intentId} ${FUNDING_FAKE_SATS}`,
        { ...context, label: 'source_locked_funding_quote' },
    )
    requireCondition(typeof prepared.request === 'string', 'source_funding_invoice_missing')

    let lastStatus
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const status = await runCliSuccess(
            `wallet ${created.access_key} receive-status ${intentId}`,
            { ...context, label: 'source_funding_status' },
        )
        lastStatus = status
        if (status.state === 'PAID') {
            const issued = await runCliSuccess(
                `wallet ${created.access_key} receive-execute ${intentId} ${prepared.invoice_sha256} ${prepared.quote_sha256} ${prepared.output_plan_sha256} ${approvalSignature(prepared)}`,
                { ...context, label: 'source_locked_funding_mint' },
            )
            requireCondition(issued.state === 'ISSUED', 'source_fake_funding_not_issued')
            requireCondition(issued.balance === FUNDING_FAKE_SATS, 'source_fake_funding_balance_mismatch')
            return created.access_key
        }
        await delay(500)
    }
    throw new SafeFailure(
        `source_fake_funding_${lastStatus?.state || 'missing'}_${lastStatus?.quote_state || 'none'}_${lastStatus?.error_code || 'none'}`,
    )
}

async function createPaymentInvoice(context, destinationOrigin) {
    const destination = await runCliSuccess(
        `wallet create fault-destination ${destinationOrigin}`,
        { ...context, label: 'destination_wallet_create' },
    )
    requireCondition(typeof destination.access_key === 'string', 'destination_wallet_key_missing')
    const intentId = `wallet_${crypto.randomBytes(12).toString('hex')}`
    const prepared = await runCliSuccess(
        `wallet ${destination.access_key} receive-prepare ${intentId} ${PAYMENT_FAKE_SATS}`,
        { ...context, label: 'destination_locked_invoice_create' },
    )
    requireCondition(typeof prepared.request === 'string', 'destination_invoice_missing')
    requireCondition(prepared.request.toLowerCase().startsWith('lnbc'), 'destination_invoice_not_mainnet_bolt11')
    return prepared.request
}

function changedHash(hash) {
    return `${hash[0] === '0' ? '1' : '0'}${hash.slice(1)}`
}

async function readFaultState(faultStatePath) {
    return JSON.parse(await readFile(faultStatePath, 'utf8'))
}

async function readRequestCounts(requestLogPath) {
    const counts = { melt: 0, mint: 0 }
    for (const line of (await readFile(requestLogPath, 'utf8')).split(/\r?\n/)) {
        if (line === 'melt' || line === 'mint') counts[line] += 1
    }
    return counts
}

async function main() {
    requireCondition(
        process.env.IPPON_REGTEST_FAULT_ACK === ACKNOWLEDGEMENT,
        'explicit_local_regtest_ack_required',
    )
    requireCondition(FUNDING_FAKE_SATS <= 25, 'fake_funding_limit_exceeded')
    requireCondition(PAYMENT_FAKE_SATS <= 1, 'fake_payment_limit_exceeded')
    requireCondition(RECEIVE_FAKE_SATS <= 2, 'fake_receive_limit_exceeded')
    requireCondition(
        DATABASE_ENGINE === 'sqlite' || DATABASE_ENGINE === 'postgresql',
        'unsupported_regtest_database_engine',
    )
    await access(appPath)
    await access(hookPath)
    await access(pythonHookPath)
    const nutshellPath = process.env.IPPON_NUTSHELL_PATH
    requireCondition(Boolean(nutshellPath) && path.isAbsolute(nutshellPath), 'official_nutshell_path_required')
    await access(path.join(nutshellPath, 'pyproject.toml'))
    await access(path.join(nutshellPath, 'cashu', 'lightning', 'fake.py'))

    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'ippon-regtest-fault-'))
    const databasePath = DATABASE_ENGINE === 'sqlite'
        ? path.join(temporaryDirectory, 'ippon.sqlite')
        : undefined
    const databaseUrl = DATABASE_ENGINE === 'sqlite'
        ? `file:${databasePath}`
        : validatedPostgresqlUrl(
            process.env.IPPON_REGTEST_DATABASE_URL || '',
            'ippon_regtest_primary',
            'postgres_database_url',
        )
    const faultStatePath = path.join(temporaryDirectory, 'fault-state.json')
    const requestLogPath = path.join(temporaryDirectory, 'request-log.txt')
    const context = {
        databasePath,
        databaseUrl,
        faultStatePath,
        requestLogPath,
        temporaryDirectory,
    }
    let prisma
    const localMints = []
    let summary
    let postgresqlConcurrency
    let faultMeltPosts
    let faultMintPosts

    try {
        await writeFile(faultStatePath, `${JSON.stringify({
            version: 1,
            network_requests: 0,
            melt_posts: 0,
            melt_quote_checks: 0,
            mint_posts: 0,
            mint_quote_checks: 0,
            restore_posts: 0,
            proof_state_checks: 0,
            other_requests: 0,
            melt_response_dropped: false,
            first_reconcile_blocked: false,
            melt_http_status: null,
            melt_error_code: null,
            mint_response_dropped: false,
            first_mint_reconcile_blocked: false,
            mint_http_status: null,
        })}\n`, { mode: 0o600 })
        await writeFile(requestLogPath, '', { mode: 0o600 })
        if (DATABASE_ENGINE === 'sqlite') {
            // Prisma's schema engine checks SQLite connectivity before `db push`;
            // create the private empty file first so that check remains local and
            // deterministic on every supported host.
            await writeFile(databasePath, '', { mode: 0o600 })
        }
        // The generated client is a disposable build artifact. Regenerate the
        // selected provider at startup so a host restart cannot leave a prior
        // PostgreSQL drill's client wired to the SQLite scenario or vice versa.
        await generatePrismaClient(schemaPath, `${DATABASE_ENGINE}_prisma_generate`)
        await setupDatabase(context)
        const sourcePreimage = crypto.randomBytes(32).toString('hex')
        const destinationPreimage = crypto.randomBytes(32).toString('hex')
        const concurrentDestinationPreimage = DATABASE_ENGINE === 'postgresql'
            ? crypto.randomBytes(32).toString('hex')
            : undefined
        const destinationMint = await startLocalNutshell(
            nutshellPath,
            temporaryDirectory,
            'destination',
            destinationPreimage,
        )
        localMints.push(destinationMint)
        let concurrentDestinationMint
        if (concurrentDestinationPreimage) {
            concurrentDestinationMint = await startLocalNutshell(
                nutshellPath,
                temporaryDirectory,
                'concurrent-destination',
                concurrentDestinationPreimage,
            )
            localMints.push(concurrentDestinationMint)
        }
        const sourceMint = await startLocalNutshell(
            nutshellPath,
            temporaryDirectory,
            'source',
            sourcePreimage,
            [destinationPreimage, concurrentDestinationPreimage].filter(Boolean),
        )
        localMints.push(sourceMint)
        process.env.IPPON_REGTEST_ALLOWED_ORIGINS = [
            sourceMint.origin,
            destinationMint.origin,
            concurrentDestinationMint?.origin,
        ].filter(Boolean).join(',')
        process.env.IPPON_REGTEST_FAULT_ORIGIN = sourceMint.origin

        const sourceAccessKey = await fundDisposableWallet(context)
        const invoice = await createPaymentInvoice(context, destinationMint.origin)
        const intentId = `wallet_${crypto.randomBytes(12).toString('hex')}`
        const prepared = await runCliSuccess(
            `wallet ${sourceAccessKey} pay-prepare ${intentId} ${invoice}`,
            { ...context, label: 'payment_prepare' },
        )
        requireCondition(prepared.state === 'PREPARED', 'payment_not_prepared')
        requireCondition(prepared.amount === PAYMENT_FAKE_SATS, 'prepared_amount_mismatch')
        requireCondition(Number.isSafeInteger(prepared.max_spend), 'prepared_max_spend_invalid')
        requireCondition(
            Number.isSafeInteger(prepared.proof_input_total)
            && prepared.proof_input_total > prepared.max_spend,
            'prepared_change_bearing_proof_input_missing',
        )
        requireCondition(
            prepared.minimum_change === prepared.proof_input_total - prepared.max_spend
            && prepared.minimum_change > 0,
            'prepared_minimum_change_mismatch',
        )
        for (const field of ['invoice_sha256', 'quote_sha256', 'proof_plan_sha256', 'payment_hash']) {
            requireCondition(/^[0-9a-f]{64}$/.test(prepared[field]), `prepared_${field}_invalid`)
        }

        const tampered = await runCli(
            `wallet ${sourceAccessKey} pay-execute ${intentId} ${changedHash(prepared.invoice_sha256)} ${prepared.quote_sha256} ${prepared.proof_plan_sha256} ${approvalSignature(prepared)}`,
            { ...context, label: 'tampered_approval' },
        )
        requireCondition(tampered?.error === true, 'tampered_approval_was_accepted')
        requireCondition(tampered.code === 'APPROVAL_MISMATCH', 'tampered_approval_wrong_error')
        const afterTamper = await runCliSuccess(
            `wallet ${sourceAccessKey} pay-status ${intentId}`,
            { ...context, label: 'status_after_tamper' },
        )
        requireCondition(afterTamper.state === 'PREPARED', 'tamper_changed_operation_state')
        let faultState = await readFaultState(faultStatePath)
        requireCondition(faultState.melt_posts === 0, 'tamper_reached_melt_endpoint')

        const unknown = await runCliSuccess(
            `wallet ${sourceAccessKey} pay-execute ${intentId} ${prepared.invoice_sha256} ${prepared.quote_sha256} ${prepared.proof_plan_sha256} ${approvalSignature(prepared)}`,
            { ...context, label: 'lost_response_execute' },
            'drop-melt-and-block-reconcile',
        )
        faultState = await readFaultState(faultStatePath)
        requireCondition(
            unknown.state === 'UNKNOWN',
            `lost_response_state_${unknown.state || 'missing'}_posts_${faultState.melt_posts}_dropped_${faultState.melt_response_dropped}_http_${faultState.melt_http_status}_cashu_${faultState.melt_error_code}`,
        )
        requireCondition(unknown.error_code === 'reconciliation_unavailable', 'unknown_reason_mismatch')
        requireCondition(faultState.melt_posts === 1, 'melt_post_count_after_execute_mismatch')
        faultMeltPosts = faultState.melt_posts
        requireCondition(faultState.melt_response_dropped === true, 'melt_response_was_not_dropped')
        requireCondition(faultState.first_reconcile_blocked === true, 'first_reconcile_was_not_blocked')

        let paid
        let lastStatus
        for (let attempt = 0; attempt < MAX_STATUS_ATTEMPTS; attempt += 1) {
            const status = await runCliSuccess(
                `wallet ${sourceAccessKey} pay-status ${intentId}`,
                { ...context, label: 'restart_status_reconcile' },
            )
            lastStatus = status
            if (status.state === 'PAID') {
                paid = status
                break
            }
            await delay(750)
        }
        const safeProofStates = Array.isArray(lastStatus?.proof_states)
            ? lastStatus.proof_states.join('-')
            : 'missing'
        requireCondition(
            paid?.state === 'PAID',
            `restart_state_${lastStatus?.state || 'missing'}_error_${lastStatus?.error_code || 'none'}_quote_${lastStatus?.quote_state || 'none'}_proofs_${safeProofStates}_preimage_${Boolean(lastStatus?.payment_preimage)}`,
        )
        requireCondition(Array.isArray(paid.proof_states) && paid.proof_states.length > 0, 'paid_proof_evidence_missing')
        requireCondition(paid.proof_states.every(state => state === 'SPENT'), 'not_all_remote_proofs_spent')
        requireCondition(/^[0-9a-fA-F]{64}$/.test(paid.payment_preimage || ''), 'paid_preimage_missing')
        const preimageHash = crypto
            .createHash('sha256')
            .update(Buffer.from(paid.payment_preimage, 'hex'))
            .digest('hex')
        requireCondition(preimageHash === prepared.payment_hash, 'paid_preimage_mismatch')

        process.env.DATABASE_URL = databaseUrl
        const { PrismaClient } = await import('@prisma/client')
        prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
        const operation = await prisma.meltOperation.findUnique({ where: { intentId } })
        requireCondition(operation?.state === 'PAID', 'database_operation_not_paid')
        requireCondition(operation.executionCount === 1, 'database_execution_count_mismatch')
        const sourceWallet = await prisma.wallet.findUnique({
            where: { accessKey: sourceAccessKey.replaceAll('-', '') },
        })
        requireCondition(Boolean(sourceWallet), 'database_source_wallet_missing')
        const [pendingProofs, reservedProofs, spentProofs] = await Promise.all([
            prisma.proof.count({ where: { walletId: sourceWallet.id, status: 'PENDING' } }),
            prisma.proof.count({ where: { walletId: sourceWallet.id, reservedByIntentId: { not: null } } }),
            prisma.proof.count({ where: { walletId: sourceWallet.id, status: 'SPENT' } }),
        ])
        requireCondition(pendingProofs === 0, 'database_pending_proofs_remain')
        requireCondition(reservedProofs === 0, 'database_reserved_proofs_remain')
        requireCondition(spentProofs === paid.proof_states.length, 'database_spent_proof_count_mismatch')
        if (DATABASE_ENGINE === 'sqlite') {
            const integrityRows = await prisma.$queryRawUnsafe('PRAGMA integrity_check')
            requireCondition(
                Array.isArray(integrityRows)
                && integrityRows.length === 1
                && Object.values(integrityRows[0])[0] === 'ok',
                'database_integrity_check_failed',
            )
        } else {
            const databaseRows = await prisma.$queryRawUnsafe(
                'SELECT current_database() AS database_name, pg_is_in_recovery() AS in_recovery',
            )
            requireCondition(
                Array.isArray(databaseRows)
                && databaseRows.length === 1
                && databaseRows[0].database_name === 'ippon_regtest_primary'
                && databaseRows[0].in_recovery === false,
                'postgres_database_identity_check_failed',
            )
        }

        const balanceBeforeReceive = await runCliSuccess(
            `wallet ${sourceAccessKey} balance`,
            { ...context, label: 'receive_balance_before' },
        )
        const receiveIntentId = `wallet_${crypto.randomBytes(12).toString('hex')}`
        const receivePrepared = await runCliSuccess(
            `wallet ${sourceAccessKey} receive-prepare ${receiveIntentId} ${RECEIVE_FAKE_SATS}`,
            { ...context, label: 'locked_receive_prepare' },
        )
        requireCondition(receivePrepared.state === 'PREPARED', 'receive_not_prepared')
        requireCondition(receivePrepared.quote_state === 'UNPAID', 'receive_quote_not_unpaid')
        requireCondition(receivePrepared.amount === RECEIVE_FAKE_SATS, 'receive_amount_mismatch')
        requireCondition(
            typeof receivePrepared.request === 'string'
            && receivePrepared.request.toLowerCase().startsWith('lnbc'),
            'receive_invoice_invalid',
        )
        for (const field of ['invoice_sha256', 'quote_sha256', 'output_plan_sha256']) {
            requireCondition(
                /^[0-9a-f]{64}$/.test(receivePrepared[field]),
                `receive_${field}_invalid`,
            )
        }
        requireCondition(
            !Object.hasOwn(receivePrepared, 'quote')
            && !Object.hasOwn(receivePrepared, 'quotePrivkey')
            && !Object.hasOwn(receivePrepared, 'outputDataJson'),
            'receive_prepare_exposed_private_material',
        )
        const receivePrivatePlan = await prisma.mintOperation.findUnique({
            where: { intentId: receiveIntentId },
        })
        requireCondition(
            /^[0-9a-f]{64}$/.test(receivePrivatePlan?.quotePrivkey || ''),
            'receive_private_quote_key_missing',
        )
        requireCondition(
            /^(02|03)[0-9a-f]{64}$/.test(receivePrivatePlan?.quotePubkey || ''),
            'receive_quote_pubkey_invalid',
        )
        requireCondition(
            typeof receivePrivatePlan?.signature === 'string'
            && typeof receivePrivatePlan?.outputDataJson === 'string',
            'receive_signed_output_plan_missing',
        )

        let receivePaid
        let lastReceiveStatus
        for (let attempt = 0; attempt < MAX_STATUS_ATTEMPTS; attempt += 1) {
            const status = await runCliSuccess(
                `wallet ${sourceAccessKey} receive-status ${receiveIntentId}`,
                { ...context, label: 'receive_wait_for_paid' },
            )
            lastReceiveStatus = status
            if (status.state === 'PAID') {
                receivePaid = status
                break
            }
            await delay(750)
        }
        requireCondition(
            receivePaid?.state === 'PAID',
            `receive_not_paid_${lastReceiveStatus?.state || 'missing'}_${lastReceiveStatus?.error_code || 'none'}`,
        )

        faultState = await readFaultState(faultStatePath)
        const mintPostsBeforeExecute = faultState.mint_posts
        const tamperedReceive = await runCli(
            `wallet ${sourceAccessKey} receive-execute ${receiveIntentId} ${changedHash(receivePrepared.invoice_sha256)} ${receivePrepared.quote_sha256} ${receivePrepared.output_plan_sha256} ${approvalSignature(receivePrepared)}`,
            { ...context, label: 'tampered_receive_approval' },
        )
        requireCondition(tamperedReceive?.error === true, 'tampered_receive_was_accepted')
        requireCondition(
            tamperedReceive.code === 'APPROVAL_HASH_MISMATCH',
            'tampered_receive_wrong_error',
        )
        faultState = await readFaultState(faultStatePath)
        requireCondition(
            faultState.mint_posts === mintPostsBeforeExecute,
            'tampered_receive_reached_mint_endpoint',
        )

        const unknownReceive = await runCliSuccess(
            `wallet ${sourceAccessKey} receive-execute ${receiveIntentId} ${receivePrepared.invoice_sha256} ${receivePrepared.quote_sha256} ${receivePrepared.output_plan_sha256} ${approvalSignature(receivePrepared)}`,
            { ...context, label: 'lost_mint_response_execute' },
            'drop-mint-and-block-reconcile',
        )
        faultState = await readFaultState(faultStatePath)
        requireCondition(
            unknownReceive.state === 'UNKNOWN',
            `lost_mint_response_${unknownReceive.state || 'missing'}_${unknownReceive.error_code || 'none'}_posts_${faultState.mint_posts}_dropped_${faultState.mint_response_dropped}_blocked_${faultState.first_mint_reconcile_blocked}`,
        )
        requireCondition(
            unknownReceive.error_code === 'reconciliation_unavailable',
            'lost_mint_response_reason_mismatch',
        )
        requireCondition(
            faultState.mint_posts === mintPostsBeforeExecute + 1,
            'mint_post_count_after_execute_mismatch',
        )
        faultMintPosts = faultState.mint_posts - mintPostsBeforeExecute
        requireCondition(faultState.mint_response_dropped === true, 'mint_response_was_not_dropped')
        requireCondition(
            faultState.first_mint_reconcile_blocked === true,
            'first_mint_reconcile_was_not_blocked',
        )

        let receiveIssued
        for (let attempt = 0; attempt < MAX_STATUS_ATTEMPTS; attempt += 1) {
            const status = await runCliSuccess(
                `wallet ${sourceAccessKey} receive-status ${receiveIntentId}`,
                { ...context, label: 'restart_receive_restore' },
            )
            lastReceiveStatus = status
            if (status.state === 'ISSUED') {
                receiveIssued = status
                break
            }
            await delay(750)
        }
        requireCondition(
            receiveIssued?.state === 'ISSUED',
            `receive_restore_state_${lastReceiveStatus?.state || 'missing'}_${lastReceiveStatus?.error_code || 'none'}`,
        )
        requireCondition(receiveIssued.proofs_issued > 0, 'receive_issued_proofs_missing')
        requireCondition(
            receiveIssued.balance === balanceBeforeReceive.balance + RECEIVE_FAKE_SATS,
            'receive_balance_after_mismatch',
        )
        const receiveOperation = await prisma.mintOperation.findUnique({
            where: { intentId: receiveIntentId },
        })
        requireCondition(receiveOperation?.state === 'ISSUED', 'database_receive_not_issued')
        requireCondition(receiveOperation.executionCount === 1, 'receive_execution_count_mismatch')
        requireCondition(receiveOperation.quotePrivkey === null, 'terminal_receive_key_not_cleared')
        requireCondition(receiveOperation.outputDataJson === null, 'terminal_receive_outputs_not_cleared')
        requireCondition(receiveOperation.signature === null, 'terminal_receive_signature_not_cleared')
        faultState = await readFaultState(faultStatePath)
        requireCondition(
            faultState.mint_posts === mintPostsBeforeExecute + 1,
            'mint_was_retried_after_restart',
        )
        requireCondition(
            faultState.melt_posts === faultMeltPosts,
            'melt_was_retried_after_restart',
        )
        requireCondition(faultState.restore_posts > 0, 'nut09_restore_was_not_used')

        if (DATABASE_ENGINE === 'postgresql') {
            const concurrentInvoice = await createPaymentInvoice(
                context,
                concurrentDestinationMint.origin,
            )
            const concurrentPayIntentId = `wallet_${crypto.randomBytes(12).toString('hex')}`
            const concurrentPayPrepared = await runCliSuccess(
                `wallet ${sourceAccessKey} pay-prepare ${concurrentPayIntentId} ${concurrentInvoice}`,
                { ...context, label: 'postgres_concurrent_payment_prepare' },
            )
            const requestCountsBeforePayConcurrency = await readRequestCounts(requestLogPath)
            const concurrentPayCommand = `wallet ${sourceAccessKey} pay-execute ${concurrentPayIntentId} ${concurrentPayPrepared.invoice_sha256} ${concurrentPayPrepared.quote_sha256} ${concurrentPayPrepared.proof_plan_sha256} ${approvalSignature(concurrentPayPrepared)}`
            const concurrentPayResults = await Promise.all([
                runCli(concurrentPayCommand, {
                    ...context,
                    label: 'postgres_concurrent_payment_execute_a',
                }),
                runCli(concurrentPayCommand, {
                    ...context,
                    label: 'postgres_concurrent_payment_execute_b',
                }),
            ])
            const concurrentPaySuccesses = concurrentPayResults.filter(result => result?.error !== true)
            requireCondition(
                concurrentPaySuccesses.length === 1
                && concurrentPaySuccesses[0].state === 'PAID',
                'postgres_concurrent_payment_not_one_shot',
            )
            const requestCountsAfterPayConcurrency = await readRequestCounts(requestLogPath)
            requireCondition(
                requestCountsAfterPayConcurrency.melt === requestCountsBeforePayConcurrency.melt + 1,
                'postgres_concurrent_payment_reached_mint_more_than_once',
            )
            const concurrentPayOperation = await prisma.meltOperation.findUnique({
                where: { intentId: concurrentPayIntentId },
            })
            requireCondition(
                concurrentPayOperation?.state === 'PAID'
                && concurrentPayOperation.executionCount === 1,
                'postgres_concurrent_payment_database_mismatch',
            )

            const concurrentReceiveIntentId = `wallet_${crypto.randomBytes(12).toString('hex')}`
            const concurrentReceivePrepared = await runCliSuccess(
                `wallet ${sourceAccessKey} receive-prepare ${concurrentReceiveIntentId} ${RECEIVE_FAKE_SATS}`,
                { ...context, label: 'postgres_concurrent_receive_prepare' },
            )
            let concurrentReceivePaid
            let lastConcurrentReceiveStatus
            for (let attempt = 0; attempt < MAX_STATUS_ATTEMPTS; attempt += 1) {
                const status = await runCliSuccess(
                    `wallet ${sourceAccessKey} receive-status ${concurrentReceiveIntentId}`,
                    { ...context, label: 'postgres_concurrent_receive_wait_for_paid' },
                )
                lastConcurrentReceiveStatus = status
                if (status.state === 'PAID') {
                    concurrentReceivePaid = status
                    break
                }
                await delay(750)
            }
            requireCondition(
                concurrentReceivePaid?.state === 'PAID',
                `postgres_concurrent_receive_not_paid_${lastConcurrentReceiveStatus?.state || 'missing'}`,
            )
            const requestCountsBeforeReceiveConcurrency = await readRequestCounts(requestLogPath)
            const concurrentReceiveCommand = `wallet ${sourceAccessKey} receive-execute ${concurrentReceiveIntentId} ${concurrentReceivePrepared.invoice_sha256} ${concurrentReceivePrepared.quote_sha256} ${concurrentReceivePrepared.output_plan_sha256} ${approvalSignature(concurrentReceivePrepared)}`
            const concurrentReceiveResults = await Promise.all([
                runCli(concurrentReceiveCommand, {
                    ...context,
                    label: 'postgres_concurrent_receive_execute_a',
                }),
                runCli(concurrentReceiveCommand, {
                    ...context,
                    label: 'postgres_concurrent_receive_execute_b',
                }),
            ])
            const concurrentReceiveOutcomes = concurrentReceiveResults.map(result => (
                result?.error === true
                    ? `error-${result.code || 'unknown'}`
                    : `state-${result?.state || 'missing'}`
            )).join('_')
            requireCondition(
                concurrentReceiveResults.every(
                    result => result?.error === true
                        || result?.state === 'UNKNOWN'
                        || result?.state === 'ISSUED',
                ),
                `postgres_concurrent_receive_result_invalid_${concurrentReceiveOutcomes}`,
            )
            let concurrentReceiveIssued
            let lastConcurrentRecoveryStatus
            for (let attempt = 0; attempt < MAX_STATUS_ATTEMPTS; attempt += 1) {
                const status = await runCliSuccess(
                    `wallet ${sourceAccessKey} receive-status ${concurrentReceiveIntentId}`,
                    { ...context, label: 'postgres_concurrent_receive_recovery' },
                )
                lastConcurrentRecoveryStatus = status
                if (status.state === 'ISSUED') {
                    concurrentReceiveIssued = status
                    break
                }
                await delay(750)
            }
            requireCondition(
                concurrentReceiveIssued?.state === 'ISSUED',
                `postgres_concurrent_receive_not_recovered_${lastConcurrentRecoveryStatus?.state || 'missing'}`,
            )
            const requestCountsAfterReceiveConcurrency = await readRequestCounts(requestLogPath)
            requireCondition(
                requestCountsAfterReceiveConcurrency.mint
                    === requestCountsBeforeReceiveConcurrency.mint + 1,
                'postgres_concurrent_receive_reached_mint_more_than_once',
            )
            const concurrentReceiveOperation = await prisma.mintOperation.findUnique({
                where: { intentId: concurrentReceiveIntentId },
            })
            requireCondition(
                concurrentReceiveOperation?.state === 'ISSUED'
                && concurrentReceiveOperation.executionCount === 1
                && concurrentReceiveOperation.quotePrivkey === null
                && concurrentReceiveOperation.outputDataJson === null
                && concurrentReceiveOperation.signature === null,
                'postgres_concurrent_receive_database_mismatch',
            )
            postgresqlConcurrency = {
                payment_execute_callers: concurrentPayResults.length,
                payment_melt_posts: requestCountsAfterPayConcurrency.melt
                    - requestCountsBeforePayConcurrency.melt,
                payment_execution_count: concurrentPayOperation.executionCount,
                receive_execute_callers: concurrentReceiveResults.length,
                receive_mint_posts: requestCountsAfterReceiveConcurrency.mint
                    - requestCountsBeforeReceiveConcurrency.mint,
                receive_execution_count: concurrentReceiveOperation.executionCount,
                terminal_private_material_cleared: true,
            }
        }

        const sourceAudit = await runCliSuccess(
            `restore-audit ${sourceMint.origin}`,
            { ...context, label: 'source_full_proof_audit' },
        )
        requireCondition(sourceAudit.funded_restore_ready === true, 'source_proof_audit_not_ready')
        requireCondition(sourceAudit.all_proofs_checked === true, 'source_proof_audit_incomplete')
        requireCondition(sourceAudit.remote_pending === 0, 'source_proof_audit_pending')
        requireCondition(sourceAudit.state_mismatches === 0, 'source_proof_audit_mismatch')
        requireCondition(sourceAudit.reserved_proofs === 0, 'source_proof_audit_reserved')
        requireCondition(sourceAudit.unresolved_operations === 0, 'source_proof_audit_unresolved')
        requireCondition(sourceAudit.recoverable_balance > 0, 'source_proof_audit_unfunded')

        await prisma.$disconnect()
        prisma = undefined
        const restoredContext = await restoreDatabase(context)
        const restoredAudit = await runCliSuccess(
            `restore-audit ${sourceMint.origin}`,
            {
                ...restoredContext,
                label: 'restored_full_proof_audit',
            },
        )
        requireCondition(
            JSON.stringify(restoredAudit) === JSON.stringify(sourceAudit),
            'restored_proof_audit_changed',
        )

        faultState = await readFaultState(faultStatePath)
        const finalRequestCounts = await readRequestCounts(requestLogPath)
        requireCondition(
            finalRequestCounts.melt === faultMeltPosts + (DATABASE_ENGINE === 'postgresql' ? 1 : 0),
            'unexpected_total_melt_post_count',
        )
        summary = {
            ok: true,
            environment: 'official-nutshell-local-fakewallet-regtest',
            database_engine: DATABASE_ENGINE,
            fake_sats: {
                funded: FUNDING_FAKE_SATS,
                payment: PAYMENT_FAKE_SATS,
                receive: RECEIVE_FAKE_SATS,
            },
            fault_injection: {
                accepted_melt_response_dropped: true,
                first_reconciliation_blocked: true,
                immediate_state: 'UNKNOWN',
                melt_posts: faultMeltPosts,
            },
            restart_recovery: {
                method: 'pay-status-only',
                terminal_state: 'PAID',
                execution_count: operation.executionCount,
                remote_spent_proofs: paid.proof_states.length,
                local_pending_proofs: pendingProofs,
                local_reserved_proofs: reservedProofs,
                preimage_verified: true,
                database_integrity: 'ok',
            },
            locked_receive_recovery: {
                method: 'receive-status-with-nut09-restore',
                terminal_state: receiveIssued.state,
                execution_count: receiveOperation.executionCount,
                proofs_issued: receiveIssued.proofs_issued,
                accepted_mint_response_dropped: faultState.mint_response_dropped,
                first_reconciliation_blocked: faultState.first_mint_reconcile_blocked,
                mint_posts: faultMintPosts,
                restore_posts: faultState.restore_posts,
                terminal_private_material_cleared: true,
            },
            approval_tamper_rejected_before_melt: true,
            receive_approval_tamper_rejected_before_mint: true,
            postgresql_concurrency: postgresqlConcurrency,
            change_bearing_proof_plan: {
                maximum_spend: prepared.max_spend,
                proof_input_total: prepared.proof_input_total,
                minimum_change: prepared.minimum_change,
            },
            restored_proof_audit: {
                all_proofs_checked: restoredAudit.all_proofs_checked,
                proofs_total: restoredAudit.proofs_total,
                recoverable_balance: restoredAudit.recoverable_balance,
                remote_unspent: restoredAudit.remote_unspent,
                remote_pending: restoredAudit.remote_pending,
                remote_spent: restoredAudit.remote_spent,
                state_mismatches: restoredAudit.state_mismatches,
                funded_restore_ready: restoredAudit.funded_restore_ready,
            },
            secrets_emitted: false,
        }
    } finally {
        if (prisma) await prisma.$disconnect()
        for (const mint of localMints) await stopProcess(mint.child)
        if (DATABASE_ENGINE === 'postgresql') {
            await generatePrismaClient(sqliteSchemaPath, 'sqlite_prisma_restore')
        }
        await rm(temporaryDirectory, { recursive: true, force: true })
        try {
            await access(temporaryDirectory)
            throw new SafeFailure('temporary_directory_not_removed')
        } catch (error) {
            if (error instanceof SafeFailure) throw error
            if (error?.code !== 'ENOENT') throw new SafeFailure('temporary_directory_removal_unverified')
        }
    }

    console.log(JSON.stringify({ ...summary, temporary_data_removed: true }))
}

main().catch(error => {
    const code = error instanceof SafeFailure ? error.code : 'unexpected_regtest_harness_failure'
    process.stderr.write(`${JSON.stringify({ ok: false, error_code: code })}\n`)
    process.exitCode = 1
})
