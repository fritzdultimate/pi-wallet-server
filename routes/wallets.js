// routes/wallets.js
//
// Every route here is mounted behind requireAuth in server.js. There is deliberately no
// public/unauthenticated route anywhere in this app that accepts a credential - adding a
// wallet always means YOU, logged in, adding a wallet you hold the keys to.
//
// Accepts either a 24-word mnemonic OR a raw secret key (starts with "S") - whichever you
// paste in. Auto-detected if you don't specify credentialType explicitly.

import express from 'express';
import Wallet from '../models/Wallet.js';
import AuditLog from '../models/AuditLog.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import {
    getKeypairFromCredential,
    detectCredentialType,
    getAccount,
    getNativeBalance,
} from '../lib/stellar.js';

const router = express.Router();

router.post('/', async (req, res) => {
    const { label, role, mnemonic, secretKey, credentialType: explicitType } = req.body;

    // Accept either field name - "mnemonic" for back-compat with earlier requests, or
    // "secretKey" when adding via a raw secret key. Whichever is present wins.
    const credential = secretKey || mnemonic;

    if (!credential) return res.status(400).json({ error: 'mnemonic or secretKey is required' });
    if (!label) return res.status(400).json({ error: 'label is required' });

    const credentialType = explicitType || (secretKey ? 'secret' : detectCredentialType(credential));

    try {
        const kp = getKeypairFromCredential(credential, credentialType);
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
            role: ['main', 'funder', 'reserve'].includes(role) ? role : 'main',
            publicKey,
            credentialEncrypted: encryptSecret(credential),
            credentialType,
            lastBalance,
            lastCheckedAt: new Date(),
        });

        await AuditLog.create({
            walletId: wallet._id,
            action: 'wallet_added',
            detail: `Added wallet "${label}" (${wallet.role}, via ${credentialType})`,
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

// Used internally elsewhere in the backend - not exported to the public API surface
// beyond this authenticated router. Kept here so decryption stays close to the model.
export async function decryptWalletCredential(walletId) {
    const wallet = await Wallet.findById(walletId).select('+credentialEncrypted');
    if (!wallet) throw new Error('Wallet not found');
    return { credential: decryptSecret(wallet.credentialEncrypted), credentialType: wallet.credentialType };
}

export default router;