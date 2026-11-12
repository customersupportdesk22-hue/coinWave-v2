
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

function requireModel(model, name) {
  if (!model || typeof model.find !== 'function') {
    const error = new Error(name + ' model is unavailable.');
    error.status = 503;
    throw error;
  }

  return model;
}

function permission(name) {
  if (typeof auth.requirePermission !== 'function') {
    throw new Error('auth.js must export requirePermission().');
  }

  return auth.requirePermission(name);
}

function safeBalance(units) {
  try {
    return ledger.fromUnits(String(units || '0'));
  } catch (error) {
    return '0';
  }
}

function safePick(document, fields) {
  if (!document) return null;

  const object = typeof document.toObject === 'function'
    ? document.toObject()
    : document;

  const result = {};

  fields.forEach(field => {
    if (object[field] !== undefined) {
      result[field] = object[field];
    }
  });

  return result;
}

// --------------------------------------------------
// PERMISSIONS
// --------------------------------------------------

const addressesPermission = permission('addresses.manage');
const customersPermission = permission('customers.view');
const ledgerPermission = permission('ledger.view');

// --------------------------------------------------
// DEPOSIT ADDRESS MANAGEMENT
// --------------------------------------------------

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

router.put(
  '/addresses/:symbol',
  addressesPermission,
  asyncHandler(async (req, res) => {
    const symbol = String(req.params.symbol || '')
      .trim()
      .toUpperCase();

    const body = req.body || {};

    const address = String(body.address || '').trim();
    const network = String(body.network || '').trim().slice(0, 40);
    const memo = String(body.memo || '').trim().slice(0, 80);

    if (!SYMBOL.test(symbol)) {
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
          ['value.' + symbol]: entry
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

router.delete(
  '/addresses/:symbol',
  addressesPermission,
  asyncHandler(async (req, res) => {
    const symbol = String(req.params.symbol || '')
      .trim()
      .toUpperCase();

    if (!SYMBOL.test(symbol)) {
      return res.status(400).json({
        error: 'Invalid coin symbol.'
      });
    }

    await Setting.findOneAndUpdate(
      { key: 'addresses' },
      {
        $unset: {
          ['value.' + symbol]: ''
        }
      }
    );

    return res.json({ ok: true });
  })
);

// --------------------------------------------------
// CUSTOMER MANAGEMENT - READ ONLY
// --------------------------------------------------

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
      const expression = new RegExp(escapeRegex(search), 'i');

      filter.$or = ['name', 'email', 'phone']
        .filter(field => Boolean(User.schema.path(field)))
        .map(field => ({ [field]: expression }));
    }

    const [documents, total] = await Promise.all([
      User.find(filter)
        .select(
          'name email phone country currency accountStatus createdAt lastLoginAt'
        )
        .sort({ createdAt: -1, _id: -1 })
        .skip(page.skip)
        .limit(page.limit)
        .lean(),

      User.countDocuments(filter)
    ]);

    const customers = documents.map(user => ({
      _id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone || '',
      country: user.country || '',
      currency: user.currency || '',
      accountStatus: user.accountStatus || 'active',

      // Roles are environment-configured, not stored in User.
      role: auth.getRole(user),

      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt || null
    }));

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

    const ownerType = String(req.query.ownerType || '')
      .trim()
      .toLowerCase();

    if (asset) {
      if (!SYMBOL.test(asset)) {
        return res.status(400).json({
          error: 'Invalid asset symbol.'
        });
      }

      filter.asset = asset;
    }

    if (ownerType) {
      if (!['user', 'platform'].includes(ownerType)) {
        return res.status(400).json({
          error: 'Invalid wallet owner type.'
        });
      }

      filter.ownerType = ownerType;
    }

    const [documents, total] = await Promise.all([
      Account.find(filter)
        .select(
          'ownerType ownerId asset bucket balanceUnits createdAt updatedAt'
        )
        .sort({ updatedAt: -1, _id: -1 })
        .skip(page.skip)
        .limit(page.limit)
        .lean(),

      Account.countDocuments(filter)
    ]);

    const accounts = documents.map(account => ({
      _id: account._id,
      ownerType: account.ownerType,
      ownerId: account.ownerId,
      asset: account.asset,
      bucket: account.bucket,
      balance: safeBalance(account.balanceUnits),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt
    }));

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
// CUSTOMER WALLET BALANCES - READ ONLY
// --------------------------------------------------

router.get(
  '/customers/:userId/balances',
  customersPermission,
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.userId)) {
      return res.status(400).json({
        error: 'Invalid customer ID.'
      });
    }

    requireModel(Account, 'Ledger account');

    const customer = await User.findById(req.params.userId)
      .select('_id name email')
      .lean();

    if (!customer) {
      return res.status(404).json({
        error: 'Customer not found.'
      });
    }

    const accounts = await Account.find({
      ownerType: 'user',
      ownerId: String(customer._id)
    })
      .select('asset bucket balanceUnits')
      .sort({ asset: 1, bucket: 1 })
      .lean();

    return res.json({
      customer,
      balances: accounts.map(account => ({
        asset: account.asset,
        bucket: account.bucket,
        balance: safeBalance(account.balanceUnits)
      }))
    });
  })
);

// --------------------------------------------------
// LEDGER TRANSACTION INSPECTION - READ ONLY
// --------------------------------------------------

router.get(
  '/ledger',
  ledgerPermission,
  asyncHandler(async (req, res) => {
    requireModel(LedgerTransaction, 'Ledger transaction');

    const page = pagination(req);

    const [documents, total] = await Promise.all([
      LedgerTransaction.find({})
        .sort({ createdAt: -1, _id: -1 })
        .skip(page.skip)
        .limit(page.limit)
        .lean(),

      LedgerTransaction.countDocuments({})
    ]);

    const transactions = documents.map(transaction => {
      const safe = safePick(transaction, [
        '_id',
        'reference',
        'description',
        'asset',
        'status',
        'metadata',
        'createdAt',
        'updatedAt'
      ]);

      // Do not expose internal fields or customer secrets.
      return safe;
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

  return res.status(500).json({
    error: 'An unexpected server error occurred.'
  });
});

module.exports = router;
