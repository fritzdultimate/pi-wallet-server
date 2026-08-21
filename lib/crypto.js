// lib/crypto.js
//
// At-rest encryption for wallet mnemonics using AES-256-GCM.
//
// Design intent: a mnemonic is never stored in plaintext in the database, and is only
// ever decrypted in-memory for the duration of a signing operation. The key comes from
// MASTER_KEY (an env var you generate and keep outside of any database backup) - so a
// stolen DB dump alone is not enough to recover usable seed phrases.

import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended for GCM

function getKey() {
    const hex = process.env.MASTER_KEY;
    if (!hex || hex.length !== 64) {
        throw new Error(
            'MASTER_KEY is missing or not a 32-byte hex string (64 hex chars). ' +
            "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
        );
    }
    return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string (e.g. a mnemonic). Returns a single string safe to store
 * in the database: "iv:authTag:ciphertext", all hex-encoded.
 */
export function encryptSecret(plaintext) {
    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGO, key, iv);

    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

/**
 * Decrypt a string produced by encryptSecret(). Throws if the ciphertext was tampered
 * with or the wrong key is used (GCM auth tag check fails).
 */
export function decryptSecret(stored) {
    const key = getKey();
    const [ivHex, authTagHex, ciphertextHex] = String(stored).split(':');
    if (!ivHex || !authTagHex || !ciphertextHex) {
        throw new Error('Malformed encrypted value');
    }

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
}

/**
 * Encrypt an arbitrary export payload (used for the "download backup" feature) with a
 * one-time password the user supplies at download time, rather than MASTER_KEY. Uses
 * scrypt to derive a key from the password so the export is self-contained and can be
 * decrypted later without access to this server's MASTER_KEY.
 */
export function encryptWithPassword(plaintextJson, password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, 32);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGO, key, iv);

    const ciphertext = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
        salt: salt.toString('hex'),
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        ciphertext: ciphertext.toString('hex'),
        algo: ALGO,
        kdf: 'scrypt',
    };
}

export function decryptWithPassword({ salt, iv, authTag, ciphertext }, password) {
    const key = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32);
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));

    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'hex')),
        decipher.final(),
    ]);
    return plaintext.toString('utf8');
}
