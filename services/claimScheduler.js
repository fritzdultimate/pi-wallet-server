// services/claimScheduler.js
//
// Two jobs:
//  1. discoverClaimables() - for each of YOUR "main" wallets, ask Horizon what claimable
//     balances exist for it, and record any new ones. destination is always resolved
//     from Settings.destinationAddress here - it is never taken from a request body.
//  2. processDueClaims() - for balances whose claimableAt has passed, actually build,
//     sign, and submit the claim - racing it across settings.claimSponsorFanout DIFFERENT
//     funder (sponsor) wallets at once when that's set above 1.
//
// processDueClaims() runs up to settings.maxConcurrentClaims DIFFERENT claims at once.
// Within EACH of those claims, processOneClaim() now submits the SAME claim-and-forward
// transaction concurrently from settings.claimSponsorFanout different funder wallets (the
// "flood"/spam behavior from the old bot) - each funder pays its own fee and races the
// others to get the claim included. Only one can ever actually succeed on-chain: claiming
// a claimable balance consumes it atomically, so whichever sponsor's transaction lands
// first wins and every other sponsor's attempt then fails harmlessly (the balance is
// simply gone by the time theirs is applied). The point isn't racing another claimant -
// you're the sole named claimant on your own balances - it's beating Pi mainnet
// congestion at unlock time, when huge numbers of unrelated wallets are all trying to
// claim in the same few ledgers: one shot at inclusion can lose to a full ledger or a
// dropped submission, several independent shots from different accounts (so they don't
// collide on sequence numbers) meaningfully raise the odds one of them lands quickly.
// claimSponsorFanout defaults to 1 (single sponsor, no flood) - set it in Settings to use
// more.
//
// Claims sharing a funder wallet are still serialized relative to each other via
// runSerializedByKey(), because two transactions can't share one account's sequence
// number at the same time - only work on DIFFERENT funders truly runs in parallel, both
// across distinct claims AND across one claim's own fanout attempts.
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

/**
 * Live-check funder wallets (highest cached balance first, since that's most likely to
 * still qualify) and return up to `count` distinct ones with at least `minBalance` Pi
 * right now. Stops as soon as it has enough - with few funders this checks all of them
 * (same as the old single-funder pickFunder ever did), with many it doesn't bother
 * checking every last one once enough eligible sponsors are already found.
 */
async function pickFunders(minBalance, count) {
    const funders = await Wallet.find({ role: 'funder' }).sort({ lastBalance: -1 });
    const eligible = [];
    for (const funder of funders) {
        if (eligible.length >= count) break;
        try {
            const accountData = await getAccount(funder.publicKey);
            const balance = getNativeBalance(accountData);
            funder.lastBalance = balance.toString();
            funder.lastCheckedAt = new Date();
            await funder.save();
            if (balance >= minBalance) eligible.push(funder);
        } catch {
            // unreachable/unactivated funder - skip it
        }
    }
    return eligible;
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

/**
 * One sponsor's single attempt at claiming `claim`, fully serialized against any other
 * claim currently using this same funder (shared sequence number). Never throws - always
 * resolves to { funder, result } so Promise.allSettled callers can inspect every attempt.
 */
async function attemptClaimWithFunder(claim, funder, feePerOperationStroops) {
    return runSerializedByKey(String(funder._id), async () => {
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
            try {
                const freshFunder = await getAccount(funderKp.publicKey());
                funder.lastKnownSequence = freshFunder.sequence;
                await funder.save();
            } catch {
                // best-effort bookkeeping only - a failure here shouldn't mask the claim result
            }

            await AuditLog.create({
                walletId: claim.walletId._id,
                action: result.success ? 'claim_attempt_succeeded' : 'claim_attempt_failed',
                level: result.success ? 'info' : 'warn',
                detail: `[sponsor "${funder.label}"] ` + (result.success
                    ? `Claimed ${claim.amount} Pi -> ${claim.destination}. Hash: ${result.hash}`
                    : JSON.stringify(result.reason || result.message || 'unknown error')),
            });

            return { funder, result };
        } catch (err) {
            await AuditLog.create({
                walletId: claim.walletId._id,
                action: 'claim_attempt_failed',
                level: 'warn',
                detail: `[sponsor "${funder.label}"] ${err.message}`,
            });
            return { funder, result: { success: false, message: err.message } };
        }
    });
}

async function processOneClaim(claim, settings) {
    const fanout = Math.max(1, Math.min(settings.claimSponsorFanout || 1, 20));
    const funders = await pickFunders(settings.minFunderBalance || 1, fanout);
    if (!funders.length) {
        await AuditLog.create({
            action: 'claim_skipped_no_funder',
            level: 'warn',
            detail: `No funder wallet with sufficient balance to cover fees for ${claim.balanceId}`,
        });
        return;
    }

    claim.status = 'claiming';
    await claim.save();

    const feePerOperationStroops = await resolveFeePerOperationStroops({
        feeMode: settings.feeMode,
        extraFeePi: settings.extraFee,
        fixedFeePi: settings.fixedFeePi,
    });

    try {
        // Fire the SAME claim at every selected sponsor concurrently (settings.claimSponsorFanout
        // controls how many). Each goes through a DIFFERENT funder, so none of these
        // collide on a shared sequence number - they genuinely race in parallel. Only one
        // can ever actually consume the claimable balance on-chain; the rest simply lose
        // the race and fail, which is expected and fine, not an error condition.
        const settled = await Promise.allSettled(
            funders.map((funder) => attemptClaimWithFunder(claim, funder, feePerOperationStroops))
        );

        const winner = settled.find(
            (s) => s.status === 'fulfilled' && s.value.result.success && s.value.result.hash
        );

        if (winner) {
            claim.status = 'claimed';
            claim.txHash = winner.value.result.hash;
            claim.claimedAt = new Date();
            await AuditLog.create({
                walletId: claim.walletId._id,
                action: 'claim_succeeded',
                detail: funders.length > 1
                    ? `Claimed ${claim.amount} Pi -> ${claim.destination} via sponsor "${winner.value.funder.label}" (raced against ${funders.length - 1} other sponsor(s)). Hash: ${winner.value.result.hash}`
                    : `Claimed ${claim.amount} Pi -> ${claim.destination}. Hash: ${winner.value.result.hash}`,
            });
        } else {
            const reasons = settled.map((s) => (
                s.status === 'fulfilled'
                    ? (s.value.result.reason || s.value.result.message)
                    : s.reason?.message
            )).filter(Boolean);
            claim.status = 'failed';
            claim.lastError = JSON.stringify(reasons.length ? reasons : 'unknown error');
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