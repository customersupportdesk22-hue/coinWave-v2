
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

const MAX_WHOLE_DIGITS = 36;
const MAX_METADATA_BYTES = 8192;

// --------------------------------------------------
// EXACT AMOUNT CONVERSION
// --------------------------------------------------

function toUnits(value) {
  const input = String(value ?? '').trim();

  const pattern = new RegExp(
    '^\\d{1,' + MAX_WHOLE_DIGITS +
    '}(\\.\\d{1,18})?$'
  );

  if (!pattern.test(input)) {
    throw new Error(
      'Invalid amount. Use up to 36 whole digits and 18 decimal places.'
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
  const value = String(asset || '')
    .trim()
    .toUpperCase();

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

  // External clearing and platform inventory
  // must never belong to a customer.
  if (
    ['inventory', 'external_clearing'].includes(account.bucket) &&
    account.ownerType !== 'platform'
  ) {
    throw new Error(
      'This ledger bucket is reserved for platform accounts.'
    );
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

function readBalanceUnits(value) {
  const input = String(value ?? '0');

  if (!/^-?\d+$/.test(input)) {
    throw new Error('Invalid stored ledger balance.');
  }

  return BigInt(input);
}

// --------------------------------------------------
// METADATA VALIDATION
// --------------------------------------------------

function validateMetadata(metadata) {
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    throw new Error('Invalid transaction metadata.');
  }

  let serialized;

  try {
    serialized = JSON.stringify(metadata);
  } catch {
    throw new Error(
      'Transaction metadata must be JSON serializable.'
    );
  }

  if (
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES
  ) {
    throw new Error(
      'Transaction metadata exceeds the allowed size.'
    );
  }

  try {
    return JSON.parse(serialized);
  } catch {
    throw new Error('Invalid transaction metadata.');
  }
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
  {
    unique: true,
    name: 'cw_ledger_account_unique'
  }
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

}, {
  timestamps: true
});

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

}, {
  timestamps: true
});

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
  {
    unique: true,
    name: 'cw_ledger_entry_unique'
  }
);

// --------------------------------------------------
// MODELS
// --------------------------------------------------

const Account =
  mongoose.models.CWLedgerAccount ||
  mongoose.model('CWLedgerAccount', accountSchema);

const LedgerTransaction =
  mongoose.models.CWLedgerTransaction ||
  mongoose.model(
    'CWLedgerTransaction',
    transactionSchema
  );

const LedgerEntry =
  mongoose.models.CWLedgerEntry ||
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
  let query = LedgerTransaction.findOne({
    reference
  });

  if (session) {
    query = query.session(session);
  }

  const existing = await query;

  if (!existing) {
    return null;
  }

  // Legacy transactions without amountUnits must be
  // reconciled rather than assumed to be safe retries.
  if (!existing.amountUnits) {
    throw new Error(
      'This transaction uses an older ledger format and requires reconciliation.'
    );
  }

  const sameTransaction =
    existing.status === 'posted' &&
    existing.asset === asset &&
    existing.amountUnits === amountUnits.toString() &&
    String(existing.fromAccountId) === String(fromAccount._id) &&
    String(existing.toAccountId) === String(toAccount._id);

  if (!sameTransaction) {
    throw new Error(
      'Transaction reference already belongs to another operation.'
    );
  }

  return existing;
}

// --------------------------------------------------
// TRANSFER VALIDATION
// --------------------------------------------------

function validateTransfer(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('Invalid ledger transfer.');
  }

  const reference = String(options.reference || '').trim();

  if (!reference || reference.length > 180) {
    throw new Error(
      'A valid transaction reference is required.'
    );
  }

  const description = String(
    options.description || ''
  ).trim();

  if (!description || description.length > 300) {
    throw new Error(
      'A valid transaction description is required.'
    );
  }

  const asset = normalizeAsset(options.asset);
  const amountUnits = toUnits(options.amount);

  if (amountUnits <= 0n) {
    throw new Error('Amount must be greater than zero.');
  }

  const from = validateAccount(options.from);
  const to = validateAccount(options.to);

  if (accountKey(from) === accountKey(to)) {
    throw new Error(
      'Source and destination accounts must differ.'
    );
  }

  const allowNegativeSource =
    options.allowNegativeSource === true;

  if (
    allowNegativeSource &&
    (
      from.ownerType !== 'platform' ||
      from.bucket !== 'external_clearing'
    )
  ) {
    throw new Error(
      'Negative balances are only permitted for platform external clearing.'
    );
  }

  return {
    reference,
    description,
    asset,
    amountUnits,
    from,
    to,
    allowNegativeSource,
    metadata: validateMetadata(options.metadata || {})
  };
}

// --------------------------------------------------
// INTERNAL TRANSFER EXECUTION
// --------------------------------------------------

async function executeTransfer(data, session) {
  const source = await getAccount({
    ...data.from,
    asset: data.asset,
    session
  });

  const destination = await getAccount({
    ...data.to,
    asset: data.asset,
    session
  });

  const existing = await findExistingTransaction({
    reference: data.reference,
    asset: data.asset,
    amountUnits: data.amountUnits,
    fromAccount: source,
    toAccount: destination,
    session
  });

  if (existing) {
    return existing;
  }

  const sourceBalance = readBalanceUnits(
    source.balanceUnits
  );

  const destinationBalance = readBalanceUnits(
    destination.balanceUnits
  );

  if (
    !data.allowNegativeSource &&
    sourceBalance < data.amountUnits
  ) {
    throw new Error(
      'Insufficient available balance.'
    );
  }

  const newSourceBalance =
    sourceBalance - data.amountUnits;

  const newDestinationBalance =
    destinationBalance + data.amountUnits;

  // Only the explicitly authorized platform clearing
  // source can become negative.
  if (
    newSourceBalance < 0n &&
    !data.allowNegativeSource
  ) {
    throw new Error(
      'This transfer would create a negative balance.'
    );
  }

  source.balanceUnits = newSourceBalance.toString();

  destination.balanceUnits =
    newDestinationBalance.toString();

  await source.save({ session });
  await destination.save({ session });

  const [transaction] =
    await LedgerTransaction.create([{
      reference: data.reference,
      description: data.description,
      asset: data.asset,
      amount: fromUnits(data.amountUnits),
      amountUnits: data.amountUnits.toString(),
      fromAccountId: source._id,
      toAccountId: destination._id,
      status: 'posted',
      metadata: data.metadata
    }], {
      session
    });

  // One debit and one equal credit for every transfer.
  await LedgerEntry.create([
    {
      transactionId: transaction._id,
      accountId: source._id,
      side: 'debit',
      amountUnits: data.amountUnits.toString(),
      asset: data.asset
    },
    {
      transactionId: transaction._id,
      accountId: destination._id,
      side: 'credit',
      amountUnits: data.amountUnits.toString(),
      asset: data.asset
    }
  ], {
    session
  });

  return transaction;
}

// --------------------------------------------------
// BALANCED LEDGER TRANSFER
// --------------------------------------------------

async function transfer(options) {
  const data = validateTransfer(options);

  const suppliedSession = options.session || null;
  const ownsSession = !suppliedSession;

  const session = suppliedSession ||
    await mongoose.startSession();

  let result;
  let failure = null;

  try {
    if (!ownsSession) {
      // The caller owns the outer transaction.
      // Do not commit or abort its session here.
      return await executeTransfer(data, session);
    }

    await session.withTransaction(
      async () => {
        result = await executeTransfer(data, session);
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

  } catch (err) {
    failure = err;

  } finally {
    if (ownsSession) {
      await session.endSession();
    }
  }

  if (failure) {
    // A concurrent request may have posted the same
    // reference first. Recognize it only if every
    // operation detail matches.
    if (
      ownsSession &&
      failure.code === 11000
    ) {
      const [source, destination] = await Promise.all([
        Account.findOne({
          ...data.from,
          asset: data.asset
        }),

        Account.findOne({
          ...data.to,
          asset: data.asset
        })
      ]);

      if (source && destination) {
        const existing = await findExistingTransaction({
          reference: data.reference,
          asset: data.asset,
          amountUnits: data.amountUnits,
          fromAccount: source,
          toAccount: destination
        });

        if (existing) {
          return existing;
        }
      }
    }

    throw failure;
  }

  return result;
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
    ? fromUnits(readBalanceUnits(account.balanceUnits))
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
