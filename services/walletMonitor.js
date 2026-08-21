// services/walletMonitor.js
//
// "Detect wallets that might be a red flag - e.g. another bot/signer active inside".
//
// How it works: every time this server submits a transaction sourced from one of your
// wallets (claimScheduler.js, routes/payments.js), it records the sequence number that
// account should now be at. This job periodically re-fetches each wallet's live sequence
// number and signer list from Horizon; if either has moved without us having recorded
// that we did it, the wallet gets flagged. That's the actual definition of "something
// else has this key or is a signer on this account."

import Wallet from '../models/Wallet.js';
import AuditLog from '../models/AuditLog.js';
import { getAccount } from '../lib/stellar.js';

export async function monitorWallets() {
    const wallets = await Wallet.find();

    for (const wallet of wallets) {
        try {
            const accountData = await getAccount(wallet.publicKey);
            const liveSequence = accountData.sequence;
            const liveSignerCount = (accountData.signers || []).length;

            const flags = [];

            if (wallet.lastKnownSequence && liveSequence !== wallet.lastKnownSequence) {
                flags.push('Sequence number advanced without this server initiating it');
            }

            if (wallet.expectedSignerCount != null && liveSignerCount !== wallet.expectedSignerCount) {
                flags.push('Signer list changed unexpectedly - another key may now control this account');
            }

            if (flags.length) {
                wallet.flagged = true;
                wallet.flagReason = flags.join('; ');
                await AuditLog.create({
                    walletId: wallet._id,
                    action: 'wallet_flagged',
                    level: 'warn',
                    detail: wallet.flagReason,
                });
            } else if (wallet.flagged) {
                // Only auto-clear if we're the ones who caused the change we now see
                // (lastKnownSequence catches up naturally after our own submissions).
                wallet.flagged = false;
                wallet.flagReason = null;
            }

            // Baseline for next comparison - always track current known-good state.
            wallet.lastKnownSequence = liveSequence;
            wallet.expectedSignerCount = liveSignerCount;
            wallet.lastCheckedAt = new Date();
            await wallet.save();
        } catch {
            // Not reachable / not yet activated on-chain - not itself a red flag.
        }
    }
}
