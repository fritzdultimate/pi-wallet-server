// jobs/index.js
//
// All background work, registered here. Each job self-reschedules using a fresh read of
// Settings every cycle, so toggling something in the dashboard (sweep on/off, a changed
// interval) takes effect on the next tick instead of requiring a server restart.

import Settings from '../models/Settings.js';
import { discoverClaimables, processDueClaims } from '../services/claimScheduler.js';
import { monitorWallets } from '../services/walletMonitor.js';
import { prefundFunders } from '../services/funderPrefund.js';
import { sweepWallets } from '../services/sweeper.js';

function loop(name, fn, getIntervalMs) {
    async function tick() {
        try {
            await fn();
        } catch (err) {
            console.error(`${name} error:`, err);
        } finally {
            const ms = await getIntervalMs();
            setTimeout(tick, ms);
        }
    }
    tick();
}

export async function startJobs() {
    const settings = await Settings.getSingleton();

    loop('discoverClaimables', discoverClaimables, async () => (await Settings.getSingleton()).pollIntervalMs || 60_000);
    loop('processDueClaims', processDueClaims, async () => 15_000);
    loop('monitorWallets', monitorWallets, async () => 5 * 60_000);
    loop('prefundFunders', prefundFunders, async () => 60_000);
    loop('sweepWallets', sweepWallets, async () => (await Settings.getSingleton()).sweepIntervalMs || 5 * 60_000);

    console.log(`🔁 Background jobs started (poll every ${settings.pollIntervalMs}ms)`);
}