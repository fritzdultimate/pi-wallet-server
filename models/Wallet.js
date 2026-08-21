// models/Wallet.js
//
// A wallet YOU add. credentialEncrypted is only ever decrypted transiently in-memory to
// sign a transaction. There is no field anywhere for "who submitted this" separate from
// the single owner of this deployment - this app is single-tenant by design.

import mongoose from 'mongoose';

const WalletSchema = new mongoose.Schema({
    label: { type: String, required: true, trim: true },
    // main    - a wallet whose claimable balances you want claimed
    // funder  - pays network fees for claim transactions
    // reserve - the source pre-funding tops funders up from, ahead of time
    role: { type: String, enum: ['main', 'funder', 'reserve'], default: 'main' },
    publicKey: { type: String, required: true, unique: true },

    // Either a 24-word mnemonic or a raw Stellar/Pi secret key (starts with "S"). Stored
    // encrypted at rest either way - see lib/crypto.js. credentialType tells us how to
    // turn it back into a signing keypair.
    credentialEncrypted: { type: String, required: true, select: false },
    credentialType: { type: String, enum: ['mnemonic', 'secret'], default: 'mnemonic' },

    // Bookkeeping populated by background jobs - never by an external caller.
    lastCheckedAt: Date,
    lastKnownSequence: String,
    expectedSignerCount: Number,
    lastBalance: String,

    // Set by services/claimScheduler.js's discoverForWallet() every time it checks this
    // wallet for claimable balances - null on success, an error message on failure (e.g.
    // "no destination address set", or a Horizon error). This is what lets the dashboard
    // show real proof of whether discovery ran and what it found, instead of the wallet
    // just sitting there with only a balance and no way to tell if anything happened.
    lastDiscoveryError: String,

    // Set by services/walletMonitor.js when activity is seen that our own scheduler
    // didn't initiate. Surfaced in the dashboard as a red flag for that wallet.
    flagged: { type: Boolean, default: false },
    flagReason: String,

    createdAt: { type: Date, default: Date.now },
}, {
    timestamps: { createdAt: false, updatedAt: 'updatedAt' },
});

export default mongoose.model('Wallet', WalletSchema);