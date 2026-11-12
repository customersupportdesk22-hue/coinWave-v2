
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const router = express.Router();

const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  country: { type: String, uppercase: true, trim: true },
  phone: { type: String, trim: true, maxlength: 20 },
  currency: { type: String, uppercase: true, trim: true, maxlength: 3 },
  termsAcceptedAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
}));

const hits = new Map();

function limit(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter(
    t => now - t < 15 * 60 * 1000
  );

  if (recent.length >= 10) {
    return res.status(429).json({
      error: 'Too many attempts. Try again in 15 minutes.'
    });
  }

  recent.push(now);
  hits.set(req.ip, recent);
  next();
}

function ready(req, res, next) {
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({
      error: 'Server is not configured.'
    });
  }

  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: 'Service is starting. Try again in a moment.'
    });
  }

  next();
}

function setSession(req, res, user) {
  const token = jwt.sign(
    { id: user._id },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.setHeader(
    'Set-Cookie',
    'cw_token=' + token +
    '; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax' +
    (req.secure ? '; Secure' : '')
  );
}

function readToken(req) {
  const match = (req.headers.cookie || '').match(
    /(?:^|;\s*)cw_token=([^;]+)/
  );

  return match ? match[1] : null;
}

const adminEmails = () => (process.env.ADMIN_EMAIL || '')
  .split(',')
  .map(email => email.trim().toLowerCase())
  .filter(Boolean);

const isAdmin = user => adminEmails().includes(user.email);

const publicUser = user => ({
  id: user._id,
  name: user.name,
  email: user.email,
  country: user.country || '',
  phone: user.phone || '',
  currency: user.currency || '',
  createdAt: user.createdAt,
  isAdmin: isAdmin(user)
});

async function authUser(req) {
  const token = readToken(req);
  if (!token) return null;

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return await User.findById(payload.id);
  } catch (e) {
    return null;
  }
}

const DUMMY = bcrypt.hashSync('not-a-real-password', 10);

// SIGN UP
router.post('/signup', limit, ready, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!name) {
      return res.status(400).json({
        error: 'Enter your name.'
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: 'Enter a valid email address.'
      });
    }

    const country = String(req.body.country || '')
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{2}$/.test(country)) {
      return res.status(400).json({
        error: 'Select your country or region.'
      });
    }

    const rawPhone = String(req.body.phone || '').trim();
    const phone = rawPhone.replace(/[^\d+]/g, '');

    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      return res.status(400).json({
        error: 'Enter a valid phone number with its country dialing code.'
      });
    }

    const currency = String(req.body.currency || '')
      .trim()
      .toUpperCase();

    if (currency && !/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({
        error: 'The selected account currency is invalid. Please select your country again.'
      });
    }

    if (
      password.length < 8 ||
      !/[A-Za-z]/.test(password) ||
      !/\d/.test(password)
    ) {
      return res.status(400).json({
        error: 'Password needs 8+ characters with a letter and a number.'
      });
    }

    if (req.body.terms !== true) {
      return res.status(400).json({
        error: 'Accept the Terms of Service and Privacy Policy to continue.'
      });
    }

    const user = await User.create({
      name,
      email,
      country,
      phone,
      currency,
      termsAcceptedAt: new Date(),
      passwordHash: await bcrypt.hash(password, 12)
    });

    setSession(req, res, user);

    return res.status(201).json(publicUser(user));

  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json({
        error: 'An account with this email already exists.'
      });
    }

    console.error('Signup error:', e.message);

    return res.status(500).json({
      error: 'Could not create the account. Try again.'
    });
  }
});

// LOGIN
router.post('/login', limit, ready, async (req, res) => {
  try {
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();

    const password = String(req.body.password || '');
    const user = await User.findOne({ email });

    const ok = await bcrypt.compare(
      password,
      user ? user.passwordHash : DUMMY
    );

    if (!user || !ok) {
      return res.status(401).json({
        error: 'Incorrect email or password.'
      });
    }

    setSession(req, res, user);
    return res.json(publicUser(user));

  } catch (e) {
    console.error('Login error:', e.message);

    return res.status(500).json({
      error: 'Could not log in. Try again.'
    });
  }
});

// LOGOUT
router.post('/logout', (req, res) => {
  res.setHeader(
    'Set-Cookie',
    'cw_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax'
  );

  res.json({ ok: true });
});

// CURRENT CUSTOMER
router.get('/me', ready, async (req, res) => {
  try {
    const token = readToken(req);

    if (!token) {
      return res.status(401).json({
        error: 'Not logged in.'
      });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.id);

    if (!user) {
      return res.status(401).json({
        error: 'Not logged in.'
      });
    }

    return res.json(publicUser(user));

  } catch (e) {
    return res.status(401).json({
      error: 'Not logged in.'
    });
  }
});

// ADMIN REGISTRATION STATISTICS
router.get('/admin/stats', ready, async (req, res) => {
  try {
    const user = await authUser(req);

    if (!user) {
      return res.status(401).json({
        error: 'Not logged in.'
      });
    }

    if (!isAdmin(user)) {
      return res.status(403).json({
        error: 'You do not have access to this page.'
      });
    }

    const now = Date.now();
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const [total, today, week] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({
        createdAt: { $gte: startOfDay }
      }),
      User.countDocuments({
        createdAt: {
          $gte: new Date(now - 7 * 24 * 60 * 60 * 1000)
        }
      })
    ]);

    res.json({ total, today, week });

  } catch (e) {
    console.error('Admin stats error:', e.message);

    res.status(500).json({
      error: 'Could not load stats.'
    });
  }
});

router.authUser = authUser;
router.isAdmin = isAdmin;

module.exports = router;
