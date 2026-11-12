'use strict';

const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const auth = require('./auth');
const ledger = require('./ledger');

const router = express.Router();

const SCALE = 18;
const FACTOR = 10n ** BigInt(SCALE);

const ASSET_PATTERN = /^[A-Z0-9]{2,15}$/;
const CURRENCY_PATTERN = /^(USD|KES)$/;

const ORDER_STATUSES = [
  'pending_payment',
  'payment_verified',
  'approved',
  'processing',
  'completed',
  'rejected'
];

const EXECUTION_MODES = ['manual', 'automatic'];

const DEFAULT_CONFIG = {
  executionMode: 'manual',
  tradingEnabled: true,
  defaultCurrency: 'USD',
  kesPerUsd: null,
  minimumOrderUsd: '1',
  maximumOrderUsd: '100000',
  updatedBy: null
};

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function isObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ''));
}

function toDecimalString(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw httpError(400, 'INVALID_AMOUNT', 'Invalid amount.');
    }

    return String(value);
  }

  return String(value);
}

function decimalToUnits(value, options = {}) {
  const allowZero = options.allowZero === true;
  const text = toDecimalString(value).trim();

  if (!/^\d+(\.\d{1,18})?$/.test(text)) {
    throw httpError(400, 'INVALID_AMOUNT', 'Invalid decimal amount.');
  }

  const [whole, fraction = ''] = text.split('.');
  const units =
    BigInt(whole) * FACTOR +
    BigInt((fraction + '0'.repeat(SCALE)).slice(0, SCALE));

  if (units < 0n || (!allowZero && units <= 0n)) {
    throw httpError(400, 'INVALID_AMOUNT', 'Amount must be greater than zero.');
  }

  return units;
}

function unitsToDecimal(units) {
  const value = BigInt(units);
  const whole = value / FACTOR;
  const fraction = (value % FACTOR)
    .toString()
    .padStart(SCALE, '0')
    .replace(/0+$/, '');

  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeAsset(value) {
  const asset = String(value || '').trim().toUpperCase();

  if (!ASSET_PATTERN.test(asset)) {
    throw httpError(400, 'INVALID_ASSET', 'Invalid asset symbol.');
  }

  return asset;
}

function normalizeCurrency(value) {
  const currency = String(value || 'USD').trim().toUpperCase();

  if (!CURRENCY_PATTERN.test(currency)) {
    throw httpError(400, 'INVALID_CURRENCY', 'Currency must be USD or KES.');
  }

  return currency;
}

function normalizeReference(value) {
  const reference = String(value || '').trim();

  if (!reference || reference.length > 120) {
    throw httpError(400, 'INVALID_REFERENCE', 'Invalid reference.');
  }

  return reference;
}

function requirePermission(permission) {
  if (typeof auth.requirePermission === 'function') {
    return auth.requirePermission(permission);
  }

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required.'
      });
    }

    const allowed =
      typeof auth.hasPermission === 'function'
        ? auth.hasPermission(req.user, permission)
        : req.user.role === 'super_admin';

    if (!allowed) {
      return res.status(403).json({
        error: 'Permission denied.'
      });
    }

    next();
  };
}

function getUserId(req) {
  return req.user?._id || req.user?.id || req.user?.userId;
}

function createHash(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function sameOrderRequest(order, requestHash, legacyRequest) {
  if (order.requestHash) {
    return order.requestHash === requestHash;
  }

  return (
    String(order.userId) === String(legacyRequest.userId) &&
    order.side === legacyRequest.side &&
    order.asset === legacyRequest.asset &&
    String(order.quantity) === String(legacyRequest.quantity) &&
    order.currency === legacyRequest.currency
  );
}

function randomReference(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

// --------------------------------------------------
// MODELS
// --------------------------------------------------

const priceSchema = new mongoose.Schema(
  {
    asset: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      unique: true,
      index: true
    },
    priceUsd: {
      type: String,
      required: true
    },
    enabled: {
      type: Boolean,
      default: true
    },
    source: {
      type: String,
      default: 'admin'
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  { timestamps: true }
);

const configSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      unique: true,
      required: true
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  { timestamps: true }
);

const orderSchema = new mongoose.Schema(
  {
    reference: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    idempotencyKey: {
      type: String,
      default: null,
      index: true
    },
    requestHash: {
      type: String,
      default: null
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    side: {
      type: String,
      enum: ['buy', 'sell'],
      required: true
    },
    asset: {
      type: String,
      required: true,
      uppercase: true,
      index: true
    },
    quantity: {
      type: String,
      required: true
    },
    priceUsd: {
      type: String,
      required: true
    },
    subtotalUsd: {
      type: String,
      required: true
    },
    feeUsd: {
      type: String,
      required: true
    },
    totalUsd: {
      type: String,
      required: true
    },
    currency: {
      type: String,
      enum: ['USD', 'KES'],
      required: true
    },
    exchangeRate: {
      type: String,
      required: true
    },
    totalFiat: {
      type: String,
      required: true
    },
    status: {
      type: String,
      enum: ORDER_STATUSES,
      default: 'pending_payment',
      index: true
    },
    executionMode: {
      type: String,
      enum: EXECUTION_MODES,
      default: 'manual'
    },
    paymentReference: {
      type: String,
      default: null
    },
    paymentVerifiedAt: {
      type: Date,
      default: null
    },
    paymentVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    approvedAt: {
      type: Date,
      default: null
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    completedAt: {
      type: Date,
      default: null
    },
    completedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    rejectedAt: {
      type: Date,
      default: null
    },
    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    rejectionReason: {
      type: String,
      default: null
    },
    ledgerReference: {
      type: String,
      default: null
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  { timestamps: true }
);

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index(
  { userId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: 'string' }
    }
  }
);

const AssetPrice =
  mongoose.models.CWAssetPrice ||
  mongoose.model('CWAssetPrice', priceSchema);

const TradingConfig =
  mongoose.models.CWTradingConfig ||
  mongoose.model('CWTradingConfig', configSchema);

const Order =
  mongoose.models.CWOrder ||
  mongoose.model('CWOrder', orderSchema);

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

async function getConfig() {
  const document = await TradingConfig.findOneAndUpdate(
    { key: 'trading' },
    {
      $setOnInsert: {
        value: DEFAULT_CONFIG
      }
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    }
  );

  const config = {
    ...DEFAULT_CONFIG,
    ...(document.value || {})
  };

  // Do not silently trust an old hard-coded KES rate.
  if (
    config.kesPerUsd !== null &&
    config.kesPerUsd !== undefined &&
    !document.updatedBy &&
    !config.updatedBy
  ) {
    config.kesPerUsd = null;
  }

  return config;
}

async function saveConfig(value, userId) {
  const document = await TradingConfig.findOneAndUpdate(
    { key: 'trading' },
    {
      $set: {
        value,
        updatedBy: userId
      },
      $setOnInsert: {
        key: 'trading'
      }
    },
    {
      upsert: true,
      new: true,
      runValidators: true
    }
  );

  return document.value;
}

async function getAssetPrice(asset) {
  const price = await AssetPrice.findOne({
    asset,
    enabled: true
  }).lean();

  if (!price) {
    throw httpError(
      404,
      'ASSET_PRICE_UNAVAILABLE',
      `No active price is configured for ${asset}.`
    );
  }

  const units = decimalToUnits(price.priceUsd);

  if (units <= 0n) {
    throw httpError(400, 'INVALID_ASSET_PRICE', 'Asset price is invalid.');
  }

  return {
    asset,
    priceUsd: unitsToDecimal(units),
    priceUnits: units,
    source: price.source
  };
}

function calculateQuote({ side, quantity, priceUnits, feePercent, currency, rate }) {
  const quantityUnits = decimalToUnits(quantity);
  const subtotalUnits = (quantityUnits * priceUnits) / FACTOR;

  const feeBasisPoints = BigInt(
    Math.round(Number(feePercent || 0) * 100)
  );

  const feeUnits = (subtotalUnits * feeBasisPoints) / 10000n;

  const totalUnits =
    side === 'buy'
      ? subtotalUnits + feeUnits
      : subtotalUnits - feeUnits;

  if (totalUnits <= 0n) {
    throw httpError(400, 'INVALID_TOTAL', 'Order total is invalid.');
  }

  const rateUnits = decimalToUnits(rate);

  const fiatUnits = (totalUnits * rateUnits) / FACTOR;

  return {
    quantity: unitsToDecimal(quantityUnits),
    priceUsd: unitsToDecimal(priceUnits),
    subtotalUsd: unitsToDecimal(subtotalUnits),
    feeUsd: unitsToDecimal(feeUnits),
    totalUsd: unitsToDecimal(totalUnits),
    currency,
    exchangeRate: unitsToDecimal(rateUnits),
    totalFiat: unitsToDecimal(fiatUnits)
  };
}

async function buildQuote(input) {
  const side = String(input.side || '').toLowerCase();

  if (!['buy', 'sell'].includes(side)) {
    throw httpError(400, 'INVALID_SIDE', 'Side must be buy or sell.');
  }

  const asset = normalizeAsset(input.asset);
  const quantity = String(input.quantity || '').trim();
  const currency = normalizeCurrency(input.currency);

  const config = await getConfig();

  if (!config.tradingEnabled) {
    throw httpError(503, 'TRADING_DISABLED', 'Trading is currently disabled.');
  }

  const price = await getAssetPrice(asset);

  const rate =
    currency === 'USD'
      ? '1'
      : config.kesPerUsd;

  if (!rate || safeNumber(rate) <= 0) {
    throw httpError(
      503,
      'KES_RATE_UNCONFIGURED',
      'KES exchange rate has not been configured by an administrator.'
    );
  }

  const feePercent = safeNumber(
    side === 'buy'
      ? config.buyFeePercent
      : config.sellFeePercent
  );

  const quote = calculateQuote({
    side,
    quantity,
    priceUnits: price.priceUnits,
    feePercent,
    currency,
    rate
  });

  const totalUsd = Number(quote.totalUsd);

  if (
    totalUsd < safeNumber(config.minimumOrderUsd) ||
    totalUsd > safeNumber(config.maximumOrderUsd)
  ) {
    throw httpError(
      400,
      'ORDER_LIMIT',
      'Order is outside the configured minimum or maximum.'
    );
  }

  return {
    ...quote,
    side,
    asset,
    priceSource: price.source
  };
}

// --------------------------------------------------
// AUDIT
// --------------------------------------------------

async function writeAudit(action, req, details = {}) {
  try {
    const AuditLog =
      mongoose.models.CWAuditLog ||
      mongoose.model(
        'CWAuditLog',
        new mongoose.Schema(
          {
            action: String,
            userId: mongoose.Schema.Types.ObjectId,
            ip: String,
            details: mongoose.Schema.Types.Mixed
          },
          { timestamps: true }
        )
      );

    await AuditLog.create({
      action,
      userId: getUserId(req) || null,
      ip: req.ip || req.headers['x-forwarded-for'] || null,
      details
    });
  } catch (error) {
    console.error('CoinWave audit logging error:', error.message);
  }
}

// --------------------------------------------------
// CUSTOMER QUOTES
// --------------------------------------------------

router.post('/quote', async (req, res, next) => {
  try {
    const quote = await buildQuote(req.body || {});
    res.json({ quote });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------
// CUSTOMER ORDER CREATION
// --------------------------------------------------

router.post('/', async (req, res, next) => {
  try {
    const authenticatedUser = await auth.authUser(req);

if (!authenticatedUser) {
  throw httpError(401, 'AUTH_REQUIRED', 'Authentication required.');
}

if (authenticatedUser.accountStatus === 'suspended') {
  throw httpError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
}

req.user = authenticatedUser;

const userId = getUserId(req);

    if (!isObjectId(userId)) {
      throw httpError(401, 'AUTH_REQUIRED', 'Authentication required.');
    }

    const input = req.body || {};
    const quote = await buildQuote(input);

    const config = await getConfig();

    const executionMode =
      config.executionMode === 'automatic' ? 'automatic' : 'manual';

    if (executionMode === 'automatic') {
      throw httpError(
        503,
        'EXECUTION_PROVIDER_UNAVAILABLE',
        'Automatic execution is not enabled until a verified exchange provider is configured.'
      );
    }

    const idempotencyKey = String(
      req.headers['idempotency-key'] || input.idempotencyKey || ''
    ).trim();

    if (idempotencyKey.length > 120) {
      throw httpError(
        400,
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency key is too long.'
      );
    }

    const requestData = {
      userId: String(userId),
      side: quote.side,
      asset: quote.asset,
      quantity: quote.quantity,
      currency: quote.currency,
      totalFiat: quote.totalFiat
    };

    const requestHash = createHash(requestData);

    if (idempotencyKey) {
      const existing = await Order.findOne({
        userId,
        idempotencyKey
      });

      if (existing) {
        if (!sameOrderRequest(existing, requestHash, requestData)) {
          throw httpError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This idempotency key was already used for a different order.'
          );
        }

        return res.status(200).json({
          message: 'Existing order returned.',
          order: existing,
          duplicate: true
        });
      }
    }

    const reference = randomReference('CW');

    const order = new Order({
      reference,
      idempotencyKey: idempotencyKey || null,
      requestHash,
      userId,
      side: quote.side,
      asset: quote.asset,
      quantity: quote.quantity,
      priceUsd: quote.priceUsd,
      subtotalUsd: quote.subtotalUsd,
      feeUsd: quote.feeUsd,
      totalUsd: quote.totalUsd,
      currency: quote.currency,
      exchangeRate: quote.exchangeRate,
      totalFiat: quote.totalFiat,
      status: 'pending_payment',
      executionMode,
      metadata: {
        priceSource: quote.priceSource
      }
    });

    await order.save();

    try {
      const accountBucket =
        quote.side === 'sell' ? 'available' : 'available';

      const reserveAmount =
        quote.side === 'sell'
          ? quote.quantity
          : null;

      if (reserveAmount) {
        const reserveReference = `ORDER-RESERVE-${reference}`;

        await ledger.transfer({
          reference: reserveReference,
          description: `Reserve ${quote.asset} for sell order ${reference}`,
          asset: quote.asset,
          amount: reserveAmount,
          from: {
            ownerType: 'user',
            ownerId: userId,
            bucket: accountBucket
          },
          to: {
            ownerType: 'user',
            ownerId: userId,
            bucket: 'locked'
          },
          metadata: {
            orderReference: reference
          }
        });

        order.ledgerReference = reserveReference;
        await order.save();
      }
    } catch (error) {
      await Order.deleteOne({ _id: order._id });
      throw error;
    }

    await writeAudit('order.created', req, {
      reference,
      side: quote.side,
      asset: quote.asset,
      quantity: quote.quantity,
      totalFiat: quote.totalFiat
    });

    return res.status(201).json({
      message: 'Order created successfully.',
      order
    });
  } catch (error) {
    if (error.code === 11000) {
      const userId = getUserId(req);
      const key = String(
        req.headers['idempotency-key'] ||
        req.body?.idempotencyKey ||
        ''
      ).trim();

      if (key && userId) {
        const existing = await Order.findOne({
          userId,
          idempotencyKey: key
        });

        if (existing) {
          const quote = await buildQuote(req.body || {});
          const requestData = {
            userId: String(userId),
            side: quote.side,
            asset: quote.asset,
            quantity: quote.quantity,
            currency: quote.currency,
            totalFiat: quote.totalFiat
          };

          if (
            sameOrderRequest(
              existing,
              createHash(requestData),
              requestData
            )
          ) {
            return res.status(200).json({
              message: 'Existing order returned.',
              order: existing,
              duplicate: true
            });
          }

          return res.status(409).json({
            error: 'This idempotency key was used for a different order.'
          });
        }
      }
    }

    next(error);
  }
});

// --------------------------------------------------
// CUSTOMER ORDER HISTORY
// --------------------------------------------------

router.get('/my', auth.authUser, async (req, res, next) => {
  try {
    const userId = getUserId(req);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 20)
    );

    const filter = { userId };

    if (req.query.status) {
      if (!ORDER_STATUSES.includes(req.query.status)) {
        throw httpError(400, 'INVALID_STATUS', 'Invalid order status.');
      }

      filter.status = req.query.status;
    }

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Order.countDocuments(filter)
    ]);

    res.json({
      orders,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------
// CUSTOMER ORDER DETAIL
// --------------------------------------------------

router.get('/:reference', auth.authUser, async (req, res, next) => {
  try {
    const order = await Order.findOne({
      reference: req.params.reference,
      userId: getUserId(req)
    }).lean();

    if (!order) {
      throw httpError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    }

    res.json({ order });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------
// ADMIN CONFIGURATION
// --------------------------------------------------

router.get(
  '/admin/config',
  auth.authUser,
  requirePermission('fees.manage'),
  async (req, res, next) => {
    try {
      res.json({ config: await getConfig() });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/admin/config',
  auth.authUser,
  requirePermission('fees.manage'),
  async (req, res, next) => {
    try {
      const oldConfig = await getConfig();
      const input = req.body || {};

      const config = {
        ...oldConfig
      };

      if (input.executionMode !== undefined) {
        if (!EXECUTION_MODES.includes(input.executionMode)) {
          throw httpError(400, 'INVALID_MODE', 'Invalid execution mode.');
        }

        if (input.executionMode === 'automatic') {
          throw httpError(
            503,
            'PROVIDER_REQUIRED',
            'Automatic mode cannot be enabled without a configured execution provider.'
          );
        }

        config.executionMode = input.executionMode;
      }

      if (input.tradingEnabled !== undefined) {
        config.tradingEnabled = Boolean(input.tradingEnabled);
      }

      if (input.defaultCurrency !== undefined) {
        config.defaultCurrency = normalizeCurrency(input.defaultCurrency);
      }

      if (input.kesPerUsd !== undefined) {
        const rate = decimalToUnits(input.kesPerUsd);

        if (rate <= 0n) {
          throw httpError(400, 'INVALID_RATE', 'Invalid KES exchange rate.');
        }

        config.kesPerUsd = unitsToDecimal(rate);
      }

      for (const field of [
        'buyFeePercent',
        'sellFeePercent',
        'minimumOrderUsd',
        'maximumOrderUsd'
      ]) {
        if (input[field] !== undefined) {
          const number = Number(input[field]);

          if (!Number.isFinite(number) || number < 0) {
            throw httpError(400, 'INVALID_CONFIG', `Invalid ${field}.`);
          }

          config[field] = String(number);
        }
      }

      if (
        safeNumber(config.maximumOrderUsd) <
        safeNumber(config.minimumOrderUsd)
      ) {
        throw httpError(
          400,
          'INVALID_LIMITS',
          'Maximum order must be greater than or equal to minimum order.'
        );
      }

      const saved = await saveConfig(config, getUserId(req));

      await writeAudit('trading.config.updated', req, {
        executionMode: saved.executionMode,
        tradingEnabled: saved.tradingEnabled
      });

      res.json({
        message: 'Trading configuration updated.',
        config: saved
      });
    } catch (error) {
      next(error);
    }
  }
);

// --------------------------------------------------
// ADMIN ASSET PRICES
// --------------------------------------------------

router.get(
  '/admin/prices',
  auth.authUser,
  requirePermission('fees.manage'),
  async (req, res, next) => {
    try {
      const prices = await AssetPrice.find()
        .sort({ asset: 1 })
        .lean();

      res.json({ prices });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/admin/prices/:asset',
  auth.authUser,
  requirePermission('fees.manage'),
  async (req, res, next) => {
    try {
      const asset = normalizeAsset(req.params.asset);
      const priceUnits = decimalToUnits(req.body?.priceUsd);

      if (priceUnits <= 0n) {
        throw httpError(400, 'INVALID_PRICE', 'Price must be greater than zero.');
      }

      const price = await AssetPrice.findOneAndUpdate(
        { asset },
        {
          $set: {
            priceUsd: unitsToDecimal(priceUnits),
            enabled: req.body?.enabled !== false,
            source: String(req.body?.source || 'admin').slice(0, 80),
            updatedBy: getUserId(req)
          }
        },
        {
          upsert: true,
          new: true,
          runValidators: true
        }
      );

      await writeAudit('asset.price.updated', req, {
        asset,
        priceUsd: price.priceUsd
      });

      res.json({
        message: 'Asset price updated.',
        price
      });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/admin/prices/:asset',
  auth.authUser,
  requirePermission('fees.manage'),
  async (req, res, next) => {
    try {
      const asset = normalizeAsset(req.params.asset);

      await AssetPrice.updateOne(
        { asset },
        {
          $set: {
            enabled: false,
            updatedBy: getUserId(req)
          }
        }
      );

      await writeAudit('asset.price.disabled', req, { asset });

      res.json({
        message: 'Asset price disabled.'
      });
    } catch (error) {
      next(error);
    }
  }
);

// --------------------------------------------------
// ADMIN ORDER LIST
// --------------------------------------------------

router.get(
  '/admin',
  auth.authUser,
  requirePermission('orders.view'),
  async (req, res, next) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(
        100,
        Math.max(1, parseInt(req.query.limit, 10) || 25)
      );

      const filter = {};

      if (req.query.status) {
        if (!ORDER_STATUSES.includes(req.query.status)) {
          throw httpError(400, 'INVALID_STATUS', 'Invalid order status.');
        }

        filter.status = req.query.status;
      }

      if (req.query.side) {
        if (!['buy', 'sell'].includes(req.query.side)) {
          throw httpError(400, 'INVALID_SIDE', 'Invalid order side.');
        }

        filter.side = req.query.side;
      }

      if (req.query.asset) {
        filter.asset = normalizeAsset(req.query.asset);
      }

      if (req.query.userId) {
        if (!isObjectId(req.query.userId)) {
          throw httpError(400, 'INVALID_USER', 'Invalid user ID.');
        }

        filter.userId = req.query.userId;
      }

      const [orders, total] = await Promise.all([
        Order.find(filter)
          .populate('userId', 'name email phone')
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Order.countDocuments(filter)
      ]);

      res.json({
        orders,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

// --------------------------------------------------
// ADMIN PAYMENT VERIFICATION
// --------------------------------------------------

router.post(
  '/admin/:reference/verify-payment',
  auth.authUser,
  requirePermission('orders.manage'),
  async (req, res, next) => {
    try {
      const reference = normalizeReference(req.params.reference);

      const order = await Order.findOne({ reference });

      if (!order) {
        throw httpError(404, 'ORDER_NOT_FOUND', 'Order not found.');
      }

      if (order.status !== 'pending_payment') {
        throw httpError(
          409,
          'INVALID_ORDER_STATUS',
          'Only pending-payment orders can be verified.'
        );
      }

      order.status = 'payment_verified';
      order.paymentReference = String(
        req.body?.paymentReference || ''
      ).trim().slice(0, 120);

      order.paymentVerifiedAt = new Date();
      order.paymentVerifiedBy = getUserId(req);

      await order.save();

      await writeAudit('order.payment.verified', req, {
        reference,
        paymentReference: order.paymentReference
      });

      res.json({
        message: 'Payment verification recorded. This is an admin attestation, not an automatic bank confirmation.',
        order
      });
    } catch (error) {
      next(error);
    }
  }
);

// --------------------------------------------------
// ADMIN APPROVE ORDER
// --------------------------------------------------

router.post(
  '/admin/:reference/approve',
  auth.authUser,
  requirePermission('orders.manage'),
  async (req, res, next) => {
    try {
      const reference = normalizeReference(req.params.reference);

      const order = await Order.findOne({ reference });

      if (!order) {
        throw httpError(404, 'ORDER_NOT_FOUND', 'Order not found.');
      }

      if (order.status !== 'payment_verified') {
        throw httpError(
          409,
          'INVALID_ORDER_STATUS',
          'Order payment must be verified before approval.'
        );
      }

      order.status = 'approved';
      order.approvedAt = new Date();
      order.approvedBy = getUserId(req);

      await order.save();

      await writeAudit('order.approved', req, { reference });

      res.json({
        message: 'Order approved.',
        order
      });
    } catch (error) {
      next(error);
    }
  }
);

// --------------------------------------------------
// ADMIN COMPLETE PAYOUT / RELEASE
// --------------------------------------------------

router.post(
  '/admin/:reference/complete',
  auth.authUser,
  requirePermission('orders.manage'),
  async (req, res, next) => {
    try {
      const reference = normalizeReference(req.params.reference);

      const order = await Order.findOne({ reference });

      if (!order) {
        throw httpError(404, 'ORDER_NOT_FOUND', 'Order not found.');
      }

      if (order.status !== 'approved') {
        throw httpError(
          409,
          'INVALID_ORDER_STATUS',
          'Only approved orders can be completed.'
        );
      }

      const userId = order.userId;

      if (order.side === 'sell') {
        const releaseReference = `ORDER-SELL-RELEASE-${reference}`;

        await ledger.transfer({
          reference: releaseReference,
          description: `Release sold crypto for order ${reference}`,
          asset: order.asset,
          amount: order.quantity,
          from: {
            ownerType: 'user',
            ownerId: userId,
            bucket: 'locked'
          },
          to: {
            ownerType: 'platform',
            ownerId: null,
            bucket: 'inventory'
          },
          metadata: {
            orderReference: reference
          }
        });
      } else {
        const releaseReference = `ORDER-BUY-RELEASE-${reference}`;

        await ledger.transfer({
          reference: releaseReference,
          description: `Release purchased crypto for order ${reference}`,
          asset: order.asset,
          amount: order.quantity,
          from: {
            ownerType: 'platform',
            ownerId: null,
            bucket: 'inventory'
          },
          to: {
            ownerType: 'user',
            ownerId: userId,
            bucket: 'available'
          },
          metadata: {
            orderReference: reference
          }
        });
      }

      order.status = 'completed';
      order.completedAt = new Date();
      order.completedBy = getUserId(req);

      await order.save();

      await writeAudit('order.completed', req, {
        reference,
        side: order.side
      });

      res.json({
        message: 'Order marked completed and ledger release recorded. External fiat payout or blockchain settlement must be independently confirmed.',
        order
      });
    } catch (error) {
      next(error);
    }
  }
);

// --------------------------------------------------
// ADMIN REJECT ORDER
// --------------------------------------------------

router.post(
  '/admin/:reference/reject',
  auth.authUser,
  requirePermission('orders.manage'),
  async (req, res, next) => {
    try {
      const reference = normalizeReference(req.params.reference);

      const order = await Order.findOne({ reference });

      if (!order) {
        throw httpError(404, 'ORDER_NOT_FOUND', 'Order not found.');
      }

      if (order.status === 'completed' || order.status === 'rejected') {
        throw httpError(
          409,
          'INVALID_ORDER_STATUS',
          'This order cannot be rejected.'
        );
      }

      if (order.status === 'payment_verified' || order.status === 'approved') {
        throw httpError(
          409,
          'REFUND_REQUIRED',
          'Payment was verified. Complete and record the customer fiat refund before rejecting this order.'
        );
      }

      if (order.side === 'sell' && order.ledgerReference) {
        const refundReference = `ORDER-SELL-REFUND-${reference}`;

        await ledger.transfer({
          reference: refundReference,
          description: `Return reserved crypto for rejected order ${reference}`,
          asset: order.asset,
          amount: order.quantity,
          from: {
            ownerType: 'user',
            ownerId: order.userId,
            bucket: 'locked'
          },
          to: {
            ownerType: 'user',
            ownerId: order.userId,
            bucket: 'available'
          },
          metadata: {
            orderReference: reference
          }
        });
      }

      order.status = 'rejected';
      order.rejectedAt = new Date();
      order.rejectedBy = getUserId(req);
      order.rejectionReason = String(
        req.body?.reason || 'Rejected by administrator.'
      ).slice(0, 500);

      await order.save();

      await writeAudit('order.rejected', req, {
        reference,
        reason: order.rejectionReason
      });

      res.json({
        message: 'Order rejected.',
        order
      });
    } catch (error) {
      next(error);
    }
  }
);

// --------------------------------------------------
// ADMIN INVENTORY FUNDING
// --------------------------------------------------

router.post(
  '/admin/inventory/fund',
  auth.authUser,
  requirePermission('ledger.manage'),
  async (req, res, next) => {
    try {
      const asset = normalizeAsset(req.body?.asset);
      const amountUnits = decimalToUnits(req.body?.amount);
      const amount = unitsToDecimal(amountUnits);

      const reference = randomReference('CW-INV');

      await ledger.transfer({
        reference,
        description: 'Admin inventory funding attestation',
        asset,
        amount,
        from: {
          ownerType: 'platform',
          ownerId: null,
          bucket: 'external_clearing'
        },
        to: {
          ownerType: 'platform',
          ownerId: null,
          bucket: 'inventory'
        },
        allowNegativeSource: true,
        metadata: {
          reason: String(req.body?.reason || '').slice(0, 500),
          attestedBy: String(getUserId(req)),
          externalSettlementVerified: false
        }
      });

      await writeAudit('inventory.funded', req, {
        reference,
        asset,
        amount
      });

      res.status(201).json({
        message: 'Inventory ledger entry recorded. This does not prove blockchain receipt or custody of the crypto asset.',
        reference,
        asset,
        amount
      });
    } catch (error) {
      next(error);
    }
  }
);

// --------------------------------------------------
// ADMIN BALANCE VIEW
// --------------------------------------------------

router.get(
  '/admin/balances/:userId',
  auth.authUser,
  requirePermission('ledger.view'),
  async (req, res, next) => {
    try {
      if (!isObjectId(req.params.userId)) {
        throw httpError(400, 'INVALID_USER', 'Invalid user ID.');
      }

      const accounts = await ledger.Account.find({
        ownerType: 'user',
        ownerId: req.params.userId
      }).lean();

      res.json({
        balances: accounts.map((account) => ({
          asset: account.asset,
          bucket: account.bucket,
          balance: unitsToDecimal(BigInt(account.balanceUnits || '0'))
        }))
      });
    } catch (error) {
      next(error);
    }
  }
);

// --------------------------------------------------
// ERROR HANDLER
// --------------------------------------------------

router.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const status = Number(error.status) || 500;

  if (status >= 500) {
    console.error('CoinWave orders error:', error);
  }

  res.status(status).json({
    error:
      status >= 500
        ? 'An internal server error occurred.'
        : error.message,
    code: error.code || 'ORDERS_ERROR'
  });
});

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

router.Order = Order;
router.AssetPrice = AssetPrice;
router.TradingConfig = TradingConfig;
router.buildQuote = buildQuote;

module.exports = router;
