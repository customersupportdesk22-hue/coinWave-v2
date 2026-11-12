
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const auth = require('./auth');
const ledger = require('./ledger');

const router = express.Router();
const SCALE = 10n ** 18n;

// --------------------------------------------------
// MODELS
// --------------------------------------------------

const priceSchema = new mongoose.Schema({
  symbol: {
    type: String,
    required: true,
    uppercase: true,
    trim: true,
    unique: true,
    match: /^[A-Z0-9]{2,15}$/
  },
  usdPrice: {
    type: String,
    required: true
  },
  buySpreadPct: {
    type: String,
    default: '0'
  },
  sellSpreadPct: {
    type: String,
    default: '0'
  },
  feePct: {
    type: String,
    default: '0'
  },
  fixedFeeUsd: {
    type: String,
    default: '0'
  },
  enabled: {
    type: Boolean,
    default: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  }
}, { timestamps: true });

const AssetPrice = mongoose.models.CWAssetPrice ||
  mongoose.model('CWAssetPrice', priceSchema);

const configSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true
  },
  usdKesRate: {
    type: String,
    default: '130'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  }
}, { timestamps: true });

const TradingConfig = mongoose.models.CWTradingConfig ||
  mongoose.model('CWTradingConfig', configSchema);

const orderSchema = new mongoose.Schema({
  reference: {
    type: String,
    required: true,
    unique: true
  },
  idempotencyKey: {
    type: String,
    default: ''
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
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
    required: true
  },
  quantity: {
    type: String,
    required: true
  },
  quoteCurrency: {
    type: String,
    enum: ['USD', 'KES'],
    required: true
  },
  quoteAmount: {
    type: String,
    required: true
  },
  priceSnapshot: {
    usdPrice: String,
    usdKesRate: String,
    baseAmountUsd: String,
    spreadPct: String,
    spreadAmountUsd: String,
    feePct: String,
    feeAmountUsd: String,
    totalUsd: String,
    totalQuote: String,
    capturedAt: Date
  },
  executionMode: {
    type: String,
    enum: ['manual', 'automatic'],
    default: 'manual'
  },
  paymentReference: {
    type: String,
    default: ''
  },
  paymentVerified: {
    type: Boolean,
    default: false
  },
  paymentVerificationReference: {
    type: String,
    default: ''
  },
  payoutDestination: {
    type: String,
    default: ''
  },
  payoutReference: {
    type: String,
    default: ''
  },
  payoutStatus: {
    type: String,
    enum: ['not_required', 'pending', 'paid'],
    default: 'not_required'
  },
  status: {
    type: String,
    enum: [
      'pending',
      'processing',
      'awaiting_payout',
      'completed',
      'rejected'
    ],
    default: 'pending',
    index: true
  },
  rejectionReason: {
    type: String,
    default: ''
  },
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  audit: [{
    action: String,
    actorId: mongoose.Schema.Types.ObjectId,
    reference: String,
    note: String,
    at: Date
  }],
  processedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index(
  { userId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: 'string', $gt: '' }
    }
  }
);

const Order = mongoose.models.CWOrder ||
  mongoose.model('CWOrder', orderSchema);

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function asyncHandler(fn) {
  return (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
}

function requireDatabase(req, res, next) {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: 'Database is unavailable.'
    });
  }
  next();
}

const requireLogin = asyncHandler(async (req, res, next) => {
  const user = await auth.authUser(req, res);
  if (!user) return;
  req.user = user;
  next();
});

function permission(name) {
  return auth.requirePermission(name);
}

function cleanText(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function validId(value) {
  return mongoose.isValidObjectId(value);
}

function amountUnits(value) {
  return ledger.toUnits(String(value));
}

function positiveAmount(value) {
  try {
    return amountUnits(value) > 0n;
  } catch {
    return false;
  }
}

function decimal(units) {
  return ledger.fromUnits(units.toString());
}

function multiply(a, b) {
  return (a * b) / SCALE;
}

function percentage(amount, percent) {
  return (amount * percent) / (100n * SCALE);
}

function platformAccount(bucket) {
  return {
    ownerType: 'platform',
    ownerId: 'coinwave',
    bucket
  };
}

function customerAccount(id, bucket) {
  return {
    ownerType: 'user',
    ownerId: String(id),
    bucket
  };
}

function orderEscrow(id) {
  return {
    ownerType: 'platform',
    ownerId: 'order:' + String(id),
    bucket: 'locked'
  };
}

function ledgerReference(action, id) {
  return `order:${action}:${id}`;
}

function conflict(res, message) {
  return res.status(409).json({ error: message });
}

function addAudit(order, action, actorId, reference, note) {
  order.audit.push({
    action,
    actorId,
    reference: cleanText(reference, 180),
    note: cleanText(note, 300),
    at: new Date()
  });
}

// --------------------------------------------------
// PRICING ENGINE
// --------------------------------------------------

async function getTradingConfig() {
  let config = await TradingConfig.findOne({ key: 'default' });

  if (!config) {
    config = await TradingConfig.create({
      key: 'default',
      usdKesRate: '130'
    });
  }

  return config;
}

async function calculateQuote({
  side,
  asset,
  quantity,
  quoteCurrency
}) {
  const price = await AssetPrice.findOne({
    symbol: asset,
    enabled: true
  }).lean();

  if (!price) {
    const error = new Error('ASSET_PRICE_UNAVAILABLE');
    throw error;
  }

  const config = await getTradingConfig();

  const quantityUnits = amountUnits(quantity);
  const priceUnits = amountUnits(price.usdPrice);
  const fxUnits = amountUnits(config.usdKesRate);

  if (
    quantityUnits <= 0n ||
    priceUnits <= 0n ||
    fxUnits <= 0n
  ) {
    throw new Error('INVALID_PRICING_CONFIGURATION');
  }

  const spreadPct = amountUnits(
    side === 'buy'
      ? price.buySpreadPct
      : price.sellSpreadPct
  );

  const feePct = amountUnits(price.feePct);
  const fixedFee = amountUnits(price.fixedFeeUsd || '0');

  if (
    spreadPct < 0n ||
    spreadPct > 50n * SCALE ||
    feePct < 0n ||
    feePct > 50n * SCALE ||
    fixedFee < 0n
  ) {
    throw new Error('INVALID_PRICING_CONFIGURATION');
  }

  const base = multiply(quantityUnits, priceUnits);
  const spreadAmount = percentage(base, spreadPct);

  let adjusted;

  if (side === 'buy') {
    adjusted = base + spreadAmount;
  } else {
    adjusted = base - spreadAmount;
  }

  if (adjusted <= 0n) {
    throw new Error('INVALID_PRICING_CONFIGURATION');
  }

  const percentageFee = percentage(adjusted, feePct);
  const fee = percentageFee + fixedFee;

  const totalUsd = side === 'buy'
    ? adjusted + fee
    : adjusted - fee;

  if (totalUsd <= 0n) {
    throw new Error('QUOTE_TOO_SMALL');
  }

  const totalQuote = quoteCurrency === 'KES'
    ? multiply(totalUsd, fxUnits)
    : totalUsd;

  return {
    usdPrice: decimal(priceUnits),
    usdKesRate: decimal(fxUnits),
    baseAmountUsd: decimal(base),
    spreadPct: decimal(spreadPct),
    spreadAmountUsd: decimal(spreadAmount),
    feePct: decimal(feePct),
    feeAmountUsd: decimal(fee),
    totalUsd: decimal(totalUsd),
    totalQuote: decimal(totalQuote),
    capturedAt: new Date()
  };
}

// --------------------------------------------------
// CUSTOMER: GET SERVER-CALCULATED QUOTE
// GET /api/orders/quote
// --------------------------------------------------

router.get(
  '/quote',
  requireDatabase,
  requireLogin,
  asyncHandler(async (req, res) => {
    const side = cleanText(req.query.side, 10).toLowerCase();
    const asset = cleanText(req.query.asset, 15).toUpperCase();
    const quantity = cleanText(req.query.quantity, 50);
    const quoteCurrency = cleanText(
      req.query.quoteCurrency || 'USD',
      3
    ).toUpperCase();

    if (!['buy', 'sell'].includes(side)) {
      return res.status(400).json({ error: 'Invalid order side.' });
    }

    if (!/^[A-Z0-9]{2,15}$/.test(asset)) {
      return res.status(400).json({ error: 'Invalid asset.' });
    }

    if (!positiveAmount(quantity)) {
      return res.status(400).json({ error: 'Invalid quantity.' });
    }

    if (!['USD', 'KES'].includes(quoteCurrency)) {
      return res.status(400).json({ error: 'Invalid currency.' });
    }

    const quote = await calculateQuote({
      side,
      asset,
      quantity,
      quoteCurrency
    });

    res.json({
      side,
      asset,
      quantity,
      quoteCurrency,
      quote
    });
  })
);

// --------------------------------------------------
// ADMIN: VIEW AND MANAGE ASSET PRICES
// Requires fees.manage
// --------------------------------------------------

router.get(
  '/admin/pricing',
  requireDatabase,
  permission('fees.manage'),
  asyncHandler(async (req, res) => {
    const [prices, config] = await Promise.all([
      AssetPrice.find().sort({ symbol: 1 }).lean(),
      getTradingConfig()
    ]);

    res.json({
      prices,
      usdKesRate: config.usdKesRate,
      updatedAt: config.updatedAt
    });
  })
);

router.put(
  '/admin/pricing/config',
  requireDatabase,
  permission('fees.manage'),
  asyncHandler(async (req, res) => {
    const rate = cleanText(req.body.usdKesRate, 50);

    if (!positiveAmount(rate)) {
      return res.status(400).json({
        error: 'Enter a valid USD/KES exchange rate.'
      });
    }

    const config = await TradingConfig.findOneAndUpdate(
      { key: 'default' },
      {
        $set: {
          usdKesRate: rate,
          updatedBy: req.user._id
        },
        $setOnInsert: { key: 'default' }
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );

    res.json({
      message: 'USD/KES rate updated.',
      usdKesRate: config.usdKesRate
    });
  })
);

router.put(
  '/admin/pricing/:asset',
  requireDatabase,
  permission('fees.manage'),
  asyncHandler(async (req, res) => {
    const symbol = cleanText(req.params.asset, 15).toUpperCase();

    const usdPrice = cleanText(req.body.usdPrice, 50);
    const buySpreadPct = cleanText(req.body.buySpreadPct ?? '0', 30);
    const sellSpreadPct = cleanText(req.body.sellSpreadPct ?? '0', 30);
    const feePct = cleanText(req.body.feePct ?? '0', 30);
    const fixedFeeUsd = cleanText(req.body.fixedFeeUsd ?? '0', 50);
    const enabled = req.body.enabled !== false;

    if (!/^[A-Z0-9]{2,15}$/.test(symbol)) {
      return res.status(400).json({ error: 'Invalid asset symbol.' });
    }

    const values = [
      usdPrice,
      buySpreadPct,
      sellSpreadPct,
      feePct,
      fixedFeeUsd
    ];

    if (!values.every(value => {
      try {
        return amountUnits(value) >= 0n;
      } catch {
        return false;
      }
    }) || !positiveAmount(usdPrice)) {
      return res.status(400).json({
        error: 'Invalid price, spread or fee.'
      });
    }

    if (
      amountUnits(buySpreadPct) > 50n * SCALE ||
      amountUnits(sellSpreadPct) > 50n * SCALE ||
      amountUnits(feePct) > 50n * SCALE
    ) {
      return res.status(400).json({
        error: 'Spreads and percentage fees cannot exceed 50%.'
      });
    }

    const price = await AssetPrice.findOneAndUpdate(
      { symbol },
      {
        $set: {
          usdPrice,
          buySpreadPct,
          sellSpreadPct,
          feePct,
          fixedFeeUsd,
          enabled,
          updatedBy: req.user._id
        },
        $setOnInsert: { symbol }
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );

    res.json({
      message: 'Asset pricing saved.',
      price
    });
  })
);

// --------------------------------------------------
// CUSTOMER: CREATE BUY OR SELL ORDER
// quoteAmount supplied by the browser is ignored.
// The server calculates the actual quote.
// --------------------------------------------------

router.post(
  '/',
  requireDatabase,
  requireLogin,
  asyncHandler(async (req, res) => {
    const side = cleanText(req.body.side, 10).toLowerCase();
    const asset = cleanText(req.body.asset, 15).toUpperCase();
    const quantity = cleanText(req.body.quantity, 50);
    const quoteCurrency = cleanText(
      req.body.quoteCurrency || 'USD',
      3
    ).toUpperCase();
    const executionMode = cleanText(
      req.body.executionMode || 'manual',
      12
    ).toLowerCase();

    if (!['buy', 'sell'].includes(side)) {
      return res.status(400).json({ error: 'Select buy or sell.' });
    }

    if (!/^[A-Z0-9]{2,15}$/.test(asset)) {
      return res.status(400).json({ error: 'Invalid cryptocurrency.' });
    }

    if (!positiveAmount(quantity)) {
      return res.status(400).json({ error: 'Enter a valid quantity.' });
    }

    if (!['USD', 'KES'].includes(quoteCurrency)) {
      return res.status(400).json({ error: 'Unsupported currency.' });
    }

    if (!['manual', 'automatic'].includes(executionMode)) {
      return res.status(400).json({ error: 'Invalid execution mode.' });
    }

    if (executionMode === 'automatic') {
      return res.status(409).json({
        error: 'Automatic execution is not configured yet.',
        code: 'EXCHANGE_PROVIDER_REQUIRED'
      });
    }

    const paymentReference = cleanText(req.body.paymentReference, 120);
    const payoutDestination = cleanText(req.body.payoutDestination, 180);

    if (side === 'buy' && !paymentReference) {
      return res.status(400).json({
        error: 'A payment reference is required.'
      });
    }

    if (side === 'sell' && payoutDestination.length < 5) {
      return res.status(400).json({
        error: 'A valid payout destination is required.'
      });
    }

    const quote = await calculateQuote({
      side,
      asset,
      quantity,
      quoteCurrency
    });

    const idempotencyKey = cleanText(
      req.get('Idempotency-Key') || req.body.idempotencyKey,
      100
    );

    if (idempotencyKey) {
      const existing = await Order.findOne({
        userId: req.user._id,
        idempotencyKey
      });

      if (existing) {
        return res.status(200).json({
          message: 'Existing order returned.',
          order: existing
        });
      }
    }

    const session = await mongoose.startSession();
    let createdOrder;

    try {
      await session.withTransaction(async () => {
        if (idempotencyKey) {
          const existing = await Order.findOne({
            userId: req.user._id,
            idempotencyKey
          }).session(session);

          if (existing) {
            createdOrder = existing;
            return;
          }
        }

        const reference = 'CW-' +
          crypto.randomUUID().replace(/-/g, '').toUpperCase();

        const [order] = await Order.create([{
          reference,
          idempotencyKey,
          userId: req.user._id,
          side,
          asset,
          quantity,
          quoteCurrency,
          quoteAmount: quote.totalQuote,
          priceSnapshot: quote,
          executionMode,
          paymentReference,
          payoutDestination,
          payoutStatus: side === 'sell' ? 'pending' : 'not_required'
        }], { session });

        await ledger.transfer({
          session,
          reference: ledgerReference('reserve', order._id),
          description: side === 'sell'
            ? 'Reserve customer crypto for sell order'
            : 'Reserve platform inventory for buy order',
          asset,
          amount: quantity,
          from: side === 'sell'
            ? customerAccount(req.user._id, 'available')
            : platformAccount('inventory'),
          to: orderEscrow(order._id),
          metadata: {
            orderId: String(order._id),
            orderReference: reference
          }
        });

        createdOrder = order;
      });

      return res.status(201).json({
        message: 'Order submitted successfully.',
        order: createdOrder
      });
    } finally {
      await session.endSession();
    }
  })
);

// --------------------------------------------------
// CUSTOMER: VIEW OWN ORDERS
// --------------------------------------------------

router.get(
  '/my',
  requireDatabase,
  requireLogin,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const filter = { userId: req.user._id };

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
      total,
      page,
      pages: Math.ceil(total / limit)
    });
  })
);

// --------------------------------------------------
// ADMIN: VIEW ORDERS
// --------------------------------------------------

router.get(
  '/admin',
  requireDatabase,
  permission('orders.view'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const filter = {};

    if (req.query.status) {
      const status = cleanText(req.query.status, 30);
      const allowed = [
        'pending', 'processing', 'awaiting_payout',
        'completed', 'rejected'
      ];

      if (!allowed.includes(status)) {
        return res.status(400).json({ error: 'Invalid order status.' });
      }
      filter.status = status;
    }

    if (req.query.side) {
      const side = cleanText(req.query.side, 10);
      if (!['buy', 'sell'].includes(side)) {
        return res.status(400).json({ error: 'Invalid order side.' });
      }
      filter.side = side;
    }

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('userId', 'name email')
        .lean(),
      Order.countDocuments(filter)
    ]);

    res.json({
      orders,
      total,
      page,
      pages: Math.ceil(total / limit)
    });
  })
);

// --------------------------------------------------
// ADMIN: VERIFY BUY PAYMENT
// --------------------------------------------------

router.post(
  '/admin/:id/verify-payment',
  requireDatabase,
  permission('orders.manage'),
  asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid order ID.' });
    }

    const reference = cleanText(req.body.verificationReference, 120);

    if (!reference) {
      return res.status(400).json({
        error: 'Verification reference is required.'
      });
    }

    const order = await Order.findOneAndUpdate(
      {
        _id: req.params.id,
        side: 'buy',
        status: 'pending',
        paymentVerified: false
      },
      {
        $set: {
          paymentVerified: true,
          paymentVerificationReference: reference,
          adminId: req.user._id
        },
        $push: {
          audit: {
            action: 'payment_verified',
            actorId: req.user._id,
            reference,
            note: 'Manual payment verification recorded',
            at: new Date()
          }
        }
      },
      { new: true, runValidators: true }
    );

    if (!order) {
      return conflict(res, 'Order not found or payment cannot be verified.');
    }

    res.json({
      message: 'Payment verification recorded. Confirm the actual payment independently.',
      order
    });
  })
);

// --------------------------------------------------
// ADMIN: APPROVE ORDER
// --------------------------------------------------

router.post(
  '/admin/:id/approve',
  requireDatabase,
  permission('orders.manage'),
  asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid order ID.' });
    }

    const session = await mongoose.startSession();
    let result;

    try {
      await session.withTransaction(async () => {
        const order = await Order.findOne({
          _id: req.params.id,
          status: 'pending'
        }).session(session);

        if (!order) throw new Error('ORDER_NOT_PENDING');

        if (order.executionMode !== 'manual') {
          throw new Error('AUTOMATIC_PROVIDER_NOT_CONFIGURED');
        }

        if (order.side === 'buy') {
          if (!order.paymentVerified) {
            throw new Error('PAYMENT_NOT_VERIFIED');
          }

          await ledger.transfer({
            session,
            reference: ledgerReference('complete-buy', order._id),
            description: 'Complete verified customer buy order',
            asset: order.asset,
            amount: order.quantity,
            from: orderEscrow(order._id),
            to: customerAccount(order.userId, 'available'),
            metadata: {
              orderId: String(order._id),
              orderReference: order.reference
            }
          });

          order.status = 'completed';
          order.payoutStatus = 'not_required';
        } else {
          order.status = 'awaiting_payout';
          order.payoutStatus = 'pending';
        }

        order.adminId = req.user._id;
        order.processedAt = new Date();

        addAudit(
          order,
          'approved',
          req.user._id,
          '',
          order.side === 'sell'
            ? 'Approved; crypto remains in escrow pending fiat payout.'
            : 'Buy order completed after payment verification.'
        );

        await order.save({ session });
        result = order;
      });

      res.json({
        message: result.status === 'awaiting_payout'
          ? 'Sell order approved. Crypto remains reserved pending payout.'
          : 'Buy order completed.',
        order: result
      });
    } catch (err) {
      const messages = {
        ORDER_NOT_PENDING: 'This order is no longer pending.',
        PAYMENT_NOT_VERIFIED: 'Verify the payment before approval.',
        AUTOMATIC_PROVIDER_NOT_CONFIGURED:
          'Automatic execution is not configured.'
      };

      if (messages[err.message]) return conflict(res, messages[err.message]);
      throw err;
    } finally {
      await session.endSession();
    }
  })
);

// --------------------------------------------------
// ADMIN: REJECT ORDER AND RELEASE ESCROW
// --------------------------------------------------

router.post(
  '/admin/:id/reject',
  requireDatabase,
  permission('orders.manage'),
  asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid order ID.' });
    }

    const reason = cleanText(req.body.reason, 300);
    if (reason.length < 3) {
      return res.status(400).json({ error: 'Provide a rejection reason.' });
    }

    const session = await mongoose.startSession();
    let result;

    try {
      await session.withTransaction(async () => {
        const order = await Order.findOne({
          _id: req.params.id,
          status: 'pending'
        }).session(session);

        if (!order) throw new Error('ORDER_NOT_PENDING');

        await ledger.transfer({
          session,
          reference: ledgerReference('release', order._id),
          description: 'Release reserved funds for rejected order',
          asset: order.asset,
          amount: order.quantity,
          from: orderEscrow(order._id),
          to: order.side === 'sell'
            ? customerAccount(order.userId, 'available')
            : platformAccount('inventory'),
          metadata: {
            orderId: String(order._id),
            orderReference: order.reference,
            reason
          }
        });

        order.status = 'rejected';
        order.rejectionReason = reason;
        order.adminId = req.user._id;
        order.processedAt = new Date();

        addAudit(order, 'rejected', req.user._id, '', reason);
        await order.save({ session });
        result = order;
      });

      res.json({
        message: 'Order rejected and reserved funds released.',
        order: result
      });
    } catch (err) {
      if (err.message === 'ORDER_NOT_PENDING') {
        return conflict(res, 'This order is no longer pending.');
      }
      throw err;
    } finally {
      await session.endSession();
    }
  })
);

// --------------------------------------------------
// ADMIN: COMPLETE SELL PAYOUT
// This records admin confirmation, not a bank transfer.
// --------------------------------------------------

router.post(
  '/admin/:id/complete-payout',
  requireDatabase,
  permission('orders.manage'),
  asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid order ID.' });
    }

    const payoutReference = cleanText(req.body.payoutReference, 120);
    if (!payoutReference) {
      return res.status(400).json({
        error: 'Payout reference is required.'
      });
    }

    const session = await mongoose.startSession();
    let result;

    try {
      await session.withTransaction(async () => {
        const order = await Order.findOne({
          _id: req.params.id,
          side: 'sell',
          status: 'awaiting_payout',
          payoutStatus: 'pending'
        }).session(session);

        if (!order) throw new Error('PAYOUT_NOT_PENDING');

        await ledger.transfer({
          session,
          reference: ledgerReference('settle-sell', order._id),
          description: 'Settle sell order after fiat payout',
          asset: order.asset,
          amount: order.quantity,
          from: orderEscrow(order._id),
          to: platformAccount('inventory'),
          metadata: {
            orderId: String(order._id),
            orderReference: order.reference,
            payoutReference
          }
        });

        order.payoutStatus = 'paid';
        order.payoutReference = payoutReference;
        order.status = 'completed';
        order.adminId = req.user._id;
        order.processedAt = new Date();

        addAudit(
          order,
          'payout_confirmed',
          req.user._id,
          payoutReference,
          'Administrator confirmed external fiat payout.'
        );

        await order.save({ session });
        result = order;
      });

      res.json({
        message: 'Payout confirmation recorded and sell order settled.',
        order: result
      });
    } catch (err) {
      if (err.message === 'PAYOUT_NOT_PENDING') {
        return conflict(res, 'This order is not awaiting payout.');
      }
      throw err;
    } finally {
      await session.endSession();
    }
  })
);

// --------------------------------------------------
// ADMIN: RECORD CRYPTO INVENTORY FUNDING
// This is an accounting attestation, not blockchain proof.
// --------------------------------------------------

router.post(
  '/admin/inventory/fund',
  requireDatabase,
  permission('orders.manage'),
  asyncHandler(async (req, res) => {
    const asset = cleanText(req.body.asset, 15).toUpperCase();
    const amount = cleanText(req.body.amount, 50);
    const reference = cleanText(req.body.verificationReference, 180);

    if (
      !/^[A-Z0-9]{2,15}$/.test(asset) ||
      !positiveAmount(amount) ||
      reference.length < 8
    ) {
      return res.status(400).json({
        error: 'Valid asset, amount and verification reference are required.'
      });
    }

    await ledger.transfer({
      reference: 'inventory-funding:' + crypto
        .createHash('sha256')
        .update(reference)
        .digest('hex'),
      description: 'Record administrator-verified crypto inventory',
      asset,
      amount,
      from: platformAccount('external_clearing'),
      to: platformAccount('inventory'),
      allowNegativeSource: true,
      metadata: {
        verificationReference: reference,
        adminId: String(req.user._id),
        attestationOnly: true
      }
    });

    res.status(201).json({
      message: 'Inventory adjustment recorded. Verify blockchain receipt separately.',
      asset,
      amount
    });
  })
);

// --------------------------------------------------
// ADMIN: VIEW CUSTOMER LEDGER BALANCES
// --------------------------------------------------

router.get(
  '/admin/balances/:userId',
  requireDatabase,
  permission('customers.view'),
  asyncHandler(async (req, res) => {
    if (!validId(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid customer ID.' });
    }

    const accounts = await ledger.Account.find({
      ownerType: 'user',
      ownerId: String(req.params.userId)
    }).lean();

    res.json({
      balances: accounts.map(account => ({
        asset: account.asset,
        bucket: account.bucket,
        balance: ledger.fromUnits(account.balanceUnits)
      }))
    });
  })
);

// --------------------------------------------------
// ERROR HANDLER
// --------------------------------------------------

router.use((err, req, res, next) => {
  console.error('CoinWave orders error:', err);

  if (err.message === 'ASSET_PRICE_UNAVAILABLE') {
    return res.status(409).json({
      error: 'This asset has no active admin price configured.'
    });
  }

  if (err.message === 'QUOTE_TOO_SMALL') {
    return res.status(400).json({
      error: 'The calculated sell amount is too small after fees.'
    });
  }

  if (err.message === 'INVALID_PRICING_CONFIGURATION') {
    return res.status(503).json({
      error: 'The administrator pricing configuration is invalid.'
    });
  }

  if (err.code === 11000) {
    return res.status(409).json({
      error: 'This request conflicts with an existing record. Check the order before retrying.'
    });
  }

  if (
    err.code === 20 ||
    err.codeName === 'IllegalOperation' ||
    /Transaction numbers are only allowed/i.test(err.message || '')
  ) {
    return res.status(503).json({
      error: 'CoinWave requires MongoDB transaction support. Use a replica-set database.'
    });
  }

  res.status(500).json({
    error: 'An order operation could not be completed.'
  });
});

module.exports = router;
