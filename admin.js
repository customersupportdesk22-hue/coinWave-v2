
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const auth = require('./auth');
const ledger = require('./ledger');

const router = express.Router();

// --------------------------------------------------
// MODELS
// --------------------------------------------------

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

const User = auth.User;
const Account = ledger.Account;
const LedgerTransaction = ledger.LedgerTransaction;

const SYMBOL = /^[A-Z0-9]{1,15}$/;

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function asyncHandler(handler) {
  return function (req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pagination(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(req.query.limit, 10) || 25)
  );

  return {
    page,
    limit,
    skip: (page - 1) * limit
  };
}

function safePick(document, allowedFields) {
  if (!document) return null;

  const object = typeof document.toObject === 'function'
    ? document.toObject()
    : document;

  const result = {};

  allowedFields.forEach(function (field) {
    if (Object.prototype.hasOwnProperty.call(object, field)) {
      result[field] = object[field];
    }
  });

  return result;
}

function requireModel(model, name) {
  if (!model || typeof model.find !== 'function') {
    const error = new Error(name + ' model is unavailable.');
    error.status = 503;
    throw error;
  }

  return model;
}

// --------------------------------------------------
// PERMISSIONS
// --------------------------------------------------

function permission(name) {
  if (typeof auth.requirePermission !== 'function') {
    throw new Error(
      'auth.js must export requirePermission().'
    );
  }

  return auth.requirePermission(name);
}

const addressesPermission = permission('addresses.manage');
const customersPermission = permission('customers.view');
const ledgerPermission = permission('ledger.view');

// --------------------------------------------------
// DEPOSIT ADDRESS MANAGEMENT
// --------------------------------------------------

/*
 * GET /api/admin/addresses
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
        error: 'Enter a valid wallet address.'
      });
    }

    if (!network) {
      return res.status(400).json({
        error: 'Network is required.'
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

    return res.json(entry);
  })
);

/*
 * DELETE /api/admin/addresses/:symbol
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

    return res.json({
      ok: true
    });
  })
);

// --------------------------------------------------
// CUSTOMER MANAGEMENT - READ ONLY
// --------------------------------------------------

/*
 * GET /api/admin/customers?page=1&limit=25&search=
 *
 * Returns safe customer information only.
 * Does not expose password hashes or authentication secrets.
 */
router.get(
  '/customers',
  customersPermission,
  asyncHandler(async (req, res) => {
    requireModel(User, 'User');

    const page = pagination(req);

    const search = String(req.query.search || '')
      .trim()
      .slice(0, 100);

    const filter = {};

    if (search) {
      const expression = new RegExp(
        escapeRegex(search),
        'i'
      );

      const searchable = [];

      ['name', 'email', 'phone'].forEach(function (field) {
        if (User.schema.path(field)) {
          searchable.push({
            [field]: expression
          });
        }
      });

      if (searchable.length) {
        filter.$or = searchable;
      }
    }

    const [documents, total] = await Promise.all([
      User.find(filter)
        .select(
          'name email phone country currency accountStatus role createdAt lastLoginAt'
        )
        .sort({ createdAt: -1, _id: -1 })
        .skip(page.skip)
        .limit(page.limit)
        .lean(),

      User.countDocuments(filter)
    ]);

    const customers = documents.map(function (user) {
      const safe = {};

      [
        '_id',
        'name',
        'email',
        'phone',
        'country',
        'currency',
        'accountStatus',
        'role',
        'createdAt',
        'lastLoginAt'
      ].forEach(function (field) {
        if (user[field] !== undefined) {
          safe[field] = user[field];
        }
      });

      return safe;
    });

    return res.json({
      customers,
      pagination: {
        page: page.page,
        limit: page.limit,
        total,
        pages: Math.ceil(total / page.limit)
      }
    });
  })
);

// --------------------------------------------------
// WALLET MANAGEMENT - READ ONLY
// --------------------------------------------------

/*
 * GET /api/admin/wallets?page=1&limit=25&asset=BTC
 *
 * Read-only account inspection.
 * No balance modification is allowed through this endpoint.
 */
router.get(
  '/wallets',
  ledgerPermission,
  asyncHandler(async (req, res) => {
    requireModel(Account, 'Ledger account');

    const page = pagination(req);
    const filter = {};

    const asset = String(req.query.asset || '')
      .trim()
      .toUpperCase();

    if (asset) {
      if (!SYMBOL.test(asset)) {
        return res.status(400).json({
          error: 'Invalid asset symbol.'
        });
      }

      if (Account.schema.path('asset')) {
        filter.asset = asset;
      }
    }

    const allowedFields = [
      '_id',
      'ownerType',
      'ownerId',
      'asset',
      'available',
      'locked',
      'inventory',
      'external_clearing',
      'availableUnits',
      'lockedUnits',
      'inventoryUnits',
      'externalClearingUnits',
      'createdAt',
      'updatedAt'
    ];

    const projection = allowedFields
      .filter(function (field) {
        return !!Account.schema.path(field);
      })
      .join(' ');

    const [documents, total] = await Promise.all([
      Account.find(filter)
        .select(projection)
        .sort({ updatedAt: -1, _id: -1 })
        .skip(page.skip)
        .limit(page.limit)
        .lean(),

      Account.countDocuments(filter)
    ]);

    const accounts = documents.map(function (account) {
      return safePick(account, allowedFields);
    });

    return res.json({
      accounts,
      pagination: {
        page: page.page,
        limit: page.limit,
        total,
        pages: Math.ceil(total / page.limit)
      }
    });
  })
);

// --------------------------------------------------
// LEDGER TRANSACTION INSPECTION - READ ONLY
// --------------------------------------------------

/*
 * GET /api/admin/ledger?page=1&limit=25
 *
 * Returns ledger transaction records.
 * Does not modify customer or platform balances.
 */
router.get(
  '/ledger',
  ledgerPermission,
  asyncHandler(async (req, res) => {
    requireModel(
      LedgerTransaction,
      'Ledger transaction'
    );

    const page = pagination(req);

    const allowedFields = [
      '_id',
      'reference',
      'status',
      'asset',
      'amount',
      'amountUnits',
      'entries',
      'createdAt',
      'updatedAt'
    ];

    const projection = allowedFields
      .filter(function (field) {
        return !!LedgerTransaction.schema.path(field);
      })
      .join(' ');

    const [documents, total] = await Promise.all([
      LedgerTransaction.find({})
        .select(projection)
        .sort({ createdAt: -1, _id: -1 })
        .skip(page.skip)
        .limit(page.limit)
        .lean(),

      LedgerTransaction.countDocuments({})
    ]);

    const transactions = documents.map(function (transaction) {
      return safePick(transaction, allowedFields);
    });

    return res.json({
      transactions,
      pagination: {
        page: page.page,
        limit: page.limit,
        total,
        pages: Math.ceil(total / page.limit)
      }
    });
  })
);

// --------------------------------------------------
// ERROR HANDLING
// --------------------------------------------------

router.use((err, req, res, next) => {
  console.error('CoinWave admin API error:', err);

  if (res.headersSent) {
    return next(err);
  }

  if (err && err.code === 11000) {
    return res.status(409).json({
      error: 'This record already exists.'
    });
  }

  if (err && err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'The submitted information is invalid.'
    });
  }

  if (err && err.name === 'CastError') {
    return res.status(400).json({
      error: 'Invalid record identifier or value.'
    });
  }

  const status = Number(err && err.status);

  if (status >= 400 && status < 600) {
    return res.status(status).json({
      error: err.message || 'Request failed.'
    });
  }

  res.status(500).json({
    error: 'An unexpected server error occurred.'
  });
});

module.exports = router;
