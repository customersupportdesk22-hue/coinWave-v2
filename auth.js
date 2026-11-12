const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const router = express.Router();

const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}));

const hits = new Map();
function limit(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter(t => now - t < 15 * 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  recent.push(now); hits.set(req.ip, recent);
  next();
}

function ready(req, res, next) {
  if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'Server is not configured.' });
  if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'Service is starting. Try again in a moment.' });
  next();
}

function setSession(req, res, user) {
  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.setHeader('Set-Cookie', 'cw_token=' + token + '; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax' + (req.secure ? '; Secure' : ''));
}

function readToken(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)cw_token=([^;]+)/);
  return m ? m[1] : null;
}

const publicUser = u => ({ id: u._id, name: u.name, email: u.email });
const DUMMY = bcrypt.hashSync('not-a-real-password', 10);

router.post('/signup', limit, ready, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!name) return res.status(400).json({ error: 'Enter your name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const user = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 12) });
    setSession(req, res, user);
    res.status(201).json(publicUser(user));
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'An account with this email already exists.' });
    console.error('Signup error:', e.message);
    res.status(500).json({ error: 'Could not create the account. Try again.' });
  }
});

router.post('/login', limit, ready, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = await User.findOne({ email });
    const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY);
    if (!user || !ok) return res.status(401).json({ error: 'Incorrect email or password.' });
    setSession(req, res, user);
    res.json(publicUser(user));
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Could not log in. Try again.' });
  }
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'cw_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

router.get('/me', ready, async (req, res) => {
  try {
    const token = readToken(req);
    if (!token) return res.status(401).json({ error: 'Not logged in.' });
    const { id } = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(id);
    if (!user) return res.status(401).json({ error: 'Not logged in.' });
    res.json(publicUser(user));
  } catch (e) {
    res.status(401).json({ error: 'Not logged in.' });
  }
});

module.exports = router;
