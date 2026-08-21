// server.js
//
// Personal, single-owner Pi/Stellar wallet manager. Every route below except
// /api/auth/login requires a valid JWT for the one owner of this deployment - see
// middleware/auth.js. There is no route anywhere that accepts a mnemonic or a payout
// address from an unauthenticated caller.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { assertEnv } from './config/env.js';
import { connectToDB } from './db.js';
import { requireAuth } from './middleware/auth.js';
import { startJobs } from './jobs/index.js';

import authRoutes from './routes/auth.js';
import walletRoutes from './routes/wallets.js';
import claimRoutes from './routes/claims.js';
import settingsRoutes from './routes/settings.js';
import logRoutes from './routes/logs.js';
import backupRoutes from './routes/backup.js';
import cosignRoutes from './routes/cosign.js';
import paymentRoutes from './routes/payments.js';
import healthRoutes from './routes/health.js';

assertEnv();

process.on('unhandledRejection', (reason) => console.error('🛑 Unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('🛑 Uncaught exception:', err));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({
    origin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(','),
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.get('/', (req, res) => {
    res.send('🔁 pi-wallet-server is running - ' + new Date().toLocaleString());
});

app.use('/api/auth', authRoutes);

// Everything below this line requires the owner's JWT.
app.use('/api/wallets', requireAuth, walletRoutes);
app.use('/api/claims', requireAuth, claimRoutes);
app.use('/api/settings', requireAuth, settingsRoutes);
app.use('/api/logs', requireAuth, logRoutes);
app.use('/api/backup', requireAuth, backupRoutes);
app.use('/api/cosign', requireAuth, cosignRoutes);
app.use('/api/payments', requireAuth, paymentRoutes);
app.use('/api/health', requireAuth, healthRoutes);

await connectToDB();
await startJobs();

app.listen(PORT, () => {
    console.log(`🚀 pi-wallet-server running on port ${PORT}`);
});
