// models/ClaimableBalance.js
//
// One row per claimable balance discovered on one of your own wallets. destination is
// always resolved from Settings (or explicitly passed by you through the authenticated
// dashboard) at claim time - it is never accepted from an inbound API request body.

import mongoose from 'mongoose';

const ClaimableBalanceSchema = new mongoose.Schema({
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true },
    balanceId: { type: String, required: true, unique: true },
    amount: String,
    claimableAt: Date,
    destination: { type: String, required: true },

    status: {
        type: String,
        enum: ['pending', 'claiming', 'claimed', 'failed'],
        default: 'pending',
    },
    txHash: String,
    lastError: String,

    createdAt: { type: Date, default: Date.now },
    claimedAt: Date,
});

export default mongoose.model('ClaimableBalance', ClaimableBalanceSchema);
