'use strict';

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const router = express.Router();

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 10;

// --------------------------------------------------
// USER MODEL
// --------------------------------------------------

const User = mongoose.models.User || mongoose.model(
  'User',
  new mongoose.Schema({
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254
    },

    passwordHash: {
      type: String,
      required: true
    },

    country: {
      type: String,
      uppercase: true,
      trim: true,
      maxlength: 2
    },

    phone: {
      type: String,
      trim: true,
      maxlength: 20
    },

    currency: {
      type: String,
      uppercase: true,
      trim: true,
      maxlength: 3
    },

    termsAcceptedAt: {
      type: Date
    },

    privacyAcceptedAt: {
      type: Date
    },

    accountStatus: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
      index: true
    },

    suspensionReason: {
      type: String,
      default: '',
      maxlength: 500
    },

    suspendedAt: {
      type: Date,
      default: null
    },

    lastLoginAt: {
      type: Date,
      default: null
    },

    createdAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  })
);

// --------------------------------------------------
// ADMIN ROLE CONFIGURATION
// --------------------------------------------------

function emailList(environmentVariable) {
  return String(process.env[environmentVariable] || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

function getRole(user) {
  if (!user || !user.email) return 'customer';

  const email = String(user.email).trim().toLowerCase();

  const superAdmins = [
    ...emailList('ADMIN_EMAIL'),
    ...emailList('SUPER_ADMIN_EMAIL')
  ];

  if (superAdmins.includes(email)) {
    return 'super_admin';
  }

  if (emailList('FINANCE_ADMIN_EMAIL').includes(email)) {
    return 'finance_admin';
  }

  if (emailList('SUPPORT_ADMIN_EMAIL').includes(email)) {
    return 'support_admin';
  }

  return 'customer';
}

const ROLE_PERMISSIONS = {
  super_admin: ['*'],

  finance_admin: [
    'dashboard.view',
    'customers.view',
    'orders.view',
    'orders.manage',
    'wallets.view',
    'deposits.view',
    'deposits.manage',
    'withdrawals.view',
    'withdrawals.manage',
    'addresses.manage',
    'payments.manage',
    'ledger.view',
    'fees.manage',
    'reports.finance',
    'assets.view'
  ],

  support_admin: [
    'dashboard.view',
    'customers.view',
    'customers.support',
    'notifications.manage',
    'chat.manage'
  ],

  customer: []
};

function hasPermission(user, permission) {
  if (!user || !permission) return false;

  const role = getRole(user);
  const permissions = ROLE_PERMISSIONS[role] || [];

  return permissions.includes('*') ||
    permissions.includes(permission);
}

function isAdmin(user) {
  return getRole(user) !== 'customer';
}

function requirePermission(permission) {
  return async function (req, res, next) {
    try {
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

      const user = await authUser(req);

      if (!user) {
        return res.status(401).json({
          error: 'Not logged in.'
        });
      }

      if (user.accountStatus === 'suspended') {
        return res.status(403).json({
          error: 'This account is suspended. Contact support.'
        });
      }

      if (!hasPermission(user, permission)) {
        return res.status(403).json({
          error: 'You do not have permission to perform this action.'
        });
      }

      req.user = user;
      next();

    } catch (error) {
      console.error('Permission check error:', error.message);

      return res.status(500).json({
        error: 'Could not verify your permissions.'
      });
    }
  };
}

// --------------------------------------------------
// RATE LIMITING
// --------------------------------------------------

const hits = new Map();

function limit(req, res, next) {
  const now = Date.now();
  const key = String(req.ip || 'unknown') + ':' + req.path;

  const recent = (hits.get(key) || []).filter(
    timestamp => now - timestamp < RATE_WINDOW_MS
  );

  if (recent.length >= RATE_MAX) {
    return res.status(429).json({
      error: 'Too many attempts. Try again in 15 minutes.'
    });
  }

  recent.push(now);
  hits.set(key, recent);

  if (hits.size > 10000) {
    for (const [storedKey, timestamps] of hits) {
      const active = timestamps.filter(
        timestamp => now - timestamp < RATE_WINDOW_MS
      );

      if (active.length) {
        hits.set(storedKey, active);
      } else {
        hits.delete(storedKey);
      }
    }
  }

  next();
}

// --------------------------------------------------
// SERVER READINESS
// --------------------------------------------------

function ready(req, res, next) {
  if (!process.env.JWT_SECRET ||
      String(process.env.JWT_SECRET).length < 32) {
    return res.status(500).json({
      error: 'Server security configuration is incomplete.'
    });
  }

  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: 'Service is starting. Try again in a moment.'
    });
  }

  next();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(email) {
  return email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isSecureRequest(req) {
  return Boolean(
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase() === 'https'
  );
}

// --------------------------------------------------
// SECURE SESSION COOKIE
// --------------------------------------------------

function setSession(req, res, user) {
  const token = jwt.sign(
    { id: String(user._id) },
    process.env.JWT_SECRET,
    {
      expiresIn: SESSION_SECONDS,
      algorithm: 'HS256'
    }
  );

  const cookie = [
    'cw_token=' + token,
    'HttpOnly',
    'Path=/',
    'Max-Age=' + SESSION_SECONDS,
    'SameSite=Lax'
  ];

  if (isSecureRequest(req)) {
    cookie.push('Secure');
  }

  res.setHeader('Set-Cookie', cookie.join('; '));
}

function clearSession(req, res) {
  const cookie = [
    'cw_token=',
    'HttpOnly',
    'Path=/',
    'Max-Age=0',
    'SameSite=Lax'
  ];

  if (isSecureRequest(req)) {
    cookie.push('Secure');
  }

  res.setHeader('Set-Cookie', cookie.join('; '));
}

function readToken(req) {
  const cookies = String(req.headers.cookie || '');
  const match = cookies.match(/(?:^|;\s*)cw_token=([^;]+)/);

  return match ? match[1] : null;
}

// --------------------------------------------------
// AUTHENTICATED USER
// --------------------------------------------------

async function authUser(req) {
  const token = readToken(req);

  if (!token || !process.env.JWT_SECRET) {
    return null;
  }

  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET,
      { algorithms: ['HS256'] }
    );

    if (!payload || !payload.id ||
        !mongoose.Types.ObjectId.isValid(payload.id)) {
      return null;
    }

    return await User.findById(payload.id);

  } catch (error) {
    return null;
  }
}

// --------------------------------------------------
// PUBLIC USER DATA
// --------------------------------------------------

function publicUser(user) {
  const role = getRole(user);

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    country: user.country || '',
    phone: user.phone || '',
    currency: user.currency || '',
    createdAt: user.createdAt,
    accountStatus: user.accountStatus || 'active',
    isAdmin: role !== 'customer',
    role: role
  };
}

const DUMMY = bcrypt.hashSync(
  'not-a-real-password',
  10
);

// --------------------------------------------------
// SIGN UP
// --------------------------------------------------

router.post('/signup', limit, ready, async (req, res) => {
  try {
    const body = req.body || {};

    const name = String(body.name || '').trim();
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');

    if (!name || name.length > 80) {
      return res.status(400).json({
        error: 'Enter a name of up to 80 characters.'
      });
    }

    if (!validEmail(email)) {
      return res.status(400).json({
        error: 'Enter a valid email address.'
      });
    }

    const country = String(body.country || '')
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{2}$/.test(country)) {
      return res.status(400).json({
        error: 'Select your country or region.'
      });
    }

    const rawPhone = String(body.phone || '').trim();
    const phone = rawPhone.replace(/[^\d+]/g, '');

    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      return res.status(400).json({
        error: 'Enter a valid phone number with its country dialing code.'
      });
    }

    const currency = String(body.currency || '')
      .trim()
      .toUpperCase();

    if (currency && !/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({
        error: 'The selected account currency is invalid. Please select your country again.'
      });
    }

    // bcrypt only uses the first 72 UTF-8 bytes.
    if (
      password.length < 8 ||
      password.length > 128 ||
      Buffer.byteLength(password, 'utf8') > 72 ||
      !/[A-Za-z]/.test(password) ||
      !/\d/.test(password)
    ) {
      return res.status(400).json({
        error: 'Password needs 8 to 128 characters, no more than 72 UTF-8 bytes, and must contain a letter and a number.'
      });
    }

    if (body.terms !== true) {
      return res.status(400).json({
        error: 'Accept the Terms of Service and Privacy Policy to continue.'
      });
    }

    const existing = await User.findOne({ email }).select('_id');

    if (existing) {
      return res.status(409).json({
        error: 'An account with this email already exists.'
      });
    }

    const now = new Date();

    const user = await User.create({
      name,
      email,
      country,
      phone,
      currency,
      termsAcceptedAt: now,
      privacyAcceptedAt: now,
      accountStatus: 'active',
      passwordHash: await bcrypt.hash(password, 12)
    });

    setSession(req, res, user);

    return res.status(201).json(publicUser(user));

  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: 'An account with this email already exists.'
      });
    }

    console.error('Signup error:', error.message);

    return res.status(500).json({
      error: 'Could not create the account. Try again.'
    });
  }
});

// --------------------------------------------------
// LOGIN
// --------------------------------------------------

router.post('/login', limit, ready, async (req, res) => {
  try {
    const body = req.body || {};

    const email = normalizeEmail(body.email);
    const password = String(body.password || '');

    if (!validEmail(email) || password.length > 128) {
      await bcrypt.compare(password.slice(0, 128), DUMMY);

      return res.status(401).json({
        error: 'Incorrect email or password.'
      });
    }

    const user = await User.findOne({ email });

    const passwordMatches = await bcrypt.compare(
      password,
      user ? user.passwordHash : DUMMY
    );

    if (!user || !passwordMatches) {
      return res.status(401).json({
        error: 'Incorrect email or password.'
      });
    }

    if (user.accountStatus === 'suspended') {
      return res.status(403).json({
        error: 'This account is suspended. Contact support.'
      });
    }

    user.lastLoginAt = new Date();
    await user.save();

    setSession(req, res, user);

    return res.json(publicUser(user));

  } catch (error) {
    console.error('Login error:', error.message);

    return res.status(500).json({
      error: 'Could not log in. Try again.'
    });
  }
});

// --------------------------------------------------
// LOGOUT
// --------------------------------------------------

router.post('/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

// --------------------------------------------------
// CURRENT CUSTOMER
// --------------------------------------------------

router.get('/me', ready, async (req, res) => {
  try {
    const user = await authUser(req);

    if (!user) {
      return res.status(401).json({
        error: 'Not logged in.'
      });
    }

    if (user.accountStatus === 'suspended') {
      clearSession(req, res);

      return res.status(403).json({
        error: 'This account is suspended. Contact support.'
      });
    }

    return res.json(publicUser(user));

  } catch (error) {
    console.error('Current user error:', error.message);

    return res.status(500).json({
      error: 'Could not load your account.'
    });
  }
});

// --------------------------------------------------
// ADMIN REGISTRATION STATISTICS
// --------------------------------------------------

router.get(
  '/admin/stats',
  ready,
  requirePermission('dashboard.view'),
  async (req, res) => {
    try {
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

      return res.json({
        total,
        today,
        week
      });

    } catch (error) {
      console.error('Admin stats error:', error.message);

      return res.status(500).json({
        error: 'Could not load stats.'
      });
    }
  }
);

// --------------------------------------------------
// EXPORTS FOR OTHER COINWAVE ROUTERS
// --------------------------------------------------

router.authUser = authUser;
router.isAdmin = isAdmin;
router.getRole = getRole;
router.hasPermission = hasPermission;
router.requirePermission = requirePermission;
router.publicUser = publicUser;
router.User = User;

// Shared role/permission metadata.
router.ROLE_PERMISSIONS = ROLE_PERMISSIONS;

module.exports = router;