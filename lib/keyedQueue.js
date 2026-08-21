// lib/keyedQueue.js
//
// Chains async work by key, so calls sharing a key run strictly one-after-another while
// calls with different keys run fully concurrently. Used to let claim processing run
// concurrently across different funder wallets while never letting two transactions
// race for the same funder's sequence number at once.

const tails = new Map();

export function runSerializedByKey(key, fn) {
    const previous = tails.get(key) || Promise.resolve();
    const next = previous.then(fn, fn); // run fn regardless of whether the previous task threw
    // Keep the chain alive but don't let unhandled rejections leak - callers handle their own errors.
    tails.set(key, next.catch(() => {}));
    return next;
}