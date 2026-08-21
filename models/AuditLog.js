// models/AuditLog.js
//
// Every action this server takes with a wallet gets a row here, unconditionally. There
// is no settings flag, no "if (!settings.something)" branch, that suppresses writes to
// this collection - that's a deliberate design choice, not an oversight.

import mongoose from 'mongoose';

const AuditLogSchema = new mongoose.Schema({
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet' },
    action: { type: String, required: true },
    detail: String,
    level: { type: String, enum: ['info', 'warn', 'error'], default: 'info' },
    createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('AuditLog', AuditLogSchema);
