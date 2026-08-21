// models/Settings.js
//
// Singleton settings document for this single-owner deployment. No "name" field to key
// off of - there is only ever one settings document, because there is only ever one owner.

import mongoose from 'mongoose';

const SettingsSchema = new mongoose.Schema({
    // Where claims and sweeps go by default. Can be overridden per-action from the
    // dashboard, but never by an unauthenticated or external request.
    destinationAddress: { type: String, default: '' },

    // Fee strategy, applied per-operation (matches how stellar-base's TransactionBuilder
    // treats the `fee` option - it multiplies this by the operation count itself, so
    // every caller of buildClaimAndForwardTx/buildPaymentTx must pass a PER-OPERATION
    // value, never a pre-multiplied total).
    //
    // 'auto'  - live network base fee (Horizon /fee_stats) + extraFee buffer on top.
    // 'fixed' - ignore the live network fee entirely and always charge fixedFeePi per
    //           operation. This is what lets you deliberately spike the fee yourself.
    feeMode: { type: String, enum: ['auto', 'fixed'], default: 'auto' },

    // 'auto' mode: extra buffer (in Pi) added on top of the live base fee, per operation.
    extraFee: { type: Number, default: 0.01 },

    // 'fixed' mode: the exact fee (in Pi) to charge per operation, regardless of what
    // the network is currently charging. Set this higher to intentionally pay more for
    // priority; the network will still reject it if it's below the enforced minimum.
    fixedFeePi: { type: Number, default: 0.01 },

    // How often (ms) the claim scheduler polls for claimable balances.
    pollIntervalMs: { type: Number, default: 60_000 },

    // Concurrency cap for batched Horizon calls across many wallets.
    maxConcurrency: { type: Number, default: 5 },

    minFunderBalance: { type: Number, default: 1 },

    telegramAlertsEnabled: { type: Boolean, default: false },
}, {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
});

// Always resolve (and lazily create) the single settings doc.
SettingsSchema.statics.getSingleton = async function () {
    let doc = await this.findOne();
    if (!doc) {
        doc = await this.create({});
    }
    return doc;
};

export default mongoose.model('Settings', SettingsSchema);
