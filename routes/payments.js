// routes/payments.js
//
// "Send Pi from one wallet to another" - authenticated, single-owner only. The fee comes
// from Settings.feeMode: 'auto' (live network fee + your buffer) or 'fixed' (exactly
// what you set, regardless of live network conditions - this is the manual override).

import express from 'express';
import Wallet from '../models/Wallet.js';
import Settings from '../models/Settings.js';
import AuditLog from '../models/AuditLog.js';
import { decryptSecret } from '../lib/crypto.js';
import {
    getKeypairFromCredential,
    buildPaymentTx,
    submitTransaction,
    resolveFeePerOperationStroops,
} from '../lib/stellar.js';

const router = express.Router();

router.get('/quote', async (req, res) => {
    const settings = await Settings.getSingleton();
    const feePerOperationStroops = await resolveFeePerOperationStroops({
        feeMode: settings.feeMode,
        extraFeePi: settings.extraFee,
        fixedFeePi: settings.fixedFeePi,
    });

    res.json({
        feeMode: settings.feeMode,
        // A "Send Pi" transaction has exactly 1 operation, so per-operation === total here.
        feePi: (feePerOperationStroops / 10_000_000).toFixed(7),
    });
});

router.post('/send', async (req, res) => {
    const { fromWalletId, destination, amount } = req.body;

    if (!fromWalletId) return res.status(400).json({ error: 'fromWalletId is required' });
    if (!destination) return res.status(400).json({ error: 'destination is required' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'A valid amount is required' });

    try {
        const wallet = await Wallet.findById(fromWalletId).select('+credentialEncrypted');
        if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

        const settings = await Settings.getSingleton();
        const feePerOperationStroops = await resolveFeePerOperationStroops({
            feeMode: settings.feeMode,
            extraFeePi: settings.extraFee,
            fixedFeePi: settings.fixedFeePi,
        });

        const credential = decryptSecret(wallet.credentialEncrypted);
        const fromKp = getKeypairFromCredential(credential, wallet.credentialType);

        const xdr = await buildPaymentTx({ fromKp, destination, amount: String(amount), feePerOperationStroops });
        const result = await submitTransaction(xdr);

        await AuditLog.create({
            walletId: wallet._id,
            action: result.success ? 'payment_sent' : 'payment_failed',
            level: result.success ? 'info' : 'error',
            detail: result.success
                ? `Sent ${amount} Pi from "${wallet.label}" to ${destination} (fee mode: ${settings.feeMode}). Hash: ${result.hash}`
                : JSON.stringify(result.reason || result.message),
        });

        if (!result.success) {
            return res.status(502).json(result);
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to send payment', detail: err.message });
    }
});

export default router;