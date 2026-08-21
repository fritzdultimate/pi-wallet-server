// routes/health.js
import express from 'express';
import { scoreFunderWallets } from '../services/walletHealth.js';
import Wallet from '../models/Wallet.js';

const router = express.Router();

router.get('/funders', async (req, res) => {
    res.json(await scoreFunderWallets());
});

router.get('/flags', async (req, res) => {
    const flagged = await Wallet.find({ flagged: true });
    res.json(flagged);
});

export default router;
