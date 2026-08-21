// services/walletHealth.js
//
// "Suggest safe wallets for sponsors [funders]" - reframed for single ownership: score
// YOUR OWN funder wallets on whether they're currently good candidates to pay fees,
// rather than sourcing or vetting anyone else's wallets.

import Wallet from '../models/Wallet.js';
import Settings from '../models/Settings.js';

export async function scoreFunderWallets() {
    const settings = await Settings.getSingleton();
    const funders = await Wallet.find({ role: 'funder' });

    return funders.map((funder) => {
        const balance = parseFloat(funder.lastBalance || '0');
        const reasons = [];
        let score = 100;

        if (funder.flagged) {
            score -= 60;
            reasons.push(`Flagged: ${funder.flagReason}`);
        }

        if (balance < (settings.minFunderBalance || 1)) {
            score -= 30;
            reasons.push(`Balance ${balance} below configured minimum ${settings.minFunderBalance}`);
        }

        const staleMs = funder.lastCheckedAt ? Date.now() - new Date(funder.lastCheckedAt).getTime() : Infinity;
        if (staleMs > 15 * 60 * 1000) {
            score -= 10;
            reasons.push('Not checked recently');
        }

        score = Math.max(0, score);

        return {
            id: funder._id,
            label: funder.label,
            publicKey: funder.publicKey,
            balance,
            score,
            safe: score >= 70,
            reasons,
        };
    }).sort((a, b) => b.score - a.score);
}
