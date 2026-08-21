// routes/cosign.js
//
// Turns a wallet into a 2-of-2 multisig account in one step: paste the mnemonic (or
// secret key) of the wallet you want to protect, plus the public key of the co-signer
// you want to add, and this builds + signs + submits the setOptions transaction on the
// spot. No pre-built XDR required from you - the server builds it.
//
// The credential you paste here is used transiently, in memory, to sign this one
// transaction, and is never stored. It is not the same thing as adding a wallet on the
// Wallets page - this endpoint intentionally does not touch the Wallet collection.

import express from 'express';
import AuditLog from '../models/AuditLog.js';
import Settings from '../models/Settings.js';
import {
    getKeypairFromCredential,
    detectCredentialType,
    resolveFeePerOperationStroops,
    buildAddCoSignerTx,
    submitTransaction,
} from '../lib/stellar.js';

const router = express.Router();

router.post('/add-signer', async (req, res) => {
    const { mnemonic, secretKey, credentialType: explicitType, coSignerAddress } = req.body;
    const rawCredential = secretKey || mnemonic;

    if (!rawCredential) return res.status(400).json({ error: 'mnemonic or secretKey is required' });
    if (!coSignerAddress) return res.status(400).json({ error: 'coSignerAddress is required' });

    const trimmedCoSigner = coSignerAddress.trim();
    if (!/^G[A-Z0-9]{55}$/.test(trimmedCoSigner)) {
        return res.status(400).json({
            error: 'That doesn\'t look like a valid public key - it should be exactly 56 characters and start with "G".',
        });
    }

    const credentialType = explicitType || (secretKey ? 'secret' : detectCredentialType(rawCredential));
    const credential = credentialType === 'secret'
        ? rawCredential.trim().toUpperCase()
        : rawCredential.trim();

    let ownerKp;
    try {
        ownerKp = getKeypairFromCredential(credential, credentialType);
    } catch (err) {
        const hint = credentialType === 'secret'
            ? 'That doesn\'t look like a valid secret key - it should be exactly 56 characters and start with "S".'
            : 'That doesn\'t look like a valid 24-word recovery phrase.';
        return res.status(400).json({ error: hint, detail: err.message });
    }

    if (ownerKp.publicKey() === trimmedCoSigner) {
        return res.status(400).json({ error: 'The co-signer address must be a different account than the wallet you\'re protecting.' });
    }

    try {
        const settings = await Settings.getSingleton();
        const feePerOperationStroops = await resolveFeePerOperationStroops({
            feeMode: settings.feeMode,
            extraFeePi: settings.extraFee,
            fixedFeePi: settings.fixedFeePi,
        });

        const xdr = await buildAddCoSignerTx({
            ownerKp,
            coSignerAddress: trimmedCoSigner,
            feePerOperationStroops,
        });

        const result = await submitTransaction(xdr);

        await AuditLog.create({
            action: result.success ? 'cosigner_added' : 'cosigner_add_failed',
            level: result.success ? 'info' : 'error',
            detail: result.success
                ? `Added co-signer ${trimmedCoSigner} to ${ownerKp.publicKey()}, now 2-of-2. Hash: ${result.hash}`
                : `Failed to add co-signer ${trimmedCoSigner} to ${ownerKp.publicKey()}: ${JSON.stringify(result.reason || result.message)}`,
        });

        if (!result.success) return res.status(422).json(result);
        res.json({ ...result, publicKey: ownerKp.publicKey() });
    } catch (err) {
        res.status(500).json({ error: 'Failed to build/submit the co-signer transaction', detail: err.message });
    }
});

export default router;