import {
    Amount,
    AmountLike,
    Wallet,
    MintQuoteBolt11Response,
    MeltQuoteBolt11Response,
    Proof,
    ProofLike,
    Token,
    ProofState,
    MeltQuoteState,
    CheckStateEnum,
    MintOperationError,
    OutputConfig,
    getDecodedToken,
    getTokenMetadata,
    setGlobalRequestOptions,
    sumProofs,
} from '@cashu/cashu-ts'
import { MeltOperationState, MintOperationState, ProofStatus } from '@prisma/client'
import prisma from '../utils/prismaClient'
import AppError, { Err } from '../utils/AppError'
import { log } from './logService'

type CachedWallet = {
    wallet: Wallet
    keysetsLoadedAt: number
}

const _wallets = new Map<string, CachedWallet>()
const MAX_RESTORE_AUDIT_PROOFS = 10_000
const configuredKeysetTtlMs = Number(process.env.KEYSET_TTL_MS || 10 * 60 * 1000)
const KEYSET_TTL_MS = Number.isFinite(configuredKeysetTtlMs) && configuredKeysetTtlMs >= 0
    ? configuredKeysetTtlMs
    : 10 * 60 * 1000

// cashu-ts enables implicit NUT-19 retries for endpoints advertised as cached.
// That is useful for ordinary clients, but an approval-gated melt must have one
// transport attempt: an ambiguous result is reconciled by pay-status instead of
// silently resubmitting POST /v1/melt/bolt11 inside the library.
setGlobalRequestOptions({ ttl: 0, cached_endpoints: [] })

const getMintUrls = function (): string[] {
    const raw = process.env.MINT_URLS || ''
    return raw.split(',').map(u => u.trim()).filter(u => u.length > 0)
}

/** Return whether the wallet can still create outputs with its bound keyset. */
const isBoundKeysetUsable = function (wallet: Wallet): boolean {
    try {
        const keyset = wallet.getKeyset()
        const expiry = keyset.expiry
        return keyset.isActive && (expiry === undefined || expiry * 1000 > Date.now())
    } catch {
        return false
    }
}


/** Refresh the mint keychain and rebind after a NUT-02 keyset rotation. */
const refreshKeysets = async function (cached: CachedWallet, mintUrl: string): Promise<void> {
    await cached.wallet.loadMint(true)
    cached.keysetsLoadedAt = Date.now()

    if (!isBoundKeysetUsable(cached.wallet)) {
        const cheapest = cached.wallet.keyChain.getCheapestKeyset()
        cached.wallet.bindKeyset(cheapest.id)
        log.info('[refreshKeysets] Rebound wallet to a new keyset', { mintUrl, keysetId: cheapest.id })
    }
}


const getWallet = async function (mintUrl: string): Promise<Wallet> {
    const cached = _wallets.get(mintUrl)
    if (cached) {
        const isStale = Date.now() - cached.keysetsLoadedAt > KEYSET_TTL_MS

        if (isStale || !isBoundKeysetUsable(cached.wallet)) {
            try {
                await refreshKeysets(cached, mintUrl)
            } catch (e: any) {
                // A refresh failure is tolerable only while the old binding remains usable.
                log.warn('[getWallet] Keyset refresh failed, keeping cached keysets', { mintUrl, error: e.message })
                if (!isBoundKeysetUsable(cached.wallet)) {
                    throw new AppError(500, Err.CONNECTION_ERROR, `Mint has no usable keyset: ${e.message}`, { caller: 'getWallet' })
                }
            }
        }

        return cached.wallet
    }

    const unit = process.env.UNIT || 'sat'

    log.debug('[getWallet] Creating new cashu-ts wallet instance', { mintUrl, unit })

    const cashuWallet = new Wallet(mintUrl, { unit })
    await cashuWallet.loadMint()
    _wallets.set(mintUrl, { wallet: cashuWallet, keysetsLoadedAt: Date.now() })

    return cashuWallet
}


const getProofsAmount = function (proofs: Array<Pick<ProofLike, 'amount'>>): Amount {
    return sumProofs(proofs)
}

const getTokenAmount = function (tokenStr: string): Amount {
    return getTokenMetadata(tokenStr).amount
}


/** Decode cashuB tokens while resolving NUT-02 v2 short keyset IDs. */
const decodeToken = async function (tokenStr: string): Promise<Token> {
    const { mint } = getTokenMetadata(tokenStr)

    let cached: CachedWallet | undefined
    let keysetIds: string[] = []

    try {
        await getWallet(mint)
        cached = _wallets.get(mint)
        keysetIds = cached?.wallet.keyChain.getAllKeysetIds() ?? []
    } catch (e: any) {
        log.warn('[decodeToken] Could not load mint keysets, decoding without them', { mint, error: e.message })
    }

    try {
        return getDecodedToken(tokenStr, keysetIds)
    } catch (e: any) {
        // A short v2 id may refer to a keyset added after the last refresh.
        if (!cached) throw e

        log.debug('[decodeToken] Decode failed, refreshing keysets and retrying', { mint, error: e.message })
        await refreshKeysets(cached, mint)
        return getDecodedToken(tokenStr, cached.wallet.keyChain.getAllKeysetIds())
    }
}


/** Ensure every input proof references a keyset currently known by cashu-ts. */
const ensureKeysetsKnown = async function (
    mintUrl: string,
    proofs: Array<Pick<ProofLike, 'id'>>,
): Promise<void> {
    const cached = _wallets.get(mintUrl)
    if (!cached) return

    const missing = () => {
        const known = new Set(cached.wallet.keyChain.getAllKeysetIds())
        return [...new Set(proofs.map(proof => proof.id).filter(id => !known.has(id)))]
    }

    const unknownIds = missing()
    if (unknownIds.length === 0) return

    log.info('[ensureKeysetsKnown] Token references unknown keysets, refreshing from mint', {
        mintUrl,
        keysetIds: unknownIds,
    })

    try {
        await refreshKeysets(cached, mintUrl)
    } catch (e: any) {
        throw new AppError(500, Err.CONNECTION_ERROR, `Could not refresh keysets from mint: ${e.message}`, { caller: 'ensureKeysetsKnown' })
    }

    const stillUnknown = missing()
    if (stillUnknown.length > 0) {
        throw new AppError(
            400,
            Err.VALIDATION_ERROR,
            `Token references keysets that mint ${mintUrl} does not know: ${stillUnknown.join(', ')}`,
            { caller: 'ensureKeysetsKnown' },
        )
    }
}


const getWalletBalance = async function (walletId: number): Promise<{ balance: Amount, pendingBalance: Amount }> {
    const unspentResult = await prisma.proof.aggregate({
        where: { walletId, status: ProofStatus.UNSPENT },
        _sum: { amount: true },
    })

    const pendingResult = await prisma.proof.aggregate({
        where: { walletId, status: ProofStatus.PENDING },
        _sum: { amount: true },
    })

    return {
        balance: Amount.from(unspentResult._sum.amount || 0),
        pendingBalance: Amount.from(pendingResult._sum.amount || 0),
    }
}


const proofStorageData = function (walletId: number, proof: Proof, status: ProofStatus) {
    return {
        walletId,
        proofId: proof.id,
        amount: proof.amount.toNumber(),
        secret: proof.secret,
        C: proof.C,
        dleq: proof.dleq ? JSON.stringify(proof.dleq) : null,
        witness: proof.witness
            ? (typeof proof.witness === 'string' ? proof.witness : JSON.stringify(proof.witness))
            : null,
        p2pkE: proof.p2pk_e ?? null,
        status,
        reservedByIntentId: null,
    }
}


const saveProofs = async function (walletId: number, proofs: Proof[], status: ProofStatus = ProofStatus.UNSPENT) {
    for (const proof of proofs) {
        await prisma.proof.create({
            data: proofStorageData(walletId, proof, status),
        })
    }
}


const loadProofs = async function (walletId: number, status?: ProofStatus): Promise<Proof[]> {
    const where: any = { walletId, reservedByIntentId: null }
    if (status) {
        where.status = status
    } else {
        where.status = ProofStatus.UNSPENT
    }

    const dbProofs = await prisma.proof.findMany({ where })

    return dbProofs.map(p => ({
        id: p.proofId,
        amount: Amount.from(p.amount),
        secret: p.secret,
        C: p.C,
        dleq: p.dleq ? JSON.parse(p.dleq) : undefined,
        witness: p.witness
            ? (p.witness.startsWith('{') || p.witness.startsWith('[')
                ? JSON.parse(p.witness)
                : p.witness)
            : undefined,
        p2pk_e: p.p2pkE ?? undefined,
    }))
}


type RestoreAudit = {
    audit_version: number
    all_proofs_checked: boolean
    proofs_total: number
    local_unspent: number
    local_pending: number
    local_spent: number
    remote_unspent: number
    remote_pending: number
    remote_spent: number
    recoverable_balance: number
    state_mismatches: number
    reserved_proofs: number
    unresolved_operations: number
    funded_restore_ready: boolean
}


const auditRestoredProofs = async function (walletId: number, mintUrl: string): Promise<RestoreAudit> {
    const stored = await prisma.proof.findMany({
        where: { walletId },
        orderBy: { id: 'asc' },
    })
    if (stored.length > MAX_RESTORE_AUDIT_PROOFS) {
        throw new AppError(
            400,
            Err.VALIDATION_ERROR,
            'Restored wallet exceeds the reviewed proof-audit limit',
            { caller: 'auditRestoredProofs' },
        )
    }

    const proofs = stored.map(p => ({
        id: p.proofId,
        amount: Amount.from(p.amount),
        secret: p.secret,
        C: p.C,
        dleq: p.dleq ? JSON.parse(p.dleq) : undefined,
        witness: p.witness
            ? (p.witness.startsWith('{') || p.witness.startsWith('[')
                ? JSON.parse(p.witness)
                : p.witness)
            : undefined,
        p2pk_e: p.p2pkE ?? undefined,
    }))
    const wallet = await getWallet(mintUrl)
    const remoteStates = proofs.length > 0 ? await wallet.checkProofsStates(proofs) : []
    if (remoteStates.length !== stored.length) {
        throw new AppError(
            500,
            Err.CONNECTION_ERROR,
            'Mint returned an incomplete restored proof audit',
            { caller: 'auditRestoredProofs' },
        )
    }

    const localCounts = { UNSPENT: 0, PENDING: 0, SPENT: 0 }
    const remoteCounts = { UNSPENT: 0, PENDING: 0, SPENT: 0 }
    let recoverableBalance = Amount.zero()
    let stateMismatches = 0
    for (let index = 0; index < stored.length; index += 1) {
        const localState = stored[index].status
        const remoteState = remoteStates[index]?.state
        if (
            !Object.hasOwn(localCounts, localState)
            || typeof remoteState !== 'string'
            || !Object.hasOwn(remoteCounts, remoteState)
        ) {
            throw new AppError(
                500,
                Err.CONNECTION_ERROR,
                'Restored proof audit returned an unknown state',
                { caller: 'auditRestoredProofs' },
            )
        }
        const checkedRemoteState = remoteState as keyof typeof remoteCounts
        localCounts[localState] += 1
        remoteCounts[checkedRemoteState] += 1
        if (localState !== checkedRemoteState) stateMismatches += 1
        if (checkedRemoteState === CheckStateEnum.UNSPENT) {
            recoverableBalance = recoverableBalance.add(proofs[index].amount)
        }
    }

    const reservedProofs = stored.filter(proof => proof.reservedByIntentId !== null).length
    const unresolvedMeltOperations = await prisma.meltOperation.count({
        where: {
            walletId,
            state: {
                in: [
                    MeltOperationState.PREPARED,
                    MeltOperationState.EXECUTING,
                    MeltOperationState.PENDING,
                    MeltOperationState.UNKNOWN,
                ],
            },
        },
    })
    const unresolvedMintOperations = await prisma.mintOperation.count({
        where: {
            walletId,
            state: {
                in: [
                    MintOperationState.CREATING,
                    MintOperationState.PREPARED,
                    MintOperationState.PAID,
                    MintOperationState.EXECUTING,
                    MintOperationState.UNKNOWN,
                ],
            },
        },
    })
    const unresolvedOperations = unresolvedMeltOperations + unresolvedMintOperations
    const allProofsChecked = remoteStates.length === stored.length
    const fundedRestoreReady = allProofsChecked
        && stored.length > 0
        && recoverableBalance.greaterThan(Amount.zero())
        && remoteCounts.PENDING === 0
        && stateMismatches === 0
        && reservedProofs === 0
        && unresolvedOperations === 0

    return {
        audit_version: 1,
        all_proofs_checked: allProofsChecked,
        proofs_total: stored.length,
        local_unspent: localCounts.UNSPENT,
        local_pending: localCounts.PENDING,
        local_spent: localCounts.SPENT,
        remote_unspent: remoteCounts.UNSPENT,
        remote_pending: remoteCounts.PENDING,
        remote_spent: remoteCounts.SPENT,
        recoverable_balance: recoverableBalance.toNumber(),
        state_mismatches: stateMismatches,
        reserved_proofs: reservedProofs,
        unresolved_operations: unresolvedOperations,
        funded_restore_ready: fundedRestoreReady,
    }
}


const updateProofsStatus = async function (walletId: number, secrets: string[], status: ProofStatus) {
    await prisma.proof.updateMany({
        where: {
            walletId,
            secret: { in: secrets },
        },
        data: { status },
    })
}


const createMintQuote = async function (amount: AmountLike, mintUrl: string): Promise<MintQuoteBolt11Response> {
    try {
        const wallet = await getWallet(mintUrl)
        const quote = await wallet.createMintQuoteBolt11(amount)
        log.debug('[createMintQuote]', { amount: Amount.from(amount).toString() })
        return quote
    } catch (e: any) {
        throw new AppError(500, Err.CONNECTION_ERROR, e.message, { caller: 'createMintQuote' })
    }
}


const checkMintQuote = async function (quoteId: string, mintUrl: string): Promise<MintQuoteBolt11Response> {
    try {
        const wallet = await getWallet(mintUrl)
        return await wallet.checkMintQuoteBolt11(quoteId)
    } catch (e: any) {
        throw new AppError(500, Err.CONNECTION_ERROR, e.message, { caller: 'checkMintQuote' })
    }
}


const mintProofs = async function (amount: AmountLike, quoteId: string, mintUrl: string): Promise<Proof[]> {
    try {
        const wallet = await getWallet(mintUrl)
        return await wallet.mintProofsBolt11(amount, quoteId)
    } catch (e: any) {
        throw new AppError(500, Err.CONNECTION_ERROR, e.message, { caller: 'mintProofs' })
    }
}


const sendProofs = async function (walletId: number, amount: AmountLike, mintUrl: string, p2pkPubkey?: string): Promise<{ keep: Proof[], send: Proof[] }> {
    const wallet = await getWallet(mintUrl)
    const proofs = await loadProofs(walletId)
    const totalBalance = getProofsAmount(proofs)
    const sendAmount = Amount.from(amount)

    if (totalBalance.lessThan(sendAmount)) {
        throw new AppError(400, Err.VALIDATION_ERROR, `Insufficient balance: ${totalBalance.toString()} < ${sendAmount.toString()}`, { caller: 'sendProofs' })
    }

    const outputConfig: OutputConfig | undefined = p2pkPubkey
        ? { send: { type: 'p2pk', options: { pubkey: p2pkPubkey } } }
        : undefined

    // Sender pays all fees - we include fees that the receiver will need to pay when claiming the proofs,
    // to make sure he receives the full intended amount
    const { keep, send } = await wallet.send(sendAmount, proofs, { includeFees: true }, outputConfig)

    // Determine which input proofs were consumed by the swap vs returned as-is
    const returnedSecrets = new Set([
        ...keep.map(p => p.secret),
        ...send.map(p => p.secret),
    ])
    const swappedSecrets = proofs.map(p => p.secret).filter(s => !returnedSecrets.has(s))

    // Mark only the swapped input proofs as SPENT
    if (swappedSecrets.length > 0) {
        await updateProofsStatus(walletId, swappedSecrets, ProofStatus.SPENT)
    }

    // Save only genuinely new proofs (not ones already in DB from input)
    const inputSecrets = new Set(proofs.map(p => p.secret))
    const newKeep = keep.filter(p => !inputSecrets.has(p.secret))
    const newSend = send.filter(p => !inputSecrets.has(p.secret))

    if (newKeep.length > 0) {
        await saveProofs(walletId, newKeep, ProofStatus.UNSPENT)
    }
    if (newSend.length > 0) {
        await saveProofs(walletId, newSend, ProofStatus.PENDING)
    }

    // Mark input proofs returned in send as PENDING
    const inputSendSecrets = send.map(p => p.secret).filter(s => inputSecrets.has(s))
    if (inputSendSecrets.length > 0) {
        await updateProofsStatus(walletId, inputSendSecrets, ProofStatus.PENDING)
    }

    return { keep, send }
}


const SWAP_BATCH_SIZE = 100

const receiveToken = async function (walletId: number, tokenStr: string, mintUrl: string): Promise<Proof[]> {
    // Check the mint before fetching keysets from any token-supplied URL.
    const { mint: tokenMint } = getTokenMetadata(tokenStr)
    if (tokenMint !== mintUrl) {
        throw new AppError(400, Err.VALIDATION_ERROR, `Token mint '${tokenMint}' does not match wallet mint '${mintUrl}'`, { caller: 'receiveToken' })
    }
    const wallet = await getWallet(mintUrl)
    const decoded = await decodeToken(tokenStr)
    await ensureKeysetsKnown(mintUrl, decoded.proofs)

    if (decoded.proofs.length <= SWAP_BATCH_SIZE) {
        const newProofs = await wallet.receive(decoded)
        await saveProofs(walletId, newProofs, ProofStatus.UNSPENT)
        return newProofs
    }

    // Swap in batches to stay within the mint's per-swap proof limit
    const allNewProofs: Proof[] = []
    for (let i = 0; i < decoded.proofs.length; i += SWAP_BATCH_SIZE) {
        const batchToken: Token = {
            mint: decoded.mint,
            proofs: decoded.proofs.slice(i, i + SWAP_BATCH_SIZE),
            unit: decoded.unit,
        }
        const preview = await wallet.prepareSwapToReceive(batchToken)
        const { keep } = await wallet.completeSwap(preview)
        allNewProofs.push(...keep)
        // Persist each completed batch so a later failure cannot orphan swapped proofs.
        await saveProofs(walletId, keep, ProofStatus.UNSPENT)
    }

    return allNewProofs
}


const createMeltQuote = async function (bolt11: string, mintUrl: string): Promise<MeltQuoteBolt11Response> {
    try {
        const wallet = await getWallet(mintUrl)
        return await wallet.createMeltQuoteBolt11(bolt11)
    } catch (e: any) {
        throw new AppError(500, Err.CONNECTION_ERROR, e.message, { caller: 'createMeltQuote' })
    }
}


const checkMeltQuote = async function (quoteId: string, mintUrl: string): Promise<MeltQuoteBolt11Response> {
    try {
        const wallet = await getWallet(mintUrl)
        return await wallet.checkMeltQuoteBolt11(quoteId)
    } catch (e: any) {
        throw new AppError(500, Err.CONNECTION_ERROR, e.message, { caller: 'checkMeltQuote' })
    }
}


const meltProofs = async function (
    walletId: number,
    meltQuote: MeltQuoteBolt11Response,
    mintUrl: string,
): Promise<{ quote: MeltQuoteBolt11Response, change: Proof[] }> {
    const wallet = await getWallet(mintUrl)

    const amountNeeded = meltQuote.amount.add(meltQuote.fee_reserve)
    const proofs = await loadProofs(walletId)
    const totalBalance = getProofsAmount(proofs)

    if (totalBalance.lessThan(amountNeeded)) {
        throw new AppError(400, Err.VALIDATION_ERROR, `Insufficient balance for melt: ${totalBalance.toString()} < ${amountNeeded.toString()}`, { caller: 'meltProofs' })
    }

    // Select proofs for melt
    const { keep: proofsToKeep, send: proofsToSend } = await wallet.send(amountNeeded, proofs, { includeFees: false })

    // Determine which input proofs were consumed by the swap vs returned as-is
    const returnedSecrets = new Set([
        ...proofsToKeep.map(p => p.secret),
        ...proofsToSend.map(p => p.secret),
    ])
    const inputSecrets = new Set(proofs.map(p => p.secret))
    const swappedSecrets = proofs.map(p => p.secret).filter(s => !returnedSecrets.has(s))

    // Mark swapped input proofs as SPENT (consumed by the swap)
    if (swappedSecrets.length > 0) {
        await updateProofsStatus(walletId, swappedSecrets, ProofStatus.SPENT)
    }

    // Save genuinely new keep proofs as UNSPENT
    const newKeep = proofsToKeep.filter(p => !inputSecrets.has(p.secret))
    if (newKeep.length > 0) {
        await saveProofs(walletId, newKeep, ProofStatus.UNSPENT)
    }

    // Mark proofs reserved for melt as PENDING
    const sendSecrets = proofsToSend.map(p => p.secret)
    const existingSendSecrets = sendSecrets.filter(s => inputSecrets.has(s))
    const newSendProofs = proofsToSend.filter(p => !inputSecrets.has(p.secret))

    if (existingSendSecrets.length > 0) {
        await updateProofsStatus(walletId, existingSendSecrets, ProofStatus.PENDING)
    }
    if (newSendProofs.length > 0) {
        await saveProofs(walletId, newSendProofs, ProofStatus.PENDING)
    }

    // Attempt the melt
    try {
        const meltResponse = await wallet.meltProofsBolt11(meltQuote, proofsToSend)

        // PAID: mark melt proofs as SPENT, save change
        await updateProofsStatus(walletId, sendSecrets, ProofStatus.SPENT)

        if (meltResponse.change && meltResponse.change.length > 0) {
            await saveProofs(walletId, meltResponse.change, ProofStatus.UNSPENT)
        }

        return meltResponse
    } catch (e: any) {
        // Re-check the quote with the mint to determine proof fate
        try {
            const quoteCheck = await wallet.checkMeltQuoteBolt11(meltQuote.quote)

            if (quoteCheck.state === MeltQuoteState.PAID) {
                // Payment went through despite the error
                await updateProofsStatus(walletId, sendSecrets, ProofStatus.SPENT)
                return { quote: quoteCheck, change: [] }
            } else if (quoteCheck.state === MeltQuoteState.PENDING) {
                // Payment still in flight, leave proofs as PENDING
                throw new AppError(202, Err.TIMEOUT_ERROR, 'Lightning payment is pending; proofs remain reserved', { caller: 'meltProofs' })
            } else {
                // UNPAID: handle based on mint error code
                const isMintError = e instanceof MintOperationError
                const errorCode = isMintError ? e.code : undefined

                if (errorCode === 11002) {
                    // Proofs are pending at the mint — keep them PENDING
                    await syncProofsStateWithMint(walletId, mintUrl)
                    throw new AppError(202, Err.TIMEOUT_ERROR, 'Melt failed: proofs are pending at the mint', { caller: 'meltProofs' })
                } else if (errorCode === 11001) {
                    // Proofs already spent — sync all pending proofs with the mint
                    await syncProofsStateWithMint(walletId, mintUrl)
                    throw new AppError(500, Err.CONNECTION_ERROR, `Melt failed: proofs already spent. Wallet state synced with mint.`, { caller: 'meltProofs' })
                } else {
                    // Other error: safe to revert proofs back to UNSPENT
                    await updateProofsStatus(walletId, sendSecrets, ProofStatus.UNSPENT)
                    throw new AppError(500, Err.CONNECTION_ERROR, `Melt failed: ${e.message}`, { caller: 'meltProofs' })
                }
            }
        } catch (checkErr: any) {
            if (checkErr instanceof AppError) throw checkErr
            // Cannot reach mint to verify — leave as PENDING, let user retry check later
            throw new AppError(500, Err.CONNECTION_ERROR, `Melt failed and could not verify quote state: ${e.message}`, { caller: 'meltProofs' })
        }
    }
}


const syncProofsStateWithMint = async function (walletId: number, mintUrl: string): Promise<{ spent: number, pending: number, unspent: number }> {
    const wallet = await getWallet(mintUrl)
    const pendingProofs = await loadProofs(walletId, ProofStatus.PENDING)

    if (pendingProofs.length === 0) {
        return { spent: 0, pending: 0, unspent: 0 }
    }

    const mintStates = await wallet.checkProofsStates(pendingProofs)
    const spentSecrets: string[] = []
    const unspentSecrets: string[] = []

    for (let i = 0; i < pendingProofs.length; i++) {
        const mintState = mintStates[i]?.state
        if (mintState === CheckStateEnum.SPENT) {
            spentSecrets.push(pendingProofs[i].secret)
        } else if (mintState === CheckStateEnum.UNSPENT) {
            unspentSecrets.push(pendingProofs[i].secret)
        }
        // PENDING stays PENDING — no change needed
    }

    if (spentSecrets.length > 0) {
        await updateProofsStatus(walletId, spentSecrets, ProofStatus.SPENT)
    }
    if (unspentSecrets.length > 0) {
        await updateProofsStatus(walletId, unspentSecrets, ProofStatus.UNSPENT)
    }

    log.info('[syncProofsStateWithMint]', {
        walletId,
        total: pendingProofs.length,
        spent: spentSecrets.length,
        pending: pendingProofs.length - spentSecrets.length - unspentSecrets.length,
        unspent: unspentSecrets.length,
    })

    return {
        spent: spentSecrets.length,
        pending: pendingProofs.length - spentSecrets.length - unspentSecrets.length,
        unspent: unspentSecrets.length,
    }
}


const checkTokenState = async function (
    tokenStr: string,
    expectedMint?: string,
): Promise<{ proofStates: ProofState[], token: Token }> {
    const { mint } = getTokenMetadata(tokenStr)
    if (expectedMint && mint !== expectedMint) {
        throw new AppError(
            400,
            Err.VALIDATION_ERROR,
            `Token mint '${mint}' does not match wallet mint '${expectedMint}'`,
            { caller: 'checkTokenState' },
        )
    }
    const token = await decodeToken(tokenStr)
    const wallet = await getWallet(token.mint)
    const proofStates = await wallet.checkProofsStates(token.proofs)
    return { proofStates, token }
}


export const WalletService = {
    getMintUrls,
    getWallet,
    getProofsAmount,
    getTokenAmount,
    decodeToken,
    getWalletBalance,
    saveProofs,
    proofStorageData,
    loadProofs,
    updateProofsStatus,
    createMintQuote,
    checkMintQuote,
    mintProofs,
    sendProofs,
    receiveToken,
    createMeltQuote,
    checkMeltQuote,
    meltProofs,
    syncProofsStateWithMint,
    auditRestoredProofs,
    checkTokenState,
}
