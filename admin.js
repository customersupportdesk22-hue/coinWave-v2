
const express = require('express');
const mongoose = require('mongoose');
const auth = require('./auth');

const router = express.Router();

const Setting = mongoose.models.Setting || mongoose.model(
  'Setting',
  new mongoose.Schema({
    key: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  }, {
    minimize: false
  })
);

const SYMBOL = /^[A-Z0-9]{1,15}$/;

function asyncHandler(handler) {
  return function (req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// Protect every route in this admin router.
router.use(asyncHandler(async (req, res, next) => {
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

  const user = await auth.authUser(req);

  if (!user) {
    return res.status(401).json({
      error: 'Not logged in.'
    });
  }

  if (!auth.isAdmin(user)) {
    return res.status(403).json({
      error: 'You do not have access to this page.'
    });
  }

  next();
}));

// Get all configured deposit addresses.
router.get('/addresses', asyncHandler(async (req, res) => {
  const doc = await Setting.findOne({
    key: 'addresses'
  }).lean();

  const addresses =
    doc && doc.value && typeof doc.value === 'object'
      ? doc.value
      : {};

  res.json(addresses);
}));

// Create or update a deposit address.
router.put('/addresses/:symbol', asyncHandler(async (req, res) => {
  const sym = String(req.params.symbol || '')
    .trim()
    .toUpperCase();

  const body = req.body || {};

  const address = String(body.address || '').trim();
  const network = String(body.network || '').trim().slice(0, 40);
  const memo = String(body.memo || '').trim().slice(0, 80);

  if (!SYMBOL.test(sym)) {
    return res.status(400).json({
      error: 'Invalid coin symbol.'
    });
  }

  if (
    address.length < 10 ||
    address.length > 150 ||
    !/^[A-Za-z0-9:_\-.]+$/.test(address)
  ) {
    return res.status(400).json({
      error: 'Enter a valid wallet address (10 to 150 characters, no spaces).'
    });
  }

  const entry = {
    address,
    network,
    memo,
    updatedAt: new Date()
  };

  await Setting.findOneAndUpdate(
    { key: 'addresses' },
    {
      $set: {
        ['value.' + sym]: entry
      }
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true
    }
  );

  res.json(entry);
}));

// Delete a deposit address.
router.delete('/addresses/:symbol', asyncHandler(async (req, res) => {
  const sym = String(req.params.symbol || '')
    .trim()
    .toUpperCase();

  if (!SYMBOL.test(sym)) {
    return res.status(400).json({
      error: 'Invalid coin symbol.'
    });
  }

  await Setting.findOneAndUpdate(
    { key: 'addresses' },
    {
      $unset: {
        ['value.' + sym]: ''
      }
    },
    {
      runValidators: true
    }
  );

  res.json({
    ok: true
  });
}));

// Centralized error handling for this router.
router.use((err, req, res, next) => {
  console.error('CoinWave admin API error:', err);

  if (res.headersSent) {
    return next(err);
  }

  if (err && err.code === 11000) {
    return res.status(409).json({
      error: 'This setting already exists. Please try again.'
    });
  }

  res.status(500).json({
    error: 'An unexpected server error occurred.'
  });
}));

module.exports = router;
