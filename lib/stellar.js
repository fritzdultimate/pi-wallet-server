// lib/stellar.js
//
// All direct network I/O against the Pi Network Horizon API lives here. Deliberately
// no proxy/IP-rotation logic - this is a personal tool talking to Horizon as itself,
// not something trying to look like many different users.

import axios from 'axios';
import bip39 from 'bip39';
import ed25519 from 'ed25519-hd-key';
import {
    Keypair,
    TransactionBuilder,
    Operation,
    Asset,
    Account,
    Memo,
} from 'stellar-base';

const DERIVATION_PATH = "m/44'/314159'/0'"; // standard Pi Network derivation path

function horizonUrl() {
    const url = process.env.HORIZON_URL;
    if (!url) throw new Error('HORIZON_URL is not set.');
    return url;
}

function networkPassphrase() {
    return process.env.NETWORK_PASSPHRASE || 'Pi Network';
}

/** Derive a Stellar/Pi keypair from a BIP-39 mnemonic. Never logged, never persisted. */
export function getKeypairFromMnemonic(mnemonic) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const derived = ed25519.derivePath(DERIVATION_PATH, seed);
    return Keypair.fromRawEd25519Seed(derived.key);
}

/** Build a keypair directly from a raw Stellar/Pi secret key (starts with "S"). */
export function getKeypairFromSecret(secretKey) {
    return Keypair.fromSecret(secretKey.trim());
}

/**
 * Detect whether a pasted-in credential is a 24-word mnemonic or a raw secret key, and
 * return the matching keypair. Used by routes/wallets.js when adding a wallet, and by
 * anything that needs to turn a stored (decrypted) credential back into a keypair.
 */
export function getKeypairFromCredential(credential, credentialType) {
    if (credentialType === 'secret') {
        return getKeypairFromSecret(credential);
    }
    return getKeypairFromMnemonic(credential);
}

/** 'secret' if this looks like a raw Stellar secret key, else 'mnemonic'. */
export function detectCredentialType(credential) {
    const trimmed = credential.trim();
    return /^S[A-Z0-9]{55}$/.test(trimmed) ? 'secret' : 'mnemonic';
}

export async function getAccount(publicKey) {
    const res = await axios.get(`${horizonUrl()}/accounts/${publicKey}`, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15_000,
    });
    return res.data;
}

export async function getClaimableBalancesFor(publicKey) {
    const res = await axios.get(`${horizonUrl()}/claimable_balances`, {
        params: { claimant: publicKey, limit: 200 },
        timeout: 15_000,
    });
    return res.data?._embedded?.records ?? [];
}

export async function getRecentOperations(publicKey, limit = 10) {
    const res = await axios.get(`${horizonUrl()}/accounts/${publicKey}/operations`, {
        params: { limit, order: 'desc' },
        timeout: 15_000,
    });
    return res.data?._embedded?.records ?? [];
}

let cachedFee = null;
let cachedFeeAt = 0;
const FEE_CACHE_TTL_MS = 10_000;

export async function getBaseFeeStroops() {
    const now = Date.now();
    if (cachedFee && now - cachedFeeAt < FEE_CACHE_TTL_MS) return cachedFee;

    try {
        const res = await axios.get(`${horizonUrl()}/fee_stats`, { timeout: 10_000 });
        cachedFee = Number(res.data?.fee_charged?.max || 100_000);
        cachedFeeAt = now;
        return cachedFee;
    } catch {
        return 100_000; // conservative fallback, in stroops
    }
}

export function getNativeBalance(accountData) {
    const entry = (accountData?.balances || []).find((b) => b.asset_type === 'native');
    return entry ? parseFloat(entry.balance) : 0;
}

/** Extract the claimant predicate's "claimable at" time for a given public key, if any. */
export function findClaimableAt(record, publicKey) {
    const claimant = (record.claimants || []).find((c) => c.destination === publicKey);
    const abs = claimant?.predicate?.not?.abs_before;
    return abs ? new Date(abs) : null;
}

/**
 * Resolve the fee to charge PER OPERATION, in stroops - this is the unit stellar-base's
 * TransactionBuilder expects for its `fee` option; it multiplies this value by the
 * transaction's operation count internally (verified against stellar-base's source -
 * transaction_builder.js does `baseFee.times(this.operations.length)`). Every caller
 * below must pass a per-operation value, never something already multiplied out.
 *
 * feeMode 'auto'  - live Horizon base fee + settings.extraFee buffer.
 * feeMode 'fixed' - ignore the live network fee entirely; always settings.fixedFeePi.
 *                   This is the manual override / "spike it yourself" knob.
 */
export async function resolveFeePerOperationStroops({ feeMode, extraFeePi = 0, fixedFeePi = 0 }) {
    if (feeMode === 'fixed') {
        return Math.round(fixedFeePi * 10_000_000);
    }
    const baseFee = await getBaseFeeStroops();
    return baseFee + Math.round(extraFeePi * 10_000_000);
}

/**
 * Build + sign a transaction that claims a claimable balance on `mainKp`'s account and
 * immediately forwards the claimed amount to `destination`. `funderKp` pays the network
 * fee (as the transaction source) since a freshly-claiming account may not hold enough
 * balance to cover fees itself. destination is always a value YOU provide - see
 * services/claimScheduler.js, which resolves it from Settings, never from a request body.
 *
 * `feePerOperationStroops` comes from resolveFeePerOperationStroops() above - it is
 * PER OPERATION; stellar-base multiplies it by the operation count (2, here) itself.
 */
export async function buildClaimAndForwardTx({ mainKp, funderKp, balanceId, destination, amount, feePerOperationStroops }) {
    const funderAccountData = await getAccount(funderKp.publicKey());
    const funderAccount = new Account(funderKp.publicKey(), funderAccountData.sequence);

    const tx = new TransactionBuilder(funderAccount, {
        fee: feePerOperationStroops.toString(),
        networkPassphrase: networkPassphrase(),
    })
        .addOperation(Operation.claimClaimableBalance({
            balanceId,
            source: mainKp.publicKey(),
        }))
        .addOperation(Operation.payment({
            destination,
            asset: Asset.native(),
            amount,
            source: mainKp.publicKey(),
        }))
        .addMemo(Memo.text('pi-wallet-manager'))
        .setTimeout(30)
        .build();

    tx.sign(funderKp);
    tx.sign(mainKp);

    return tx.toXDR();
}

/**
 * Build + sign a plain wallet-to-wallet payment ("Send Pi"). `fromKp` pays its own fee.
 * `feePerOperationStroops` comes from resolveFeePerOperationStroops() - this tx has a
 * single operation, so the per-operation and total fee are the same number here, but we
 * still pass it as "per operation" for consistency with buildClaimAndForwardTx.
 */
export async function buildPaymentTx({ fromKp, destination, amount, feePerOperationStroops }) {
    const accountData = await getAccount(fromKp.publicKey());
    const account = new Account(fromKp.publicKey(), accountData.sequence);

    const tx = new TransactionBuilder(account, {
        fee: feePerOperationStroops.toString(),
        networkPassphrase: networkPassphrase(),
    })
        .addOperation(Operation.payment({
            destination,
            asset: Asset.native(),
            amount,
        }))
        .setTimeout(30)
        .build();

    tx.sign(fromKp);
    return tx.toXDR();
}

/**
 * Add a co-signature from `signerKp` to an existing (possibly already partially signed)
 * transaction envelope XDR, and return the updated XDR. Does not submit it - that's a
 * separate explicit step, matching the "on-demand co-signing" feature you asked for.
 */
export function coSignXdr(xdr, signerKp) {
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase());
    tx.sign(signerKp);
    return tx.toXDR();
}

/**
 * Build, sign, and return XDR for a setOptions operation that turns `ownerKp`'s own
 * account into a 2-of-2 multisig account: adds `coSignerAddress` as an additional signer
 * (weight 1) and raises low/med/high thresholds to 2. `ownerKp` signs because only an
 * account's own existing signers can authorize changing its signer list. After this,
 * moving funds from this account requires BOTH the original key AND the new co-signer's
 * key to sign - this app's automated claim/funder/sweep flows only ever sign with the
 * wallet's own stored credential, so turning this on for a "main"/"funder"/"reserve"
 * wallet will stall that wallet's automation unless you also handle the second signature
 * yourself out of band.
 *
 * One-operation transaction, so feePerOperationStroops IS the total fee here.
 */
export async function buildAddCoSignerTx({ ownerKp, coSignerAddress, feePerOperationStroops }) {
    const accountData = await getAccount(ownerKp.publicKey());
    const account = new Account(ownerKp.publicKey(), accountData.sequence);

    const tx = new TransactionBuilder(account, {
        fee: feePerOperationStroops.toString(),
        networkPassphrase: networkPassphrase(),
    })
        .addOperation(Operation.setOptions({
            signer: { ed25519PublicKey: coSignerAddress, weight: 1 },
            masterWeight: 1,
            lowThreshold: 2,
            medThreshold: 2,
            highThreshold: 2,
        }))
        .setTimeout(30)
        .build();

    tx.sign(ownerKp);
    return tx.toXDR();
}

export async function submitTransaction(xdr) {
    try {
        const res = await axios.post(
            `${horizonUrl()}/transactions`,
            `tx=${encodeURIComponent(xdr)}`,
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 20_000,
            }
        );
        return { success: true, ...res.data };
    } catch (err) {
        const data = err.response?.data;
        return {
            success: false,
            reason: data?.extras?.result_codes,
            resultXdr: data?.extras?.result_xdr,
            message: data?.detail || err.message,
        };
    }
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}