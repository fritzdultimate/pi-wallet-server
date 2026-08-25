// routes/settings.js
import express from 'express';
import Settings from '../models/Settings.js';

const router = express.Router();

router.get('/', async (req, res) => {
    const settings = await Settings.getSingleton();
    res.json(settings);
});

router.put('/', async (req, res) => {
    const allowed = [
        'destinationAddress', 'feeMode', 'extraFee', 'fixedFeePi', 'pollIntervalMs',
        'maxConcurrency', 'minFunderBalance', 'maxConcurrentClaims', 'claimSponsorFanout',
        'funderPrefundEnabled', 'funderLeadTimeMinutes',
        'sweepEnabled', 'sweepIntervalMs', 'sweepBatchSize', 'sweepReserveMinimum',
        'telegramAlertsEnabled',
    ];
    const updates = {};
    for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const settings = await Settings.getSingleton();
    Object.assign(settings, updates);
    await settings.save();

    res.json(settings);
});

export default router;