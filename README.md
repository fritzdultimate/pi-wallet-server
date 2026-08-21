# pi-wallet-server

A personal, single-owner Pi/Stellar wallet manager backend. It only ever manages wallets
you add yourself, encrypts recovery phrases at rest, and never accepts a mnemonic or a
payout address from an unauthenticated caller.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Install and start MongoDB locally (this is a normal, unrestricted install on your own
   machine - e.g. `sudo apt install mongodb-org` on Ubuntu/Debian, `brew install mongodb-community`
   on macOS, or run it via Docker: `docker run -d -p 27017:27017 mongo`).

3. Copy `.env.example` to `.env` and fill in the generated values:
   ```
   cp .env.example .env
   node -e "console.log('MASTER_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
   node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
   node -e "console.log('OWNER_PASSWORD_HASH=' + require('bcryptjs').hashSync('choose-a-real-password', 12))"
   ```
   Paste each generated value into the matching line in `.env`. Set `DEFAULT_DESTINATION_ADDRESS`
   to your own Pi wallet address (optional - you can also set the destination later from
   the dashboard's Settings page).

4. Start the server:
   ```
   npm start
   ```
   You should see `✅ Connected to MongoDB` and `🚀 pi-wallet-server running on port 3000`.

## What's deliberately NOT here

- No proxy/IP-rotation logic - this talks to Horizon directly, as itself.
- No route that accepts a mnemonic or destination address from an unauthenticated caller.
- No settings flag that suppresses logging or redirects a payout away from what you configured.
- No multi-tenant fields (`name`, per-request `receiverAddress`, etc.) - this is single-owner by design.

## API surface

All routes under `/api/*` except `/api/auth/login` require `Authorization: Bearer <token>`,
obtained by POSTing your password to `/api/auth/login`.

- `wallets` - add/list/remove wallets, refresh balance
- `claims` - view discovered/claimed claimable balances
- `payments/quote`, `payments/send` - the "Send Pi" feature
- `settings` - destination address, fee buffer, poll interval, etc.
- `backup` - password-protected encrypted key export
- `cosign`, `cosign/submit` - on-demand co-signing
- `health/funders`, `health/flags` - funder wallet health scoring and red-flag detection
- `logs` - full audit trail
