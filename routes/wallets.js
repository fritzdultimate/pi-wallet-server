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
import ClaimableBalance from '../models/ClaimableBalance.js';
import Settings from '../models/Settings.js';
import AuditLog from '../models/AuditLog.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import {
    getKeypairFromCredential,
    detectCredentialType,
    getAccount,
    getNativeBalance,
    getMinAccountReservePi,
} from '../lib/stellar.js';
import { discoverForWallet } from '../services/claimScheduler.js';

const router = express.Router();

router.post('/', async (req, res) => {
    const { label, role, mnemonic, secretKey, credentialType: explicitType } = req.body;

    // Accept either field name - "mnemonic" for back-compat with earlier requests, or
    // "secretKey" when adding via a raw secret key. Whichever is present wins.
    const rawCredential = secretKey || mnemonic;

    if (!rawCredential) return res.status(400).json({ error: 'mnemonic or secretKey is required' });
    if (!label) return res.status(400).json({ error: 'label is required' });

    const credentialType = explicitType || (secretKey ? 'secret' : detectCredentialType(rawCredential));

    // Secret keys are case-sensitive base32 and canonically UPPERCASE - normalize so a
    // key copied from somewhere that displays it lowercase (or with stray whitespace)
    // still parses instead of failing with an opaque "invalid encoded string" error.
    const credential = credentialType === 'secret'
        ? rawCredential.trim().toUpperCase()
        : rawCredential.trim();

    let kp;
    try {
        kp = getKeypairFromCredential(credential, credentialType);
    } catch (err) {
        // Give a specific, actionable reason instead of a generic failure - this is what
        // was getting swallowed before and made secret-key uploads look silently broken.
        const hint = credentialType === 'secret'
            ? 'That doesn\'t look like a valid secret key - it should be exactly 56 characters and start with "S".'
            : 'That doesn\'t look like a valid 24-word recovery phrase.';
        return res.status(400).json({ error: hint, detail: err.message });
    }

    try {
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

        // If this is a "main" wallet, check for claimable balances immediately instead of
        // making you wait for the next background poll (up to a minute) to find out.
        if (wallet.role === 'main') {
            const settings = await Settings.getSingleton();
            await discoverForWallet(wallet, settings);
        }

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
    const wallets = await Wallet.find().sort({ createdAt: -1 }).lean();

    // Only count balances that are still actually outstanding - once something is
    // successfully claimed it shouldn't keep inflating the "N claimable" badge forever.
    // amount is stored as a String (raw Horizon value), so $toDouble it to sum properly.
    const stats = await ClaimableBalance.aggregate([
        { $match: { status: { $in: ['pending', 'claiming', 'failed'] } } },
        { $group: { _id: '$walletId', count: { $sum: 1 }, totalPi: { $sum: { $toDouble: '$amount' } } } },
    ]);
    const statsByWallet = Object.fromEntries(stats.map((s) => [String(s._id), s]));

    const settings = await Settings.getSingleton();
    const configuredReserveMinimum = settings.sweepReserveMinimum || 0;

    res.json(wallets.map((w) => {
        const s = statsByWallet[String(w._id)];
        const balance = w.lastBalance != null ? parseFloat(w.lastBalance) : null;
        return {
            ...w,
            claimableCount: s?.count || 0,
            claimablePiTotal: s?.totalPi || 0,
            // Best-effort estimate from the LAST checked balance/subentry count, not a
            // live Horizon call (this list endpoint stays cheap) - accurate as of
            // lastCheckedAt. "Refresh" (GET /:id/balance below) recomputes it live and is
            // what sweeper.js/funderPrefund.js actually rely on at spend time.
            reservedPi: configuredReserveMinimum,
            spendablePi: balance != null ? Math.max(0, balance - configuredReserveMinimum) : null,
        };
    }));
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
        const liveBalance = getNativeBalance(accountData);
        const balance = liveBalance.toString();
        wallet.lastBalance = balance;
        wallet.lastCheckedAt = new Date();
        await wallet.save();

        // Live, protocol-accurate reserve (accounts for this wallet's actual subentry
        // count - e.g. an extra co-signer) - the same number sweeper.js/funderPrefund.js
        // use, whichever is larger than the configured buffer. Surfaced here so the
        // dashboard can show real reserved-vs-spendable, not a flat guess.
        const settings = await Settings.getSingleton();
        const protocolMinReserve = await getMinAccountReservePi(accountData);
        const reservedPi = Math.max(settings.sweepReserveMinimum || 0, protocolMinReserve);
        const spendablePi = Math.max(0, liveBalance - reservedPi);

        res.json({ balance, reservedPi, spendablePi });
    } catch (err) {
        res.status(502).json({ error: 'Failed to fetch balance from Horizon', detail: err.message });
    }
});

// Manual, synchronous "check now" - returns a real answer immediately (found N, or the
// exact error) instead of waiting on the background poll and checking a different tab.
router.post('/:id/check-claimable', async (req, res) => {
    const wallet = await Wallet.findById(req.params.id);
    if (!wallet) return res.status(404).json({ error: 'Not found' });

    const settings = await Settings.getSingleton();
    const result = await discoverForWallet(wallet, settings);

    if (!result.ok) {
        return res.status(422).json(result);
    }
    res.json(result);
});

// Used internally elsewhere in the backend - not exported to the public API surface
// beyond this authenticated router. Kept here so decryption stays close to the model.
export async function decryptWalletCredential(walletId) {
    const wallet = await Wallet.findById(walletId).select('+credentialEncrypted');
    if (!wallet) throw new Error('Wallet not found');
    return { credential: decryptSecret(wallet.credentialEncrypted), credentialType: wallet.credentialType };
}

export default router;