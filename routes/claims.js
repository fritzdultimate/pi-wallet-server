// routes/claims.js
import express from 'express';
import ClaimableBalance from '../models/ClaimableBalance.js';

const router = express.Router();

router.get('/', async (req, res) => {
    const claims = await ClaimableBalance.find()
        .populate('walletId', 'label publicKey role')
        .sort({ claimableAt: 1 });
    res.json(claims);
});

export default router;
