// models/Wallet.js
//
// A wallet YOU add. mnemonicEncrypted is only ever decrypted transiently in-memory to
// sign a transaction. There is no field anywhere for "who submitted this" separate from
// the single owner of this deployment - this app is single-tenant by design.

import mongoose from 'mongoose';

const WalletSchema = new mongoose.Schema({
    label: { type: String, required: true, trim: true },
    role: { type: String, enum: ['main', 'funder'], default: 'main' },
    publicKey: { type: String, required: true, unique: true },
    mnemonicEncrypted: { type: String, required: true, select: false }, // AES-256-GCM, see lib/crypto.js

    // Bookkeeping populated by background jobs - never by an external caller.
    lastCheckedAt: Date,
    lastKnownSequence: String,
    expectedSignerCount: Number,
    lastBalance: String,

    // Set by services/walletMonitor.js when activity is seen that our own scheduler
    // didn't initiate. Surfaced in the dashboard as a red flag for that wallet.
    flagged: { type: Boolean, default: false },
    flagReason: String,

    createdAt: { type: Date, default: Date.now },
}, {
    timestamps: { createdAt: false, updatedAt: 'updatedAt' },
});

export default mongoose.model('Wallet', WalletSchema);
