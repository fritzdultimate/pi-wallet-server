// middleware/auth.js
//
// Every route except /api/auth/login requires a valid JWT issued to the single owner.
// There is no shared hardcoded password anywhere in source - see routes/auth.js.

import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: 'Missing bearer token' });
    }

    try {
        req.owner = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}
