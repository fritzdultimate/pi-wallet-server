// services/sweeper.js
//
// Continuous sweep: periodically move spare balance out of your "main" wallets into
// Settings.destinationAddress, in batches, so Pi doesn't sit idle across many wallets
// between claims. Off by default (settings.sweepEnabled). Cycles through wallets in
// batches of settings.sweepBatchSize per run rather than hitting all of them at once -
// with many wallets, later ones get their turn on subsequent runs (oldest-checked first).

import pLimit from 'p-limit';
import Wallet from '../models/Wallet.js';
import Settings from '../models/Settings.js';
import AuditLog from '../models/AuditLog.js';
import { decryptSecret } from '../lib/crypto.js';
import {
    getAccount,
    getNativeBalance,
    getKeypairFromCredential,
    buildPaymentTx,
    submitTransaction,
    resolveFeePerOperationStroops,
} from '../lib/stellar.js';

let running = false;

export async function sweepWallets() {
    if (running) return;
    running = true;

    try {
        const settings = await Settings.getSingleton();
        if (!settings.sweepEnabled) return;
        if (!settings.destinationAddress) return;

        const batch = await Wallet.find({ role: 'main' })
            .sort({ lastCheckedAt: 1 }) // least-recently-checked first, so everyone gets a turn
            .limit(settings.sweepBatchSize || 10);

        if (!batch.length) return;

        const feePerOperationStroops = await resolveFeePerOperationStroops({
            feeMode: settings.feeMode,
            extraFeePi: settings.extraFee,
            fixedFeePi: settings.fixedFeePi,
        });
        const feePi = feePerOperationStroops / 10_000_000;
        const reserveMinimum = settings.sweepReserveMinimum || 1;

        const limit = pLimit(settings.maxConcurrency || 5);

        await Promise.all(batch.map((wallet) => limit(async () => {
            try {
                const accountData = await getAccount(wallet.publicKey);
                const balance = getNativeBalance(accountData);
                wallet.lastBalance = balance.toString();
                wallet.lastCheckedAt = new Date();

                const withdrawable = balance - reserveMinimum - feePi;
                if (withdrawable <= 0) {
                    await wallet.save();
                    return;
                }

                const walletFull = await Wallet.findById(wallet._id).select('+credentialEncrypted');
                const kp = getKeypairFromCredential(
                    decryptSecret(walletFull.credentialEncrypted),
                    walletFull.credentialType
                );

                const xdr = await buildPaymentTx({
                    fromKp: kp,
                    destination: settings.destinationAddress,
                    amount: withdrawable.toFixed(7),
                    feePerOperationStroops,
                });
                const result = await submitTransaction(xdr);
                await wallet.save();

                await AuditLog.create({
                    walletId: wallet._id,
                    action: result.success ? 'sweep_succeeded' : 'sweep_failed',
                    level: result.success ? 'info' : 'error',
                    detail: result.success
                        ? `Swept ${withdrawable.toFixed(7)} Pi from "${wallet.label}" -> ${settings.destinationAddress}. Hash: ${result.hash}`
                        : JSON.stringify(result.reason || result.message),
                });
            } catch (err) {
                await AuditLog.create({
                    walletId: wallet._id,
                    action: 'sweep_failed',
                    level: 'error',
                    detail: err.message,
                });
            }
        })));
    } finally {
        running = false;
    }
}