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

    // How many DIFFERENT due claims processDueClaims() will work on at once. Each claim
    // is still only ever submitted once - this is throughput across distinct claims, not
    // duplicate submissions of the same one (see services/claimScheduler.js). Two claims
    // that land on the same funder wallet are still serialized relative to each other,
    // since Stellar accounts can't process two transactions from the same sequence number
    // at once - only claims using DIFFERENT funders actually run in parallel.
    maxConcurrentClaims: { type: Number, default: 5, min: 1, max: 50 },

    // Pre-funding: how many minutes before a claim becomes due should the scheduler make
    // sure a funder wallet is topped up in advance, using a "reserve" role wallet.
    funderPrefundEnabled: { type: Boolean, default: false },
    funderLeadTimeMinutes: { type: Number, default: 25 },

    // Continuous sweep: periodically move balances from your "main" wallets to
    // destinationAddress in batches, rather than waiting on the claim flow.
    sweepEnabled: { type: Boolean, default: false },
    sweepIntervalMs: { type: Number, default: 5 * 60_000 },
    sweepBatchSize: { type: Number, default: 10 },
    // Leave at least this much Pi behind in any wallet this server debits on its own -
    // continuous sweep (services/sweeper.js) AND sponsor/funder pre-funding
    // (services/funderPrefund.js) both apply this. It exists so YOU can deliberately
    // leave extra headroom above the bare protocol minimum (e.g. for a future fee spike).
    // It is a FLOOR on top of, never a replacement for, the actual per-account protocol
    // minimum balance - both services also independently compute each account's real
    // requirement live (getMinAccountReservePi in lib/stellar.js, which accounts for
    // extra subentries like a co-signer) and use whichever number is larger. Pi Network's
    // bare minimum for a plain, no-subentry account is ~0.98 Pi - if you saw sweeps fail
    // and burn fees trying to drain a wallet below that, this is the setting (and the
    // now-automatic protocol-floor check) that fixes it.
    sweepReserveMinimum: { type: Number, default: 0.98 },

    // "Flood"/race a due claim across this many DIFFERENT funder (sponsor) wallets at
    // once, each submitting its own claim-and-forward transaction for the SAME claimable
    // balance concurrently. Only one can ever actually land (the claim is consumed
    // atomically on-chain, so the rest simply fail once it's gone) - the point is to beat
    // Pi mainnet congestion at unlock time by giving the claim several independent shots
    // at ledger inclusion instead of just one. 1 = old single-sponsor behavior (no flood).
    // Capped at 20 to keep a single misconfiguration from burning your whole funder pool
    // on one claim.
    claimSponsorFanout: { type: Number, default: 1, min: 1, max: 20 },

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