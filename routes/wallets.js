// routes/wallets.js
//
// Every route here is mounted behind requireAuth in server.js. There is deliberately no
// public/unauthenticated route anywhere in this app that accepts a mnemonic - adding a
// wallet always means YOU, logged in, adding a wallet you hold the keys to.

import express from 'express';
import Wallet from '../models/Wallet.js';
import AuditLog from '../models/AuditLog.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { getKeypairFromMnemonic, getAccount, getNativeBalance } from '../lib/stellar.js';

const router = express.Router();

router.post('/', async (req, res) => {
    const { label, role, mnemonic } = req.body;

    if (!mnemonic) return res.status(400).json({ error: 'mnemonic is required' });
    if (!label) return res.status(400).json({ error: 'label is required' });

    try {
        const kp = getKeypairFromMnemonic(mnemonic);
        const publicKey = kp.publicKey();

        const existing = await Wallet.findOne({ publicKey });
        if (existing) {
            return res.status(409).json({ error: 'This wallet is already added' });
        }

        let lastBalance = null;
        try {
            const accountData = await getAccount(publicKey);
            lastBalance = getNativeBalance(accountData).toString();
        } catch {
            // Account may not be activated on-chain yet - that's fine, we still store it.
        }

        const wallet = await Wallet.create({
            label,
            role: role === 'funder' ? 'funder' : 'main',
            publicKey,
            mnemonicEncrypted: encryptSecret(mnemonic),
            lastBalance,
            lastCheckedAt: new Date(),
        });

        await AuditLog.create({
            walletId: wallet._id,
            action: 'wallet_added',
            detail: `Added wallet "${label}" (${role || 'main'})`,
        });

        res.status(201).json({
            id: wallet._id,
            label: wallet.label,
            role: wallet.role,
            publicKey: wallet.publicKey,
            lastBalance: wallet.lastBalance,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add wallet', detail: err.message });
    }
});

router.get('/', async (req, res) => {
    const wallets = await Wallet.find().sort({ createdAt: -1 });
    res.json(wallets);
});

router.delete('/:id', async (req, res) => {
    const wallet = await Wallet.findByIdAndDelete(req.params.id);
    if (!wallet) return res.status(404).json({ error: 'Not found' });

    await AuditLog.create({
        walletId: wallet._id,
        action: 'wallet_removed',
        detail: `Removed wallet "${wallet.label}"`,
    });

    res.json({ success: true });
});

router.get('/:id/balance', async (req, res) => {
    const wallet = await Wallet.findById(req.params.id);
    if (!wallet) return res.status(404).json({ error: 'Not found' });

    try {
        const accountData = await getAccount(wallet.publicKey);
        const balance = getNativeBalance(accountData).toString();
        wallet.lastBalance = balance;
        wallet.lastCheckedAt = new Date();
        await wallet.save();
        res.json({ balance });
    } catch (err) {
        res.status(502).json({ error: 'Failed to fetch balance from Horizon', detail: err.message });
    }
});

// Used internally by /api/backup and /api/cosign - not exported to the public API surface
// beyond this authenticated router. Kept here so decryption stays close to the model.
export async function decryptWalletMnemonic(walletId) {
    const wallet = await Wallet.findById(walletId).select('+mnemonicEncrypted');
    if (!wallet) throw new Error('Wallet not found');
    return decryptSecret(wallet.mnemonicEncrypted);
}

export default router;
