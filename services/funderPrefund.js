// services/funderPrefund.js
//
// "Sponsors start funding N minutes before time" - reframed for single ownership: a
// wallet you tag role: 'reserve' tops up your funder wallets ahead of upcoming claims,
// with the lead time you configure in Settings (funderLeadTimeMinutes, default 25).
// Disabled by default (settings.funderPrefundEnabled) - nothing moves until you turn it on.

import Wallet from '../models/Wallet.js';
import ClaimableBalance from '../models/ClaimableBalance.js';
import Settings from '../models/Settings.js';
import AuditLog from '../models/AuditLog.js';
import { decryptSecret } from '../lib/crypto.js';
import { runSerializedByKey } from '../lib/keyedQueue.js';
import {
    getAccount,
    getNativeBalance,
    getKeypairFromCredential,
    buildPaymentTx,
    submitTransaction,
    resolveFeePerOperationStroops,
    getMinAccountReservePi,
} from '../lib/stellar.js';

let running = false;

export async function prefundFunders() {
    if (running) return;
    running = true;

    try {
        const settings = await Settings.getSingleton();
        if (!settings.funderPrefundEnabled) return;

        const leadTimeMs = (settings.funderLeadTimeMinutes || 25) * 60_000;
        const upcomingCount = await ClaimableBalance.countDocuments({
            status: 'pending',
            claimableAt: { $ne: null, $lte: new Date(Date.now() + leadTimeMs) },
        });
        if (!upcomingCount) return; // nothing due soon enough to warrant topping up

        const reserveWallets = await Wallet.find({ role: 'reserve' });
        if (!reserveWallets.length) {
            await AuditLog.create({
                action: 'prefund_skipped_no_reserve',
                level: 'warn',
                detail: 'funderPrefundEnabled is on but no wallet is tagged role: reserve',
            });
            return;
        }

        const feePerOperationStroops = await resolveFeePerOperationStroops({
            feeMode: settings.feeMode,
            extraFeePi: settings.extraFee,
            fixedFeePi: settings.fixedFeePi,
        });
        const feePi = feePerOperationStroops / 10_000_000;
        const configuredReserveMinimum = settings.sweepReserveMinimum || 0;

        // Refresh every reserve wallet's LIVE balance up front - `lastBalance` on the
        // Wallet doc can be stale for a long time (reserve wallets are never touched by
        // the funders-refresh loop below, only by this job and manual dashboard checks),
        // so selecting a "spare" reserve off a stale cached number is exactly how you'd
        // end up trying to send more than a reserve actually still holds. This also
        // computes each reserve's real protocol minimum (getMinAccountReservePi), so a
        // reserve that has picked up extra subentries since it was last checked is still
        // respected. `spare` tracks a live, IN-MEMORY running balance for this one run,
        // decremented after every successful spend, so two funders topped up back-to-back
        // in the same run never both draw against the same stale reserve balance.
        const reserves = [];
        for (const wallet of reserveWallets) {
            try {
                const accountData = await getAccount(wallet.publicKey);
                const liveBalance = getNativeBalance(accountData);
                const protocolMinReserve = await getMinAccountReservePi(accountData);
                const reserveMinimum = Math.max(configuredReserveMinimum, protocolMinReserve);

                wallet.lastBalance = liveBalance.toString();
                wallet.lastCheckedAt = new Date();
                await wallet.save();

                reserves.push({
                    wallet,
                    reserveMinimum,
                    spare: liveBalance - reserveMinimum, // never touch this wallet's own protected floor
                });
            } catch {
                // reserve wallet unreachable/unactivated - nothing to spend from right now
            }
        }
        reserves.sort((a, b) => b.spare - a.spare);

        const funders = await Wallet.find({ role: 'funder' });
        const target = settings.minFunderBalance || 1;

        for (const funder of funders) {
            let balance;
            try {
                const accountData = await getAccount(funder.publicKey);
                balance = getNativeBalance(accountData);
                funder.lastBalance = balance.toString();
                funder.lastCheckedAt = new Date();
                await funder.save();
            } catch {
                continue; // funder not reachable/activated - nothing to top up yet
            }

            if (balance >= target) continue;

            const topUpAmount = Number((target - balance).toFixed(7));
            // A reserve pays its OWN fee on top of the amount it sends (buildPaymentTx:
            // the reserve wallet is the tx source) - so the spend that actually needs to
            // fit under its protected floor is topUpAmount + feePi, not just topUpAmount.
            const candidate = reserves.find((r) => r.spare >= topUpAmount + feePi);
            if (!candidate) {
                await AuditLog.create({
                    walletId: funder._id,
                    action: 'prefund_skipped_insufficient_reserve',
                    level: 'warn',
                    detail: `Funder "${funder.label}" needs ${topUpAmount} Pi (+ ~${feePi.toFixed(7)} Pi fee) but no reserve wallet has that much spare balance above its own protocol/configured reserve floor`,
                });
                continue;
            }

            await runSerializedByKey(String(candidate.wallet._id), async () => {
                try {
                    const reserveWalletFull = await Wallet.findById(candidate.wallet._id).select('+credentialEncrypted');
                    const reserveKp = getKeypairFromCredential(
                        decryptSecret(reserveWalletFull.credentialEncrypted),
                        reserveWalletFull.credentialType
                    );

                    const xdr = await buildPaymentTx({
                        fromKp: reserveKp,
                        destination: funder.publicKey,
                        amount: topUpAmount.toFixed(7),
                        feePerOperationStroops,
                    });
                    const result = await submitTransaction(xdr);

                    if (result.success) {
                        // Reflect the spend immediately so the NEXT funder in this same
                        // run sees this reserve's true remaining spare balance instead of
                        // the pre-spend snapshot.
                        candidate.spare -= (topUpAmount + feePi);
                    }

                    await AuditLog.create({
                        walletId: funder._id,
                        action: result.success ? 'funder_prefunded' : 'funder_prefund_failed',
                        level: result.success ? 'info' : 'error',
                        detail: result.success
                            ? `Topped up "${funder.label}" with ${topUpAmount} Pi from "${candidate.wallet.label}" (${leadTimeMs / 60_000} min lead time, leaving ${candidate.wallet.label} with >= ${candidate.reserveMinimum.toFixed(7)} Pi reserved). Hash: ${result.hash}`
                            : JSON.stringify(result.reason || result.message),
                    });
                } catch (err) {
                    await AuditLog.create({
                        walletId: funder._id,
                        action: 'funder_prefund_failed',
                        level: 'error',
                        detail: err.message,
                    });
                }
            });
        }
    } finally {
        running = false;
    }
}