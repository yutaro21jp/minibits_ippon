#!/usr/bin/env node

import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ACKNOWLEDGEMENT = 'local-regtest-fake-ecash-only'
const FUNDING_FAKE_SATS = 255
const PAYMENT_FAKE_SATS = 16
const PROCESS_TIMEOUT_MS = 45_000
const MAX_STATUS_ATTEMPTS = 15

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appPath = path.join(root, 'dist', 'index.js')
const hookPath = path.join(root, 'scripts', 'regtest-fault-fetch-hook.mjs')
const pythonHookPath = path.join(root, 'scripts', 'regtest-python')
const prismaCliPath = path.join(root, 'node_modules', 'prisma', 'build', 'index.js')
const schemaPath = path.join(root, 'prisma', 'schema.sqlite.prisma')

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

function cliEnvironment(databasePath, faultStatePath, mode) {
    const existingNodeOptions = process.env.NODE_OPTIONS?.trim()
    const importHook = `--import=${hookPath}`
    return {
        ...process.env,
        DATABASE_ENGINE: 'sqlite',
        DATABASE_FILE_PATH: databasePath,
        DATABASE_URL: `file:${databasePath}`,
        INTERACTION_MODE: 'cli',
        MINT_URLS: process.env.IPPON_REGTEST_ALLOWED_ORIGINS,
        UNIT: 'sat',
        MAX_BALANCE: '512',
        MAX_SEND: '32',
        MAX_PAY: '32',
        LOG_LEVEL: 'error',
        IPPON_REGTEST_FAULT_ACK: ACKNOWLEDGEMENT,
        IPPON_REGTEST_FAULT_STATE_PATH: faultStatePath,
        IPPON_REGTEST_FAULT_MODE: mode,
        IPPON_REGTEST_ALLOWED_ORIGINS: process.env.IPPON_REGTEST_ALLOWED_ORIGINS,
        IPPON_REGTEST_FAULT_ORIGIN: process.env.IPPON_REGTEST_FAULT_ORIGIN,
        NODE_OPTIONS: existingNodeOptions ? `${existingNodeOptions} ${importHook}` : importHook,
    }
}

async function runCli(command, context, mode = 'observe') {
    const result = await runProcess(process.execPath, [appPath], {
        env: cliEnvironment(context.databasePath, context.faultStatePath, mode),
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
        server.once('error', reject)
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

async function setupDatabase(databasePath) {
    const result = await runProcess(process.execPath, [
        prismaCliPath,
        'db',
        'push',
        '--schema',
        schemaPath,
        '--skip-generate',
    ], {
        env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
        label: 'database_setup',
    })
    requireCondition(result.code === 0, 'database_setup_failed')
}

async function fundDisposableWallet(context) {
    const created = await runCliSuccess(
        `wallet create fault-source ${process.env.IPPON_REGTEST_FAULT_ORIGIN}`,
        { ...context, label: 'source_wallet_create' },
    )
    requireCondition(typeof created.access_key === 'string', 'source_wallet_key_missing')

    const deposit = await runCliSuccess(
        `wallet ${created.access_key} deposit ${FUNDING_FAKE_SATS}`,
        { ...context, label: 'source_deposit_quote' },
    )
    requireCondition(typeof deposit.quote === 'string', 'source_deposit_quote_missing')
    requireCondition(typeof deposit.request === 'string', 'source_deposit_invoice_missing')

    for (let attempt = 0; attempt < 10; attempt += 1) {
        await runCliSuccess(
            `wallet ${created.access_key} deposit-check ${deposit.quote}`,
            { ...context, label: 'source_deposit_check' },
        )
        const balance = await runCliSuccess(
            `wallet ${created.access_key} balance`,
            { ...context, label: 'source_balance_check' },
        )
        if (balance.balance === FUNDING_FAKE_SATS) return created.access_key
        await delay(500)
    }
    throw new SafeFailure('source_fake_funding_not_minted')
}

async function createPaymentInvoice(context, destinationOrigin) {
    const destination = await runCliSuccess(
        `wallet create fault-destination ${destinationOrigin}`,
        { ...context, label: 'destination_wallet_create' },
    )
    requireCondition(typeof destination.access_key === 'string', 'destination_wallet_key_missing')
    const deposit = await runCliSuccess(
        `wallet ${destination.access_key} deposit ${PAYMENT_FAKE_SATS}`,
        { ...context, label: 'destination_invoice_create' },
    )
    requireCondition(typeof deposit.request === 'string', 'destination_invoice_missing')
    requireCondition(deposit.request.toLowerCase().startsWith('lnbc'), 'destination_invoice_not_mainnet_bolt11')
    return deposit.request
}

function changedHash(hash) {
    return `${hash[0] === '0' ? '1' : '0'}${hash.slice(1)}`
}

async function readFaultState(faultStatePath) {
    return JSON.parse(await readFile(faultStatePath, 'utf8'))
}

async function main() {
    requireCondition(
        process.env.IPPON_REGTEST_FAULT_ACK === ACKNOWLEDGEMENT,
        'explicit_local_regtest_ack_required',
    )
    requireCondition(FUNDING_FAKE_SATS <= 255, 'fake_funding_limit_exceeded')
    requireCondition(PAYMENT_FAKE_SATS <= 16, 'fake_payment_limit_exceeded')
    await access(appPath)
    await access(hookPath)
    await access(pythonHookPath)
    const nutshellPath = process.env.IPPON_NUTSHELL_PATH
    requireCondition(Boolean(nutshellPath) && path.isAbsolute(nutshellPath), 'official_nutshell_path_required')
    await access(path.join(nutshellPath, 'pyproject.toml'))
    await access(path.join(nutshellPath, 'cashu', 'lightning', 'fake.py'))

    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'ippon-regtest-fault-'))
    const databasePath = path.join(temporaryDirectory, 'ippon.sqlite')
    const faultStatePath = path.join(temporaryDirectory, 'fault-state.json')
    const context = { databasePath, faultStatePath }
    let prisma
    const localMints = []
    let summary

    try {
        await writeFile(faultStatePath, `${JSON.stringify({
            version: 1,
            network_requests: 0,
            melt_posts: 0,
            melt_quote_checks: 0,
            proof_state_checks: 0,
            other_requests: 0,
            melt_response_dropped: false,
            first_reconcile_blocked: false,
            melt_http_status: null,
            melt_error_code: null,
        })}\n`, { mode: 0o600 })
        // Prisma's schema engine checks SQLite connectivity before `db push`;
        // create the private empty file first so that check remains local and
        // deterministic on every supported host.
        await writeFile(databasePath, '', { mode: 0o600 })
        await setupDatabase(databasePath)
        const sourcePreimage = crypto.randomBytes(32).toString('hex')
        const destinationPreimage = crypto.randomBytes(32).toString('hex')
        const destinationMint = await startLocalNutshell(
            nutshellPath,
            temporaryDirectory,
            'destination',
            destinationPreimage,
        )
        localMints.push(destinationMint)
        const sourceMint = await startLocalNutshell(
            nutshellPath,
            temporaryDirectory,
            'source',
            sourcePreimage,
            [destinationPreimage],
        )
        localMints.push(sourceMint)
        process.env.IPPON_REGTEST_ALLOWED_ORIGINS = `${sourceMint.origin},${destinationMint.origin}`
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
        for (const field of ['invoice_sha256', 'quote_sha256', 'proof_plan_sha256', 'payment_hash']) {
            requireCondition(/^[0-9a-f]{64}$/.test(prepared[field]), `prepared_${field}_invalid`)
        }

        const tampered = await runCli(
            `wallet ${sourceAccessKey} pay-execute ${intentId} ${changedHash(prepared.invoice_sha256)} ${prepared.quote_sha256} ${prepared.proof_plan_sha256}`,
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
            `wallet ${sourceAccessKey} pay-execute ${intentId} ${prepared.invoice_sha256} ${prepared.quote_sha256} ${prepared.proof_plan_sha256}`,
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

        process.env.DATABASE_URL = `file:${databasePath}`
        const { PrismaClient } = await import('@prisma/client')
        prisma = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } })
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
        const integrityRows = await prisma.$queryRawUnsafe('PRAGMA integrity_check')
        requireCondition(
            Array.isArray(integrityRows)
            && integrityRows.length === 1
            && Object.values(integrityRows[0])[0] === 'ok',
            'database_integrity_check_failed',
        )

        faultState = await readFaultState(faultStatePath)
        requireCondition(faultState.melt_posts === 1, 'melt_was_retried_after_restart')
        summary = {
            ok: true,
            environment: 'official-nutshell-local-fakewallet-regtest',
            fake_sats: {
                funded: FUNDING_FAKE_SATS,
                payment: PAYMENT_FAKE_SATS,
            },
            fault_injection: {
                accepted_melt_response_dropped: true,
                first_reconciliation_blocked: true,
                immediate_state: 'UNKNOWN',
                melt_posts: faultState.melt_posts,
            },
            restart_recovery: {
                method: 'pay-status-only',
                terminal_state: 'PAID',
                execution_count: operation.executionCount,
                remote_spent_proofs: paid.proof_states.length,
                local_pending_proofs: pendingProofs,
                local_reserved_proofs: reservedProofs,
                preimage_verified: true,
                sqlite_integrity: 'ok',
            },
            approval_tamper_rejected_before_melt: true,
            secrets_emitted: false,
        }
    } finally {
        if (prisma) await prisma.$disconnect()
        for (const mint of localMints) await stopProcess(mint.child)
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
