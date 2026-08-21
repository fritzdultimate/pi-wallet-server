// jobs/index.js
//
// All background work, registered in one place, with intervals sourced from Settings at
// startup. No setInterval soup scattered across server.js.

import Settings from '../models/Settings.js';
import { discoverClaimables, processDueClaims } from '../services/claimScheduler.js';
import { monitorWallets } from '../services/walletMonitor.js';

export async function startJobs() {
    const settings = await Settings.getSingleton();
    const pollMs = settings.pollIntervalMs || 60_000;

    setInterval(() => discoverClaimables().catch((err) => console.error('discoverClaimables error:', err)), pollMs);
    setInterval(() => processDueClaims().catch((err) => console.error('processDueClaims error:', err)), 15_000);
    setInterval(() => monitorWallets().catch((err) => console.error('monitorWallets error:', err)), 5 * 60_000);

    console.log(`🔁 Background jobs started (poll every ${pollMs}ms)`);
}
