// config/env.js
//
// Fail fast and loudly if required configuration is missing, instead of limping along
// with undefined values (which is how secrets end up silently defaulting to something
// unsafe, or hardcoded, or shared).

const REQUIRED = [
    'MONGODB_URI',
    'OWNER_PASSWORD_HASH',
    'JWT_SECRET',
    'MASTER_KEY',
    'HORIZON_URL',
    'NETWORK_PASSPHRASE',
];

export function assertEnv() {
    const missing = REQUIRED.filter((key) => !process.env[key]);
    if (missing.length) {
        console.error(
            `❌ Missing required environment variables: ${missing.join(', ')}\n` +
            'Copy .env.example to .env and fill these in before starting the server.'
        );
        process.exit(1);
    }

    if (process.env.MASTER_KEY.length !== 64) {
        console.error('❌ MASTER_KEY must be a 32-byte hex string (64 hex characters).');
        process.exit(1);
    }
}
