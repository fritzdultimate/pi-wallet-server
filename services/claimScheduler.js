// services/claimScheduler.js
//
// Two jobs:
//  1. discoverClaimables() - for each of YOUR "main" wallets, ask Horizon what claimable
//     balances exist for it, and record any new ones. destination is always resolved
//     from Settings.destinationAddress here - it is never taken from a request body.
//  2. processDueClaims() - for balances whose claimableAt has passed, actually build,
//     sign (main wallet + a funder wallet to cover fees), and submit the claim.
//
// processDueClaims() runs up to settings.maxConcurrentClaims DIFFERENT claims at once.
// Each claim is still only ever submitted once - this is throughput across distinct
// claims, not the old repo's "flood the same claim N times to win a race" pattern, which
// doesn't apply here anyway since you're the sole named claimant on your own balances.
// Claims sharing a funder wallet are serialized relative to each other via
// runSerializedByKey(), because two transactions can't share one account's sequence
// number at the same time - only claims using DIFFERENT funders truly run in parallel.
//
// Every attempt writes an AuditLog row, success or failure, no exceptions.

import pLimit from 'p-limit';
import Wallet from '../models/Wallet.js';
import ClaimableBalance from '../models/ClaimableBalance.js';
import Settings from '../models/Settings.js';
import AuditLog from '../models/AuditLog.js';
import { decryptSecret } from '../lib/crypto.js';
import { runSerializedByKey } from '../lib/keyedQueue.js';
import {
    getClaimableBalancesFor,
    findClaimableAt,
    getKeypairFromCredential,
    getAccount,
    getNativeBalance,
    buildClaimAndForwardTx,
    resolveFeePerOperationStroops,
    submitTransaction,
    sleep,
} from '../lib/stellar.js';

let discovering = false;
let processing = false;

async function pickFunder(minBalance) {
    const funders = await Wallet.find({ role: 'funder' }).sort({ lastBalance: -1 });
    for (const funder of funders) {
        try {
            const accountData = await getAccount(funder.publicKey);
            const balance = getNativeBalance(accountData);
            funder.lastBalance = balance.toString();
            funder.lastCheckedAt = new Date();
            await funder.save();
            if (balance >= minBalance) return funder;
        } catch {
            // unreachable/unactivated funder - skip it
        }
    }
    return null;
}

/**
 * Check ONE wallet against Horizon for claimable balances, right now, and return exactly
 * what happened - used by both the background loop below AND routes/wallets.js's manual
 * "check now" button, so a single click gets a real, immediate answer instead of "wait
 * up to a minute and go look at a different tab."
 */
export async function discoverForWallet(wallet, settings) {
    if (!settings.destinationAddress) {
        const msg = 'No destination address is set in Settings - discovery is disabled until you set one.';
        wallet.lastDiscoveryError = msg;
        await wallet.save();
        return { ok: false, error: msg };
    }

    try {
        const records = await getClaimableBalancesFor(wallet.publicKey);
        let newlyAdded = 0;
        let totalAmountFound = 0;

        for (const record of records) {
            totalAmountFound += parseFloat(record.amount) || 0;

            const existing = await ClaimableBalance.findOne({ balanceId: record.id });
            if (existing) continue;

            await ClaimableBalance.create({
                walletId: wallet._id,
                balanceId: record.id,
                amount: record.amount,
                claimableAt: findClaimableAt(record, wallet.publicKey),
                destination: settings.destinationAddress,
            });

            await AuditLog.create({
                walletId: wallet._id,
                action: 'claimable_discovered',
                detail: `Found claimable balance ${record.id} for ${record.amount} Pi`,
            });
            newlyAdded++;
        }

        wallet.lastCheckedAt = new Date();
        wallet.lastDiscoveryError = null;
        await wallet.save();

        // totalAmountFound reflects what's on-chain for this wallet RIGHT NOW (Horizon's
        // live answer) - not just the sum of rows already in our DB - so a check-now click
        // always shows a real, current number even before/without a page reload.
        return { ok: true, totalFound: records.length, newlyAdded, totalAmountFound };
    } catch (err) {
        wallet.lastCheckedAt = new Date();
        wallet.lastDiscoveryError = err.message;
        await wallet.save();

        await AuditLog.create({
            walletId: wallet._id,
            action: 'discover_claimables_failed',
            level: 'error',
            detail: err.message,
        });

        return { ok: false, error: err.message };
    }
}

export async function discoverClaimables() {
    if (discovering) return;
    discovering = true;

    try {
        const settings = await Settings.getSingleton();
        const mainWallets = await Wallet.find({ role: 'main' });
        const limit = pLimit(settings.maxConcurrency || 5);

        await Promise.all(mainWallets.map((wallet) => limit(async () => {
            await discoverForWallet(wallet, settings);
            await sleep(200 + Math.random() * 300); // small jitter, not evasion - just spacing
        })));
    } finally {
        discovering = false;
    }
}

async function processOneClaim(claim, settings) {
    const funder = await pickFunder(settings.minFunderBalance || 1);
    if (!funder) {
        await AuditLog.create({
            action: 'claim_skipped_no_funder',
            level: 'warn',
            detail: `No funder wallet with sufficient balance to cover fees for ${claim.balanceId}`,
        });
        return;
    }

    // Everything from here on touches `funder`'s sequence number - serialize against any
    // other claim currently using the same funder, so they never collide.
    await runSerializedByKey(String(funder._id), async () => {
        claim.status = 'claiming';
        await claim.save();

        try {
            const mainWalletFull = await Wallet.findById(claim.walletId._id).select('+credentialEncrypted');
            const funderWalletFull = await Wallet.findById(funder._id).select('+credentialEncrypted');

            const mainKp = getKeypairFromCredential(
                decryptSecret(mainWalletFull.credentialEncrypted),
                mainWalletFull.credentialType
            );
            const funderKp = getKeypairFromCredential(
                decryptSecret(funderWalletFull.credentialEncrypted),
                funderWalletFull.credentialType
            );

            const feePerOperationStroops = await resolveFeePerOperationStroops({
                feeMode: settings.feeMode,
                extraFeePi: settings.extraFee,
                fixedFeePi: settings.fixedFeePi,
            });

            const xdr = await buildClaimAndForwardTx({
                mainKp,
                funderKp,
                balanceId: claim.balanceId,
                destination: claim.destination,
                amount: claim.amount,
                feePerOperationStroops,
            });

            const result = await submitTransaction(xdr);

            // We are the tx source (funder) - record the sequence we now expect, so
            // walletMonitor.js can tell if this funder account moves outside of us.
            const freshFunder = await getAccount(funderKp.publicKey());
            funder.lastKnownSequence = freshFunder.sequence;
            await funder.save();

            if (result.success && result.hash) {
                claim.status = 'claimed';
                claim.txHash = result.hash;
                claim.claimedAt = new Date();
                await AuditLog.create({
                    walletId: claim.walletId._id,
                    action: 'claim_succeeded',
                    detail: `Claimed ${claim.amount} Pi -> ${claim.destination}. Hash: ${result.hash}`,
                });
            } else {
                claim.status = 'failed';
                claim.lastError = JSON.stringify(result.reason || result.message || 'unknown error');
                await AuditLog.create({
                    walletId: claim.walletId._id,
                    action: 'claim_failed',
                    level: 'error',
                    detail: claim.lastError,
                });
            }
            await claim.save();
        } catch (err) {
            claim.status = 'failed';
            claim.lastError = err.message;
            await claim.save();
            await AuditLog.create({
                walletId: claim.walletId._id,
                action: 'claim_failed',
                level: 'error',
                detail: err.message,
            });
        }
    });
}

export async function processDueClaims() {
    if (processing) return;
    processing = true;

    try {
        const settings = await Settings.getSingleton();
        const due = await ClaimableBalance.find({
            status: 'pending',
            $or: [{ claimableAt: null }, { claimableAt: { $lte: new Date() } }],
        }).populate('walletId');

        const limit = pLimit(settings.maxConcurrentClaims || 5);

        await Promise.all(
            due
                .filter((claim) => claim.walletId)
                .map((claim) => limit(() => processOneClaim(claim, settings)))
        );
    } finally {
        processing = false;
    }
}