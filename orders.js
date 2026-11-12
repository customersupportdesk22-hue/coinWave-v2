
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const auth = require('./auth');
const ledger = require('./ledger');

const router = express.Router();

const orderSchema = new mongoose.Schema({
  reference: {
    type: String,
    required: true,
    unique: true
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
  processedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });

const Order = mongoose.models.CWOrder ||
  mongoose.model('CWOrder', orderSchema);

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

const requireAdmin = asyncHandler(async (req, res, next) => {
  if (!auth.isAdmin(req.user)) {
    return res.status(403).json({
      error: 'Administrator access required.'
    });
  }

  next();
});

function userId(req) {
  return String(req.user._id || req.user.id);
}

function cleanText(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function validAmount(value) {
  try {
    return ledger.toUnits(value) > 0n;
  } catch {
    return false;
  }
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

/*
 * CUSTOMER: SUBMIT BUY OR SELL ORDER
 */
router.post(
  '/',
  requireDatabase,
  requireLogin,
  asyncHandler(async (req, res) => {
    const side = cleanText(req.body.side, 10).toLowerCase();
    const asset = cleanText(req.body.asset, 15).toUpperCase();
    const quantity = cleanText(req.body.quantity, 50);
    const quoteCurrency = cleanText(
      req.body.quoteCurrency,
      3
    ).toUpperCase();
    const quoteAmount = cleanText(req.body.quoteAmount, 50);
    const executionMode = cleanText(
      req.body.executionMode || 'manual',
      12
    ).toLowerCase();

    if (!['buy', 'sell'].includes(side)) {
      return res.status(400).json({
        error: 'Select buy or sell.'
      });
    }

    if (!/^[A-Z0-9]{2,15}$/.test(asset)) {
      return res.status(400).json({
        error: 'Invalid cryptocurrency.'
      });
    }

    if (!validAmount(quantity) || !validAmount(quoteAmount)) {
      return res.status(400).json({
        error: 'Enter valid positive amounts.'
      });
    }

    if (!['USD', 'KES'].includes(quoteCurrency)) {
      return res.status(400).json({
        error: 'Unsupported quote currency.'
      });
    }

    if (!['manual', 'automatic'].includes(executionMode)) {
      return res.status(400).json({
        error: 'Invalid execution mode.'
      });
    }

    /*
     * Automatic execution stays disabled until a real,
     * verified exchange adapter is installed.
     */
    if (executionMode === 'automatic') {
      return res.status(409).json({
        error: 'Automatic execution is not configured yet.',
        code: 'EXCHANGE_PROVIDER_REQUIRED'
      });
    }

    const paymentReference = cleanText(
      req.body.paymentReference,
      120
    );

    const payoutDestination = cleanText(
      req.body.payoutDestination,
      180
    );

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

    const session = await mongoose.startSession();
    let createdOrder;

    try {
      await session.withTransaction(async () => {
        const reference = 'CW-' +
          crypto.randomUUID().replace(/-/g, '').toUpperCase();

        const [order] = await Order.create([{
          reference,
          userId: req.user._id,
          side,
          asset,
          quantity,
          quoteCurrency,
          quoteAmount,
          executionMode,
          paymentReference,
          payoutDestination,
          payoutStatus: side === 'sell'
            ? 'pending'
            : 'not_required'
        }], { session });

        if (side === 'sell') {
          await ledger.transfer({
            session,
            reference: `order-reserve:${order._id}`,
            description: 'Reserve customer crypto for sell order',
            asset,
            amount: quantity,
            from: customerAccount(userId(req), 'available'),
            to: customerAccount(userId(req), 'locked'),
            metadata: { orderId: String(order._id) }
          });
        } else {
          await ledger.transfer({
            session,
            reference: `order-reserve:${order._id}`,
            description: 'Reserve platform crypto for buy order',
            asset,
            amount: quantity,
            from: platformAccount('inventory'),
            to: platformAccount('locked'),
            metadata: { orderId: String(order._id) }
          });
        }

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

/*
 * CUSTOMER: VIEW OWN ORDERS
 */
router.get(
  '/my',
  requireDatabase,
  requireLogin,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(
      50,
      Math.max(1, Number(req.query.limit) || 20)
    );

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

/*
 * ADMIN: VIEW ALL ORDERS
 */
router.get(
  '/admin',
  requireDatabase,
  requireLogin,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number(req.query.limit) || 30)
    );

    const filter = {};

    if (req.query.status) {
      filter.status = cleanText(req.query.status, 30);
    }

    if (req.query.side) {
      filter.side = cleanText(req.query.side, 10);
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

/*
 * ADMIN: VERIFY BUY PAYMENT
 * This records an administrator's verification.
 * It does not independently verify a bank transfer.
 */
router.post(
  '/admin/:id/verify-payment',
  requireDatabase,
  requireLogin,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const verificationReference = cleanText(
      req.body.verificationReference,
      120
    );

    if (!verificationReference) {
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
          paymentVerificationReference:
            verificationReference,
          adminId: req.user._id
        }
      },
      { new: true, runValidators: true }
    );

    if (!order) {
      return res.status(409).json({
        error: 'Order not found or payment cannot be verified.'
      });
    }

    res.json({
      message: 'Payment verification recorded.',
      order
    });
  })
);

/*
 * ADMIN: APPROVE ORDER
 */
router.post(
  '/admin/:id/approve',
  requireDatabase,
  requireLogin,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const session = await mongoose.startSession();
    let result;

    try {
      await session.withTransaction(async () => {
        const order = await Order.findOne({
          _id: req.params.id,
          status: 'pending'
        }).session(session);

        if (!order) {
          throw new Error('ORDER_NOT_PENDING');
        }

        if (order.executionMode !== 'manual') {
          throw new Error('AUTOMATIC_PROVIDER_NOT_CONFIGURED');
        }

        if (order.side === 'buy') {
          if (!order.paymentVerified) {
            throw new Error('PAYMENT_NOT_VERIFIED');
          }

          await ledger.transfer({
            session,
            reference: `order-complete:${order._id}`,
            description: 'Complete verified customer buy order',
            asset: order.asset,
            amount: order.quantity,
            from: platformAccount('locked'),
            to: customerAccount(order.userId, 'available'),
            metadata: { orderId: String(order._id) }
          });

          order.status = 'completed';
          order.payoutStatus = 'not_required';

        } else {
          await ledger.transfer({
            session,
            reference: `order-complete:${order._id}`,
            description: 'Complete customer crypto sell transfer',
            asset: order.asset,
            amount: order.quantity,
            from: customerAccount(order.userId, 'locked'),
            to: platformAccount('inventory'),
            metadata: { orderId: String(order._id) }
          });

          order.status = 'awaiting_payout';
          order.payoutStatus = 'pending';
        }

        order.adminId = req.user._id;
        order.processedAt = new Date();

        await order.save({ session });

        result = order;
      });

      res.json({
        message: result.status === 'awaiting_payout'
          ? 'Sell order approved. Payout is still pending.'
          : 'Buy order completed.',
        order: result
      });

    } catch (err) {
      const messages = {
        ORDER_NOT_PENDING: 'This order is no longer pending.',
        PAYMENT_NOT_VERIFIED: 'Verify the payment before approval.',
        AUTOMATIC_PROVIDER_NOT_CONFIGURED:
          'Automatic execution is not configured.',
      };

      if (messages[err.message]) {
        return res.status(409).json({
          error: messages[err.message]
        });
      }

      throw err;

    } finally {
      await session.endSession();
    }
  })
);

/*
 * ADMIN: REJECT ORDER AND RELEASE RESERVED FUNDS
 */
router.post(
  '/admin/:id/reject',
  requireDatabase,
  requireLogin,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const reason = cleanText(req.body.reason, 300);

    if (reason.length < 3) {
      return res.status(400).json({
        error: 'Provide a rejection reason.'
      });
    }

    const session = await mongoose.startSession();
    let result;

    try {
      await session.withTransaction(async () => {
        const order = await Order.findOne({
          _id: req.params.id,
          status: 'pending'
        }).session(session);

        if (!order) {
          throw new Error('ORDER_NOT_PENDING');
        }

        const from = order.side === 'sell'
          ? customerAccount(order.userId, 'locked')
          : platformAccount('locked');

        const to = order.side === 'sell'
          ? customerAccount(order.userId, 'available')
          : platformAccount('inventory');

        await ledger.transfer({
          session,
          reference: `order-release:${order._id}`,
          description: 'Release reserved funds for rejected order',
          asset: order.asset,
          amount: order.quantity,
          from,
          to,
          metadata: {
            orderId: String(order._id),
            reason
          }
        });

        order.status = 'rejected';
        order.rejectionReason = reason;
        order.adminId = req.user._id;
        order.processedAt = new Date();

        await order.save({ session });

        result = order;
      });

      res.json({
        message: 'Order rejected and reserved funds released.',
        order: result
      });

    } catch (err) {
      if (err.message === 'ORDER_NOT_PENDING') {
        return res.status(409).json({
          error: 'This order is no longer pending.'
        });
      }

      throw err;

    } finally {
      await session.endSession();
    }
  })
);

/*
 * ADMIN: RECORD A COMPLETED SELL PAYOUT
 * Admin must have actually sent the customer's fiat payment.
 */
router.post(
  '/admin/:id/complete-payout',
  requireDatabase,
  requireLogin,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const payoutReference = cleanText(
      req.body.payoutReference,
      120
    );

    if (!payoutReference) {
      return res.status(400).json({
        error: 'Payout reference is required.'
      });
    }

    const order = await Order.findOneAndUpdate(
      {
        _id: req.params.id,
        side: 'sell',
        status: 'awaiting_payout',
        payoutStatus: 'pending'
      },
      {
        $set: {
          payoutStatus: 'paid',
          payoutReference,
          status: 'completed',
          adminId: req.user._id,
          processedAt: new Date()
        }
      },
      { new: true, runValidators: true }
    );

    if (!order) {
      return res.status(409).json({
        error: 'Order is not awaiting payout.'
      });
    }

    res.json({
      message: 'Payout marked as completed.',
      order
    });
  })
);

/*
 * ADMIN: RECORD VERIFIED CRYPTO INVENTORY RECEIVED.
 * This is not a blockchain verifier. Admin must verify receipt
 * independently before recording the funding.
 */
router.post(
  '/admin/inventory/fund',
  requireDatabase,
  requireLogin,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const asset = cleanText(req.body.asset, 15).toUpperCase();
    const amount = cleanText(req.body.amount, 50);
    const verificationReference = cleanText(
      req.body.verificationReference,
      120
    );

    if (
      !/^[A-Z0-9]{2,15}$/.test(asset) ||
      !validAmount(amount) ||
      !verificationReference
    ) {
      return res.status(400).json({
        error: 'Valid asset, amount and verification reference are required.'
      });
    }

    await ledger.transfer({
      reference: 'inventory-funding:' + verificationReference,
      description: 'Record verified CoinWave crypto inventory',
      asset,
      amount,
      from: platformAccount('external_clearing'),
      to: platformAccount('inventory'),
      allowNegativeSource: true,
      metadata: {
        verificationReference,
        adminId: String(req.user._id)
      }
    });

    res.status(201).json({
      message: 'Inventory funding recorded.',
      asset,
      amount
    });
  })
);

/*
 * ADMIN: VIEW CUSTOMER BALANCES
 */
router.get(
  '/admin/balances/:userId',
  requireDatabase,
  requireLogin,
  requireAdmin,
  asyncHandler(async (req, res) => {
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

module.exports = router;
