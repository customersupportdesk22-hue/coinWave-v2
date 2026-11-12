
'use strict';

const mongoose = require('mongoose');

const SCALE = 18;
const FACTOR = 10n ** BigInt(SCALE);

const ASSET_PATTERN = /^[A-Z0-9]{2,15}$/;
const OWNER_TYPES = ['user', 'platform'];
const BUCKETS = [
  'available',
  'locked',
  'inventory',
  'external_clearing'
];

// --------------------------------------------------
// EXACT AMOUNT CONVERSION
// --------------------------------------------------

function toUnits(value) {
  const input = String(value ?? '').trim();

  if (!/^\d+(\.\d{1,18})?$/.test(input)) {
    throw new Error(
      'Invalid amount. Use up to 18 decimal places.'
    );
  }

  const [whole, fraction = ''] = input.split('.');

  return (
    BigInt(whole) * FACTOR +
    BigInt(
      (fraction + '0'.repeat(SCALE)).slice(0, SCALE)
    )
  );
}

function fromUnits(units) {
  const value = BigInt(units);

  const negative = value < 0n;
  const absolute = negative ? -value : value;

  const whole = absolute / FACTOR;

  const fraction = (absolute % FACTOR)
    .toString()
    .padStart(SCALE, '0')
    .replace(/0+$/, '');

  const result = fraction
    ? `${whole}.${fraction}`
    : whole.toString();

  return negative ? `-${result}` : result;
}

// --------------------------------------------------
// VALIDATION
// --------------------------------------------------

function normalizeAsset(asset) {
  const value = String(asset || '').trim().toUpperCase();

  if (!ASSET_PATTERN.test(value)) {
    throw new Error('Invalid asset symbol.');
  }

  return value;
}

function validateAccount(account) {
  if (!account || typeof account !== 'object') {
    throw new Error('Invalid ledger account.');
  }

  if (!OWNER_TYPES.includes(account.ownerType)) {
    throw new Error('Invalid ledger account owner type.');
  }

  const ownerId = String(account.ownerId || '').trim();

  if (!ownerId || ownerId.length > 150) {
    throw new Error('Invalid ledger account owner ID.');
  }

  if (!BUCKETS.includes(account.bucket)) {
    throw new Error('Invalid ledger account bucket.');
  }

  return {
    ownerType: account.ownerType,
    ownerId,
    bucket: account.bucket
  };
}

function accountKey(account) {
  return [
    account.ownerType,
    account.ownerId,
    account.bucket
  ].join(':');
}

// --------------------------------------------------
// LEDGER ACCOUNT MODEL
// --------------------------------------------------

const accountSchema = new mongoose.Schema({
  ownerType: {
    type: String,
    enum: OWNER_TYPES,
    required: true
  },

  ownerId: {
    type: String,
    required: true,
    maxlength: 150
  },

  asset: {
    type: String,
    required: true,
    uppercase: true,
    match: ASSET_PATTERN
  },

  bucket: {
    type: String,
    enum: BUCKETS,
    required: true
  },

  balanceUnits: {
    type: String,
    default: '0',
    required: true,
    match: /^-?\d+$/
  }

}, {
  timestamps: true,
  optimisticConcurrency: true
});

accountSchema.index(
  {
    ownerType: 1,
    ownerId: 1,
    asset: 1,
    bucket: 1
  },
  { unique: true }
);

// --------------------------------------------------
// LEDGER TRANSACTION MODEL
// --------------------------------------------------

const transactionSchema = new mongoose.Schema({
  reference: {
    type: String,
    required: true,
    unique: true,
    maxlength: 180
  },

  description: {
    type: String,
    required: true,
    maxlength: 300
  },

  asset: {
    type: String,
    required: true,
    uppercase: true,
    match: ASSET_PATTERN
  },

  amount: {
    type: String,
    required: true
  },

  amountUnits: {
    type: String,
    required: true,
    match: /^\d+$/
  },

  fromAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CWLedgerAccount',
    required: true
  },

  toAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CWLedgerAccount',
    required: true
  },

  status: {
    type: String,
    enum: ['posted'],
    default: 'posted'
  },

  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }

}, { timestamps: true });

// --------------------------------------------------
// LEDGER ENTRY MODEL
// --------------------------------------------------

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

  amountUnits: {
    type: String,
    required: true,
    match: /^\d+$/
  },

  asset: {
    type: String,
    required: true,
    uppercase: true,
    match: ASSET_PATTERN
  }

}, { timestamps: true });

entrySchema.index({
  accountId: 1,
  createdAt: -1
});

entrySchema.index(
  {
    transactionId: 1,
    accountId: 1,
    side: 1
  },
  { unique: true }
);

// --------------------------------------------------
// MODELS
// --------------------------------------------------

const Account = mongoose.models.CWLedgerAccount ||
  mongoose.model('CWLedgerAccount', accountSchema);

const LedgerTransaction =
  mongoose.models.CWLedgerTransaction ||
  mongoose.model(
    'CWLedgerTransaction',
    transactionSchema
  );

const LedgerEntry = mongoose.models.CWLedgerEntry ||
  mongoose.model('CWLedgerEntry', entrySchema);

// --------------------------------------------------
// FIND OR CREATE ACCOUNT
// --------------------------------------------------

async function getAccount({
  ownerType,
  ownerId,
  asset,
  bucket,
  session
}) {
  const account = validateAccount({
    ownerType,
    ownerId,
    bucket
  });

  const symbol = normalizeAsset(asset);

  return Account.findOneAndUpdate(
    {
      ...account,
      asset: symbol
    },
    {
      $setOnInsert: {
        balanceUnits: '0'
      }
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
      runValidators: true,
      session
    }
  );
}

// --------------------------------------------------
// EXISTING TRANSACTION CHECK
// --------------------------------------------------

async function findExistingTransaction({
  reference,
  asset,
  amountUnits,
  fromAccount,
  toAccount,
  session
}) {
  const existing = await LedgerTransaction.findOne({
    reference
  }).session(session);

  if (!existing) {
    return null;
  }

  const sameTransaction =
    existing.asset === asset &&
    existing.amountUnits === amountUnits.toString() &&
    String(existing.fromAccountId) === String(fromAccount._id) &&
    String(existing.toAccountId) === String(toAccount._id);

  if (!sameTransaction) {
    throw new Error(
      'Transaction reference already belongs to another operation.'
    );
  }

  // A matching retry is safe to recognize as already posted.
  return existing;
}

// --------------------------------------------------
// BALANCED LEDGER TRANSFER
// --------------------------------------------------

async function transfer(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('Invalid ledger transfer.');
  }

  const {
    from,
    to,
    amount,
    reference,
    description,
    metadata = {},
    session: suppliedSession,
    allowNegativeSource = false
  } = options;

  const asset = normalizeAsset(options.asset);

  if (
    typeof reference !== 'string' ||
    !reference.trim() ||
    reference.length > 180
  ) {
    throw new Error(
      'A valid transaction reference is required.'
    );
  }

  if (
    typeof description !== 'string' ||
    !description.trim() ||
    description.length > 300
  ) {
    throw new Error(
      'A valid transaction description is required.'
    );
  }

  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    throw new Error('Invalid transaction metadata.');
  }

  const amountUnits = toUnits(amount);

  if (amountUnits <= 0n) {
    throw new Error('Amount must be greater than zero.');
  }

  const sourceDetails = validateAccount(from);
  const destinationDetails = validateAccount(to);

  if (
    accountKey(sourceDetails) ===
    accountKey(destinationDetails)
  ) {
    throw new Error(
      'Source and destination accounts must differ.'
    );
  }

  // Negative balances are only permitted for the
  // platform external clearing account.
  if (allowNegativeSource) {
    if (
      sourceDetails.ownerType !== 'platform' ||
      sourceDetails.bucket !== 'external_clearing'
    ) {
      throw new Error(
        'Negative balances are only permitted for platform external clearing.'
      );
    }
  }

  const session = suppliedSession ||
    await mongoose.startSession();

  const ownsSession = !suppliedSession;

  try {
    const execute = async () => {
      const source = await getAccount({
        ...sourceDetails,
        asset,
        session
      });

      const destination = await getAccount({
        ...destinationDetails,
        asset,
        session
      });

      // Safe idempotency check after account resolution.
      const existing = await findExistingTransaction({
        reference: reference.trim(),
        asset,
        amountUnits,
        fromAccount: source,
        toAccount: destination,
        session
      });

      if (existing) {
        return existing;
      }

      const sourceBalance = BigInt(
        source.balanceUnits || '0'
      );

      const destinationBalance = BigInt(
        destination.balanceUnits || '0'
      );

      if (
        !allowNegativeSource &&
        sourceBalance < amountUnits
      ) {
        throw new Error(
          'Insufficient available balance.'
        );
      }

      // Apply exactly equal debit and credit amounts.
      source.balanceUnits = (
        sourceBalance - amountUnits
      ).toString();

      destination.balanceUnits = (
        destinationBalance + amountUnits
      ).toString();

      await source.save({ session });
      await destination.save({ session });

      const [transaction] =
        await LedgerTransaction.create([{
          reference: reference.trim(),
          description: description.trim(),
          asset,
          amount: fromUnits(amountUnits),
          amountUnits: amountUnits.toString(),
          fromAccountId: source._id,
          toAccountId: destination._id,
          status: 'posted',
          metadata
        }], { session });

      // Every posted transfer must have two matching entries.
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

    // When called inside another transaction, use its session.
    if (!ownsSession) {
      return await execute();
    }

    let result;

    await session.withTransaction(
      async () => {
        result = await execute();
      },
      {
        readPreference: 'primary',
        readConcern: {
          level: 'snapshot'
        },
        writeConcern: {
          w: 'majority'
        }
      }
    );

    return result;

  } finally {
    if (ownsSession) {
      await session.endSession();
    }
  }
}

// --------------------------------------------------
// READ ACCOUNT BALANCE
// --------------------------------------------------

async function getBalance({
  ownerType,
  ownerId,
  asset,
  bucket = 'available'
}) {
  const accountDetails = validateAccount({
    ownerType,
    ownerId,
    bucket
  });

  const symbol = normalizeAsset(asset);

  const account = await Account.findOne({
    ...accountDetails,
    asset: symbol
  }).lean();

  return account
    ? fromUnits(account.balanceUnits)
    : '0';
}

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
  Account,
  LedgerTransaction,
  LedgerEntry,
  transfer,
  getBalance,
  toUnits,
  fromUnits
};
