// routes/backup.js
//
// "Download keys as backup anytime by clicking a button." The export is encrypted with
// a password YOU supply at download time (not MASTER_KEY) via scrypt + AES-256-GCM, so
// the file is self-contained and useless without that password. Nothing is written to
// disk server-side - it's generated and streamed directly in the response.

import express from 'express';
import Wallet from '../models/Wallet.js';
import AuditLog from '../models/AuditLog.js';
import { decryptSecret, encryptWithPassword } from '../lib/crypto.js';

const router = express.Router();

router.post('/', async (req, res) => {
    const { walletIds, password } = req.body;

    if (!password || password.length < 8) {
        return res.status(400).json({ error: 'A backup password of at least 8 characters is required' });
    }

    try {
        const query = Array.isArray(walletIds) && walletIds.length
            ? { _id: { $in: walletIds } }
            : {};

        const wallets = await Wallet.find(query).select('+mnemonicEncrypted');

        const payload = wallets.map((w) => ({
            label: w.label,
            role: w.role,
            publicKey: w.publicKey,
            mnemonic: decryptSecret(w.mnemonicEncrypted),
        }));

        const encrypted = encryptWithPassword(JSON.stringify({ exportedAt: new Date().toISOString(), wallets: payload }), password);

        await AuditLog.create({
            action: 'backup_exported',
            detail: `Exported encrypted backup of ${wallets.length} wallet(s)`,
        });

        res.json({ backup: encrypted });
    } catch (err) {
        res.status(500).json({ error: 'Failed to build backup', detail: err.message });
    }
});

export default router;
