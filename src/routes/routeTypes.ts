import { FastifyRequest } from 'fastify'
import { ProofState } from '@cashu/cashu-ts'
export { ProofState }

// ── Shared ───────────────────────────────────────────────────────────────────

export interface WalletLimits {
    max_balance: number | null
    max_send:    number | null
    max_pay:     number | null
}

// ── GET /v1/info ─────────────────────────────────────────────────────────────

export interface InfoLimits {
    max_balance:                  number
    max_send:                     number
    max_pay:                      number
    rate_limit_max:               number
    rate_limit_create_wallet_max: number
    rate_limit_window:            string
}

export interface InfoResponse {
    status: string
    help:   string
    terms:  string
    unit:   string
    mints:  string[]
    limits: InfoLimits
    features: {
        signed_cli_approval: boolean
        legacy_api_mutations: boolean
        lightning_address_resolution: boolean
    }
}

// ── POST /v1/wallet (create) · GET /v1/wallet ────────────────────────────────

export type WalletCreateRequest = FastifyRequest<{
    Body: {
        name?:     string
        token?:    string
        mint_url?: string
        limits?: {
            max_balance?: number
            max_send?:    number
            max_pay?:     number
        }
    }
}>

export interface WalletResponse {
    name:            string
    access_key:      string
    mint:            string
    unit:            string
    balance:         number
    pending_balance: number
    limits:          WalletLimits | null
}

// ── POST /v1/wallet/deposit ──────────────────────────────────────────────────

export type WalletDepositRequest = FastifyRequest<{
    Body: {
        amount: number
        unit:   string
    }
}>

export interface WalletDepositResponse {
    quote:   string
    request: string
    state:   string
    expiry:  number | null
}

// ── GET /v1/wallet/deposit/:quote ────────────────────────────────────────────

export type DepositCheckRequest = FastifyRequest<{
    Params: { quote: string }
}>

// ── POST /v1/wallet/send ─────────────────────────────────────────────────────

export type WalletSendRequest = FastifyRequest<{
    Body: {
        amount:          number
        unit:            string
        cashu_request?:  string
        memo?:           string
        lock_to_pubkey?: string
    }
}>

export interface WalletSendResponse {
    token:  string
    amount: number
    unit:   string
    memo:   string | undefined
}

// ── POST /v1/wallet/check ────────────────────────────────────────────────────

export type WalletCheckRequest = FastifyRequest<{
    Body: { token: string }
}>

export interface WalletCheckResponse {
    amount:            number
    unit:              string
    memo:              string | undefined
    state:             string
    mint_proof_states: ProofState[]
}

// ── POST /v1/wallet/decode ───────────────────────────────────────────────────

export type WalletDecodeRequest = FastifyRequest<{
    Body: {
        type: string
        data: string
    }
}>

export interface WalletDecodeResponse {
    type:    string
    decoded: Record<string, unknown>
}

// ── POST /v1/wallet/pay ──────────────────────────────────────────────────────

export type WalletPayRequest = FastifyRequest<{
    Body: {
        lightning_address?: string
        bolt11_request?:    string
        amount:             number
        unit:               string
    }
}>

export interface WalletPayResponse {
    quote:            string
    amount:           number
    fee_reserve:      number
    state:            string
    payment_preimage: string | null
    expiry:           number
}

// ── GET /v1/wallet/pay/:quote ────────────────────────────────────────────────

export type PayCheckRequest = FastifyRequest<{
    Params: { quote: string }
}>

// ── POST /v1/wallet/receive ──────────────────────────────────────────────────

export type WalletReceiveRequest = FastifyRequest<{
    Body: { token: string }
}>

export interface WalletReceiveResponse {
    amount:          number
    unit:            string
    balance:         number
    pending_balance: number
}

// ── GET /v1/rate/:currency ───────────────────────────────────────────────────

export type RateRequest = FastifyRequest<{
    Params: { currency: string }
}>

export interface RateResponse {
    currency:  string
    rate:      number
    timestamp: number
}
