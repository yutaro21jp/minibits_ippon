import 'dotenv/config'
import readline from 'readline'
import crypto from 'crypto'
import {
    MintQuoteState,
    getTokenMetadata,
    getEncodedToken,
    decodePaymentRequest,
} from '@cashu/cashu-ts'
import { decode as bolt11Decode } from '@gandlaf21/bolt11-decode'
import prisma from './utils/prismaClient'
import { WalletService } from './services/walletService'
import { SplitMeltError, SplitMeltService } from './services/splitMeltService'
import { NostrService } from './services/nostrService'
import { log } from './services/logService'

// ── Key helpers ───────────────────────────────────────────────────────────────

const KEY_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

function generateShortKey(): string {
    const bytes = crypto.randomBytes(6)
    return Array.from(bytes, b => KEY_CHARS[b % KEY_CHARS.length]).join('')
}

// Display short (6-char) keys as xxx-xxx; leave full hex keys as-is.
function formatKey(key: string): string {
    return key.length === 6 ? `${key.slice(0, 3)}-${key.slice(3)}` : key
}

// Accept keys with or without the visual dash.
function normalizeKey(input: string): string {
    return input.replace(/-/g, '').toLowerCase()
}

// ── Output helpers ────────────────────────────────────────────────────────────

// All structured responses are JSON lines on stdout so callers can parse them.
function out(obj: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify(obj) + '\n')
}

function cliError(message: string, code = 'ERROR'): void {
    process.stdout.write(JSON.stringify({ error: true, code, message }) + '\n')
}

// ── Command handler ───────────────────────────────────────────────────────────

async function handleCommand(parts: string[]): Promise<void> {
    const cmd = parts[0]?.toLowerCase()

    // help ────────────────────────────────────────────────────────────────────
    if (!cmd || cmd === 'help') {
        out({
            commands: [
                'info',
                'restore-audit <mint_url>',
                'wallet create [name] [mint_url]',
                'wallet list',
                'wallet <key> balance',
                'wallet <key> deposit <amount>',
                'wallet <key> deposit-check <quote_id>',
                'wallet <key> send <amount> [lock_pubkey]',
                'wallet <key> receive <token>',
                'wallet <key> pay-prepare <intent_id> <bolt11>',
                'wallet <key> pay-execute <intent_id> <invoice_sha256> <quote_sha256> <proof_plan_sha256>',
                'wallet <key> pay-status <intent_id>',
                'wallet <key> sync',
                'decode <cashu_token_or_bolt11_or_cashu_request>',
                'help',
                'exit',
            ],
        })
        return
    }

    // info ────────────────────────────────────────────────────────────────────
    if (cmd === 'info') {
        out({
            unit:  process.env.UNIT || 'sat',
            mints: WalletService.getMintUrls(),
            limits: {
                max_balance: parseInt(process.env.MAX_BALANCE || '100000'),
                max_send:    parseInt(process.env.MAX_SEND    || '50000'),
                max_pay:     parseInt(process.env.MAX_PAY     || '50000'),
            },
            payment_adapter: {
                protocol_version: 3,
                cashu_ts_version: '4.7.2',
                split_melt: true,
                persistent_operations: true,
                proof_state_reconciliation: true,
                preimage_verification: true,
                full_proof_restore_audit: true,
            },
        })
        return
    }

    // decode ──────────────────────────────────────────────────────────────────
    if (cmd === 'decode') {
        const data = parts[1]
        if (!data) { cliError('Usage: decode <data>'); return }
        try {
            if (data.startsWith('cashu')) {
                const metadata = getTokenMetadata(data)
                out({
                    type: 'CASHU_TOKEN',
                    decoded: {
                        mint: metadata.mint,
                        unit: metadata.unit,
                        amount: metadata.amount.toNumber(),
                        incomplete_proofs: metadata.incompleteProofs,
                    },
                })
            } else if (data.startsWith('creq')) {
                out({ type: 'CASHU_REQUEST', decoded: decodePaymentRequest(data) })
            } else {
                out({ type: 'BOLT11', decoded: bolt11Decode(data) })
            }
        } catch (e: any) {
            cliError(e.message, 'DECODE_ERROR')
        }
        return
    }

    // Recovery-only command: private filesystem access to the restored SQLite
    // database is the authority. The public, allowlisted mint URL selects one
    // restored wallet without copying its access-key secret to the recovery
    // device. No access key or proof material is emitted.
    if (cmd === 'restore-audit') {
        try {
            if (parts.length !== 2) {
                cliError('Restore audit requires one allowlisted mint URL', 'RESTORE_AUDIT_ERROR')
                return
            }
            const mintUrl = parts[1]
            if (!WalletService.getMintUrls().includes(mintUrl)) {
                cliError('Restored wallet mint is not allowlisted', 'RESTORE_AUDIT_ERROR')
                return
            }
            const wallets = await prisma.wallet.findMany({
                where: { mint: mintUrl },
                orderBy: { id: 'asc' },
            })
            if (wallets.length !== 1) {
                cliError(
                    'Restore audit requires exactly one wallet for the mint',
                    'RESTORE_AUDIT_ERROR',
                )
                return
            }
            const wallet = wallets[0]
            const result = await WalletService.auditRestoredProofs(wallet.id, wallet.mint)
            out(result as unknown as Record<string, unknown>)
        } catch (e: any) { cliError(e.message, 'RESTORE_AUDIT_ERROR') }
        return
    }

    // wallet ──────────────────────────────────────────────────────────────────
    if (cmd === 'wallet') {
        const sub = parts[1]

        // wallet create [name] [mint_url]
        // mint_url is detected by http/https prefix; it can appear as parts[2] or parts[3]
        if (sub === 'create') {
            try {
                const unit = process.env.UNIT || 'sat'
                const mintUrls = WalletService.getMintUrls()
                if (mintUrls.length === 0) { cliError('No MINT_URLS configured'); return }

                let name: string | null = null
                let mint = mintUrls[0]

                if (parts[2]?.startsWith('http')) {
                    // wallet create <mint_url>
                    mint = parts[2]
                } else if (parts[2]) {
                    // wallet create <name> [mint_url]
                    name = parts[2]
                    if (parts[3]?.startsWith('http')) mint = parts[3]
                }

                if (!mintUrls.includes(mint)) {
                    cliError(`Mint '${mint}' is not in the configured MINT_URLS`, 'VALIDATION_ERROR')
                    return
                }

                const accessKey = generateShortKey()
                const wallet = await prisma.wallet.create({
                    data: { accessKey, name, mint, unit },
                })
                out({
                    access_key:      formatKey(wallet.accessKey),
                    name:            wallet.name || '',
                    mint:            wallet.mint,
                    unit:            wallet.unit,
                    balance:         0,
                    pending_balance: 0,
                })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // wallet list
        if (sub === 'list') {
            try {
                const wallets = await prisma.wallet.findMany({ orderBy: { id: 'asc' } })
                const rows = await Promise.all(wallets.map(async w => {
                    const { balance, pendingBalance } = await WalletService.getWalletBalance(w.id)
                    return {
                        access_key:      formatKey(w.accessKey),
                        name:            w.name || '',
                        mint:            w.mint,
                        unit:            w.unit,
                        balance: balance.toNumber(),
                        pending_balance: pendingBalance.toNumber(),
                    }
                }))
                out({ wallets: rows })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // wallet <access_key> <operation> [args...]
        const rawKey = sub
        const op = parts[2]?.toLowerCase()

        if (!rawKey || !op) {
            cliError('Usage: wallet <access_key> <operation>  |  wallet create [name]  |  wallet list')
            return
        }

        const accessKey = normalizeKey(rawKey)
        const wallet = await prisma.wallet.findUnique({ where: { accessKey } })
        if (!wallet) { cliError('Wallet not found', 'NOT_FOUND'); return }

        // balance
        if (op === 'balance') {
            try {
                try {
                    await WalletService.syncProofsStateWithMint(wallet.id, wallet.mint)
                } catch (e: any) {
                    log.warn('[CLI balance] pending proof sync failed', { error: e.message })
                }
                const { balance, pendingBalance } = await WalletService.getWalletBalance(wallet.id)
                out({
                    access_key:      formatKey(wallet.accessKey),
                    name:            wallet.name || '',
                    mint:            wallet.mint,
                    unit:            wallet.unit,
                    balance: balance.toNumber(),
                    pending_balance: pendingBalance.toNumber(),
                })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // deposit <amount>
        if (op === 'deposit') {
            const amount = parseInt(parts[3])
            if (!amount || amount <= 0) { cliError('Usage: wallet <key> deposit <amount>'); return }
            try {
                const quote = await WalletService.createMintQuote(amount, wallet.mint)
                out({ quote: quote.quote, request: quote.request, state: quote.state, expiry: quote.expiry })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // deposit-check <quote_id>
        if (op === 'deposit-check') {
            const quoteId = parts[3]
            if (!quoteId) { cliError('Usage: wallet <key> deposit-check <quote_id>'); return }
            try {
                const quote = await WalletService.checkMintQuote(quoteId, wallet.mint)
                if (quote.state === MintQuoteState.PAID) {
                    try {
                        const proofs = await WalletService.mintProofs(quote.amount, quote.quote, wallet.mint)
                        await WalletService.saveProofs(wallet.id, proofs)
                    } catch (e: any) {
                        log.warn('[CLI deposit-check] mint proofs failed', { error: e.message })
                    }
                }
                out({ quote: quote.quote, request: quote.request, state: quote.state, expiry: quote.expiry })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // send <amount> [lock_pubkey]
        if (op === 'send') {
            const amount = parseInt(parts[3])
            if (!amount || amount <= 0) { cliError('Usage: wallet <key> send <amount> [lock_pubkey]'); return }
            try {
                let p2pkPubkey: string | undefined
                if (parts[4]) p2pkPubkey = NostrService.normalizePubkey(parts[4])
                const { send } = await WalletService.sendProofs(wallet.id, amount, wallet.mint, p2pkPubkey)
                const token = getEncodedToken({ mint: wallet.mint, proofs: send, unit: wallet.unit })
                out({ token, amount: WalletService.getProofsAmount(send).toNumber(), unit: wallet.unit })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // receive <token>
        if (op === 'receive') {
            const tokenStr = parts[3]
            if (!tokenStr) { cliError('Usage: wallet <key> receive <token>'); return }
            try {
                const newProofs = await WalletService.receiveToken(wallet.id, tokenStr, wallet.mint)
                const amount = WalletService.getProofsAmount(newProofs)
                const { balance, pendingBalance } = await WalletService.getWalletBalance(wallet.id)
                out({
                    amount: amount.toNumber(),
                    unit: wallet.unit,
                    balance: balance.toNumber(),
                    pending_balance: pendingBalance.toNumber(),
                })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // The old one-shot pay path is unsafe because it creates a quote and
        // spends proofs before an external approval can bind the exact plan.
        if (op === 'pay') {
            cliError(
                'One-shot pay is disabled; use pay-prepare, obtain approval, then use pay-execute',
                'UNSAFE_OPERATION',
            )
            return
        }

        // Raw quote IDs never cross the private Ippon CLI boundary.
        if (op === 'pay-check') {
            cliError('Raw quote lookup is disabled; use pay-status with an intent ID', 'UNSAFE_OPERATION')
            return
        }

        // pay-prepare <intent_id> <bolt11>
        if (op === 'pay-prepare') {
            const intentId = parts[3]
            const invoice = parts[4]
            if (!intentId || !invoice) {
                cliError('Usage: wallet <key> pay-prepare <intent_id> <bolt11>', 'VALIDATION_ERROR')
                return
            }
            try {
                out(await SplitMeltService.prepare(wallet, intentId, invoice))
            } catch (e: any) {
                cliError(e.message, e instanceof SplitMeltError ? e.code : 'PAYMENT_PREPARE_ERROR')
            }
            return
        }

        // pay-execute <intent_id> <invoice_sha256> <quote_sha256> <proof_plan_sha256>
        if (op === 'pay-execute') {
            const [intentId, invoiceSha256, quoteSha256, proofPlanSha256] = parts.slice(3, 7)
            if (!intentId || !invoiceSha256 || !quoteSha256 || !proofPlanSha256) {
                cliError(
                    'Usage: wallet <key> pay-execute <intent_id> <invoice_sha256> <quote_sha256> <proof_plan_sha256>',
                    'VALIDATION_ERROR',
                )
                return
            }
            try {
                out(await SplitMeltService.execute(wallet, intentId, {
                    invoiceSha256,
                    quoteSha256,
                    proofPlanSha256,
                }))
            } catch (e: any) {
                cliError(e.message, e instanceof SplitMeltError ? e.code : 'PAYMENT_EXECUTE_ERROR')
            }
            return
        }

        // pay-status <intent_id>
        if (op === 'pay-status') {
            const intentId = parts[3]
            if (!intentId) {
                cliError('Usage: wallet <key> pay-status <intent_id>', 'VALIDATION_ERROR')
                return
            }
            try {
                out(await SplitMeltService.status(wallet, intentId))
            } catch (e: any) {
                cliError(e.message, e instanceof SplitMeltError ? e.code : 'PAYMENT_STATUS_ERROR')
            }
            return
        }

        // sync
        if (op === 'sync') {
            try {
                const result = await WalletService.syncProofsStateWithMint(wallet.id, wallet.mint)
                out(result as unknown as Record<string, unknown>)
            } catch (e: any) { cliError(e.message) }
            return
        }

        cliError(`Unknown wallet operation: ${op}. Type 'help' for available commands.`)
        return
    }

    cliError(`Unknown command: ${cmd}. Type 'help' for available commands.`)
}

// ── REPL entry point ──────────────────────────────────────────────────────────

// Returns a Promise that resolves only after readline is fully closed and any
// in-flight command has finished — safe for both interactive and piped use.
export function startCli(): Promise<void> {
    return new Promise<void>((resolve) => {
        const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
        const rl = readline.createInterface({
            input:  process.stdin,
            output: interactive ? process.stdout : undefined,
            terminal: interactive,
            prompt: '> ',
        })

        process.stderr.write('Minibits Ippon CLI — type "help" for commands, "exit" to quit\n')
        if (interactive) rl.prompt()

        // Track the in-flight async handler so the 'close' handler can await it.
        let currentOp: Promise<void> | null = null
        let closing = false

        rl.on('line', (line: string) => {
            const trimmed = line.trim()
            if (!trimmed) {
                if (interactive) rl.prompt()
                return
            }

            if (trimmed === 'exit' || trimmed === 'quit') {
                process.stderr.write('Bye!\n')
                closing = true
                rl.close()
                return
            }

            const parts = trimmed.split(/\s+/)
            currentOp = (async () => {
                try {
                    await handleCommand(parts)
                } catch (e: any) {
                    cliError(e.message)
                }
                if (!closing && interactive) rl.prompt()
            })()
        })

        rl.on('close', () => {
            closing = true
            // Await the in-flight operation (if any) before disconnecting.
            const cleanup = async () => {
                if (currentOp) await currentOp
                await prisma.$disconnect()
                resolve()
            }
            cleanup()
        })
    })
}
