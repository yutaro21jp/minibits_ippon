import { readFileSync, renameSync, writeFileSync } from 'node:fs'

const ACKNOWLEDGEMENT = 'local-regtest-fake-ecash-only'
const allowedOriginList = process.env.IPPON_REGTEST_ALLOWED_ORIGINS
const faultOrigin = process.env.IPPON_REGTEST_FAULT_ORIGIN
const statePath = process.env.IPPON_REGTEST_FAULT_STATE_PATH
const mode = process.env.IPPON_REGTEST_FAULT_MODE || 'observe'

if (process.env.IPPON_REGTEST_FAULT_ACK !== ACKNOWLEDGEMENT) {
    throw new Error('The local regtest fake-ecash acknowledgement is required')
}
if (!statePath) {
    throw new Error('The regtest fault state path is required')
}
if (!allowedOriginList || !faultOrigin) {
    throw new Error('The local regtest origins are required')
}
const allowedOrigins = new Set(allowedOriginList.split(',').filter(Boolean))
if (allowedOrigins.size !== 2 || !allowedOrigins.has(faultOrigin)) {
    throw new Error('The source and destination regtest origins are invalid')
}
for (const origin of allowedOrigins) {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
        throw new Error('Every regtest origin must be an explicit loopback HTTP origin')
    }
}
if (!['observe', 'drop-melt-and-block-reconcile'].includes(mode)) {
    throw new Error('The requested regtest fault mode is invalid')
}

const originalFetch = globalThis.fetch.bind(globalThis)

function readState() {
    return JSON.parse(readFileSync(statePath, 'utf8'))
}

function writeState(state) {
    const temporaryPath = `${statePath}.${process.pid}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    renameSync(temporaryPath, statePath)
}

function requestUrl(input) {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    return new URL(input.url)
}

function requestMethod(input, init) {
    return (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase()
}

globalThis.fetch = async function guardedRegtestFetch(input, init) {
    const url = requestUrl(input)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
        if (!allowedOrigins.has(url.origin)) {
            throw new TypeError('Regtest harness blocked a non-allowlisted network origin')
        }
    }

    const method = requestMethod(input, init)
    const state = readState()
    state.network_requests += 1

    if (method === 'POST' && url.origin === faultOrigin && url.pathname === '/v1/melt/bolt11') {
        state.melt_posts += 1
        writeState(state)

        const response = await originalFetch(input, init)
        const latest = readState()
        latest.melt_http_status = response.status
        if (!response.ok) {
            try {
                const errorBody = await response.clone().json()
                if (Number.isSafeInteger(errorBody?.code)) latest.melt_error_code = errorBody.code
            } catch {
                // Only the numeric Cashu error code is retained when available.
            }
            writeState(latest)
        }
        if (
            mode === 'drop-melt-and-block-reconcile'
            && !latest.melt_response_dropped
            && response.ok
        ) {
            latest.melt_response_dropped = true
            writeState(latest)
            throw new TypeError('Injected loss of an accepted melt response')
        }
        return response
    }

    if (
        method === 'GET'
        && url.origin === faultOrigin
        && url.pathname.startsWith('/v1/melt/quote/bolt11/')
    ) {
        state.melt_quote_checks += 1
        if (
            mode === 'drop-melt-and-block-reconcile'
            && state.melt_response_dropped
            && !state.first_reconcile_blocked
        ) {
            state.first_reconcile_blocked = true
            writeState(state)
            throw new TypeError('Injected loss of the first quote reconciliation')
        }
        writeState(state)
        return originalFetch(input, init)
    }

    if (method === 'POST' && url.pathname === '/v1/checkstate') {
        state.proof_state_checks += 1
    } else {
        state.other_requests += 1
    }
    writeState(state)
    return originalFetch(input, init)
}
