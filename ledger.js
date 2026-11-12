
'use strict';

const mongoose = require('mongoose');

const SCALE = 18;
const FACTOR = 10n ** BigInt(SCALE);

function toUnits(value) {
  const input = String(value ?? '').trim();

  if (!/^\d+(\.\d{1,18})?$/.test(input)) {
    throw new Error('Invalid amount. Use up to 18 decimal places.');
  }

  const [whole, fraction = ''] = input.split('.');
  return BigInt(whole) * FACTOR +
    BigInt((fraction + '0'.repeat(SCALE)).slice(0, SCALE));
}

function fromUnits(units) {
  const value = BigInt(units);
  const whole = value / FACTOR;
  const fraction = (value % FACTOR)
    .toString()
    .padStart(SCALE, '0')
    .replace(/0+$/, '');

  return fraction ? `${whole}.${fraction}` : whole.toString();
}

const accountSchema = new mongoose.Schema({
  ownerType: {
    type: String,
    enum: ['user', 'platform'],
    required: true
  },
  ownerId: { type: String, required: true },
  asset: { type: String, required: true },
  bucket: {
    type: String,
    enum: [
      'available',
      'locked',
      'inventory',
      'external_clearing'
    ],
    required: true
  },
  balanceUnits: {
    type: String,
    default: '0',
    required: true
  }
}, { timestamps: true });

accountSchema.index(
  { ownerType: 1, ownerId: 1, asset: 1, bucket: 1 },
  { unique: true }
);

const transactionSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  description: { type: String, required: true },
  asset: { type: String, required: true },
  amount: { type: String, required: true },
  status: {
    type: String,
    enum: ['posted'],
    default: 'posted'
  },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

const entrySchema = new mongoose.Schema({
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CWLedgerTransaction',
    required: true
  },
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CWLedgerAccount',
    required: true
  },
  side: {
    type: String,
    enum: ['debit', 'credit'],
    required: true
  },
  amountUnits: { type: String, required: true },
  asset: { type: String, required: true }
}, { timestamps: true });

entrySchema.index({ accountId: 1, createdAt: -1 });
entrySchema.index({ transactionId: 1 });

const Account = mongoose.models.CWLedgerAccount ||
  mongoose.model('CWLedgerAccount', accountSchema);

const LedgerTransaction = mongoose.models.CWLedgerTransaction ||
  mongoose.model('CWLedgerTransaction', transactionSchema);

const LedgerEntry = mongoose.models.CWLedgerEntry ||
  mongoose.model('CWLedgerEntry', entrySchema);

async function getAccount({
  ownerType,
  ownerId,
  asset,
  bucket,
  session
}) {
  return Account.findOneAndUpdate(
    { ownerType, ownerId, asset, bucket },
    {
      $setOnInsert: {
        balanceUnits: '0'
      }
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
      session
    }
  );
}

/*
 * A debit reduces the source account.
 * A credit increases the destination account.
 *
 * Every transfer creates equal debit and credit entries.
 * Regular customer accounts cannot go below zero.
 */
async function transfer(options) {
  const {
    from,
    to,
    asset,
    amount,
    reference,
    description,
    metadata = {},
    session: suppliedSession,
    allowNegativeSource = false
  } = options;

  if (!reference || reference.length > 180) {
    throw new Error('A valid transaction reference is required.');
  }

  if (!asset || !/^[A-Z0-9]{2,15}$/.test(asset)) {
    throw new Error('Invalid asset symbol.');
  }

  const amountUnits = toUnits(amount);

  if (amountUnits <= 0n) {
    throw new Error('Amount must be greater than zero.');
  }

  if (!from || !to) {
    throw new Error('Both ledger accounts are required.');
  }

  if (
    from.ownerType === to.ownerType &&
    from.ownerId === to.ownerId &&
    from.bucket === to.bucket
  ) {
    throw new Error('Source and destination accounts must differ.');
  }

  const session = suppliedSession ||
    await mongoose.startSession();

  const ownsSession = !suppliedSession;

  try {
    const execute = async () => {
      const existing = await LedgerTransaction.findOne({
        reference
      }).session(session);

      if (existing) {
        throw new Error('This transaction reference has already been processed.');
      }

      const source = await getAccount({
        ...from,
        asset,
        session
      });

      const destination = await getAccount({
        ...to,
        asset,
        session
      });

      const sourceBalance = BigInt(source.balanceUnits || '0');
      const destinationBalance = BigInt(destination.balanceUnits || '0');

      if (!allowNegativeSource && sourceBalance < amountUnits) {
        throw new Error('Insufficient available balance.');
      }

      source.balanceUnits = (
        sourceBalance - amountUnits
      ).toString();

      destination.balanceUnits = (
        destinationBalance + amountUnits
      ).toString();

      await source.save({ session });
      await destination.save({ session });

      const [transaction] = await LedgerTransaction.create([{
        reference,
        description,
        asset,
        amount: fromUnits(amountUnits),
        metadata
      }], { session });

      await LedgerEntry.create([
        {
          transactionId: transaction._id,
          accountId: source._id,
          side: 'debit',
          amountUnits: amountUnits.toString(),
          asset
        },
        {
          transactionId: transaction._id,
          accountId: destination._id,
          side: 'credit',
          amountUnits: amountUnits.toString(),
          asset
        }
      ], { session });

      return transaction;
    };

    if (!ownsSession) {
      return await execute();
    }

    let result;

    await session.withTransaction(async () => {
      result = await execute();
    });

    return result;
  } finally {
    if (ownsSession) {
      await session.endSession();
    }
  }
}

async function getBalance({
  ownerType,
  ownerId,
  asset,
  bucket = 'available'
}) {
  const account = await Account.findOne({
    ownerType,
    ownerId: String(ownerId),
    asset: asset.toUpperCase(),
    bucket
  }).lean();

  return account
    ? fromUnits(account.balanceUnits)
    : '0';
}

module.exports = {
  Account,
  LedgerTransaction,
  LedgerEntry,
  transfer,
  getBalance,
  toUnits,
  fromUnits
};
