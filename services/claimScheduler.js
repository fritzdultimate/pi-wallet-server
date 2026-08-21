// services/claimScheduler.js
//
// Two jobs:
//  1. discoverClaimables() - for each of YOUR "main" wallets, ask Horizon what claimable
//     balances exist for it, and record any new ones. destination is always resolved
//     from Settings.destinationAddress here - it is never taken from a request body.
//  2. processDueClaims() - for balances whose claimableAt has passed, actually build,
//     sign (main wallet + a funder wallet to cover fees), and submit the claim.
//
// Every attempt writes an AuditLog row, success or failure, no exceptions.

import pLimit from 'p-limit';
import Wallet from '../models/Wallet.js';
import ClaimableBalance from '../models/ClaimableBalance.js';
import Settings from '../models/Settings.js';
import AuditLog from '../models/AuditLog.js';
import { decryptSecret } from '../lib/crypto.js';
import {
    getClaimableBalancesFor,
    findClaimableAt,
    getKeypairFromMnemonic,
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

export async function discoverClaimables() {
    if (discovering) return;
    discovering = true;

    try {
        const settings = await Settings.getSingleton();
        if (!settings.destinationAddress) {
            return; // nothing to do until you set a destination in Settings
        }

        const mainWallets = await Wallet.find({ role: 'main' });
        const limit = pLimit(settings.maxConcurrency || 5);

        await Promise.all(mainWallets.map((wallet) => limit(async () => {
            try {
                const records = await getClaimableBalancesFor(wallet.publicKey);
                for (const record of records) {
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
                }
                wallet.lastCheckedAt = new Date();
                await wallet.save();
            } catch (err) {
                await AuditLog.create({
                    walletId: wallet._id,
                    action: 'discover_claimables_failed',
                    level: 'error',
                    detail: err.message,
                });
            }
            await sleep(200 + Math.random() * 300); // small jitter, not evasion - just spacing
        })));
    } finally {
        discovering = false;
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

        for (const claim of due) {
            if (!claim.walletId) continue;

            const funder = await pickFunder(settings.minFunderBalance || 1);
            if (!funder) {
                await AuditLog.create({
                    action: 'claim_skipped_no_funder',
                    level: 'warn',
                    detail: `No funder wallet with sufficient balance to cover fees for ${claim.balanceId}`,
                });
                continue;
            }

            claim.status = 'claiming';
            await claim.save();

            try {
                const mainWalletFull = await Wallet.findById(claim.walletId._id).select('+mnemonicEncrypted');
                const funderWalletFull = await Wallet.findById(funder._id).select('+mnemonicEncrypted');
                const mainMnemonic = decryptSecret(mainWalletFull.mnemonicEncrypted);
                const funderMnemonic = decryptSecret(funderWalletFull.mnemonicEncrypted);

                const mainKp = getKeypairFromMnemonic(mainMnemonic);
                const funderKp = getKeypairFromMnemonic(funderMnemonic);

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
        }
    } finally {
        processing = false;
    }
}
