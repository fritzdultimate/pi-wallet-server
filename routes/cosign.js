// routes/cosign.js
//
// On-demand co-signing: hand in an XDR transaction envelope, pick one of your own
// wallets, get back the XDR with that wallet's signature added. Nothing is submitted
// automatically - that stays a separate, explicit step you trigger yourself.

import express from 'express';
import Wallet from '../models/Wallet.js';
import AuditLog from '../models/AuditLog.js';
import { decryptSecret } from '../lib/crypto.js';
import { getKeypairFromCredential, coSignXdr, submitTransaction } from '../lib/stellar.js';

const router = express.Router();

router.post('/', async (req, res) => {
    const { xdr, walletId } = req.body;
    if (!xdr) return res.status(400).json({ error: 'xdr is required' });
    if (!walletId) return res.status(400).json({ error: 'walletId is required' });

    try {
        const wallet = await Wallet.findById(walletId).select('+credentialEncrypted');
        if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

        const credential = decryptSecret(wallet.credentialEncrypted);
        const kp = getKeypairFromCredential(credential, wallet.credentialType);

        const signedXdr = coSignXdr(xdr, kp);

        await AuditLog.create({
            walletId: wallet._id,
            action: 'cosign_added',
            detail: `Added signature from "${wallet.label}" to a transaction`,
        });

        res.json({ xdr: signedXdr });
    } catch (err) {
        res.status(500).json({ error: 'Failed to co-sign', detail: err.message });
    }
});

router.post('/submit', async (req, res) => {
    const { xdr } = req.body;
    if (!xdr) return res.status(400).json({ error: 'xdr is required' });

    const result = await submitTransaction(xdr);
    await AuditLog.create({
        action: result.success ? 'cosigned_tx_submitted' : 'cosigned_tx_submit_failed',
        level: result.success ? 'info' : 'error',
        detail: result.success ? `Hash: ${result.hash}` : JSON.stringify(result.reason || result.message),
    });

    res.json(result);
});

export default router;