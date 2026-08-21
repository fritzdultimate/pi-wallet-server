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

        const reserves = await Wallet.find({ role: 'reserve' }).sort({ lastBalance: -1 });
        if (!reserves.length) {
            await AuditLog.create({
                action: 'prefund_skipped_no_reserve',
                level: 'warn',
                detail: 'funderPrefundEnabled is on but no wallet is tagged role: reserve',
            });
            return;
        }

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

            const topUpAmount = (target - balance).toFixed(7);
            const reserve = reserves.find((r) => parseFloat(r.lastBalance || '0') > Number(topUpAmount) + (settings.sweepReserveMinimum || 1));
            if (!reserve) {
                await AuditLog.create({
                    walletId: funder._id,
                    action: 'prefund_skipped_insufficient_reserve',
                    level: 'warn',
                    detail: `Funder "${funder.label}" needs ${topUpAmount} Pi but no reserve wallet has enough spare balance`,
                });
                continue;
            }

            await runSerializedByKey(String(reserve._id), async () => {
                try {
                    const reserveWalletFull = await Wallet.findById(reserve._id).select('+credentialEncrypted');
                    const reserveKp = getKeypairFromCredential(
                        decryptSecret(reserveWalletFull.credentialEncrypted),
                        reserveWalletFull.credentialType
                    );

                    const feePerOperationStroops = await resolveFeePerOperationStroops({
                        feeMode: settings.feeMode,
                        extraFeePi: settings.extraFee,
                        fixedFeePi: settings.fixedFeePi,
                    });

                    const xdr = await buildPaymentTx({
                        fromKp: reserveKp,
                        destination: funder.publicKey,
                        amount: topUpAmount,
                        feePerOperationStroops,
                    });
                    const result = await submitTransaction(xdr);

                    await AuditLog.create({
                        walletId: funder._id,
                        action: result.success ? 'funder_prefunded' : 'funder_prefund_failed',
                        level: result.success ? 'info' : 'error',
                        detail: result.success
                            ? `Topped up "${funder.label}" with ${topUpAmount} Pi from "${reserve.label}" (${leadTimeMs / 60_000} min lead time). Hash: ${result.hash}`
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