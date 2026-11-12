
const express = require('express');
const mongoose = require('mongoose');
const auth = require('./auth');

const router = express.Router();

/*
 * CoinWave admin settings.
 * Reuses the existing Setting model if already registered.
 */
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

/*
 * Deposit-address permissions.
 *
 * This depends on the updated auth.js exporting:
 * auth.requirePermission()
 *
 * Super Admin: allowed
 * Finance Admin: allowed
 * Support Admin: denied
 * Customer: denied
 */
const addressesPermission = auth.requirePermission(
  'addresses.manage'
);

/*
 * GET /api/admin/addresses
 *
 * Retrieve all configured deposit addresses.
 */
router.get(
  '/addresses',
  addressesPermission,
  asyncHandler(async (req, res) => {
    const doc = await Setting.findOne({
      key: 'addresses'
    }).lean();

    const addresses =
      doc &&
      doc.value &&
      typeof doc.value === 'object' &&
      !Array.isArray(doc.value)
        ? doc.value
        : {};

    return res.json(addresses);
  })
);

/*
 * PUT /api/admin/addresses/:symbol
 *
 * Create or update a deposit address.
 */
router.put(
  '/addresses/:symbol',
  addressesPermission,
  asyncHandler(async (req, res) => {
    const sym = String(req.params.symbol || '')
      .trim()
      .toUpperCase();

    const body = req.body || {};

    const address = String(body.address || '').trim();
    const network = String(body.network || '')
      .trim()
      .slice(0, 40);

    const memo = String(body.memo || '')
      .trim()
      .slice(0, 80);

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
      {
        key: 'addresses'
      },
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

    return res.json(entry);
  })
);

/*
 * DELETE /api/admin/addresses/:symbol
 *
 * Delete a configured deposit address.
 */
router.delete(
  '/addresses/:symbol',
  addressesPermission,
  asyncHandler(async (req, res) => {
    const sym = String(req.params.symbol || '')
      .trim()
      .toUpperCase();

    if (!SYMBOL.test(sym)) {
      return res.status(400).json({
        error: 'Invalid coin symbol.'
      });
    }

    await Setting.findOneAndUpdate(
      {
        key: 'addresses'
      },
      {
        $unset: {
          ['value.' + sym]: ''
        }
      },
      {
        runValidators: true
      }
    );

    return res.json({
      ok: true
    });
  })
);

/*
 * Centralized error handling.
 */
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

  if (err && err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'The submitted setting is invalid.'
    });
  }

  res.status(500).json({
    error: 'An unexpected server error occurred.'
  });
});

module.exports = router;
