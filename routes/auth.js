// routes/auth.js
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const router = express.Router();

router.post('/login', async (req, res) => {
    const { password } = req.body;
    if (!password) {
        return res.status(400).json({ error: 'Password is required' });
    }

    const ok = await bcrypt.compare(password, process.env.OWNER_PASSWORD_HASH);
    if (!ok) {
        // Deliberately generic message + no distinction between "wrong password" and
        // "unknown user" - there's only one user.
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ sub: 'owner' }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '12h',
    });

    res.json({ token });
});

export default router;
