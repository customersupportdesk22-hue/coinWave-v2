
'use strict';

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

const app = express();

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;
const CACHE_MS = 60 * 1000;
const API_TIMEOUT_MS = 12000;
const ROOT = __dirname;

const allowedOrigins = new Set(
  String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
);

// --------------------------------------------------
// SECURITY HEADERS
// --------------------------------------------------

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// --------------------------------------------------
// CORS
// --------------------------------------------------

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, false);
    }

    let normalized;

    try {
      normalized = new URL(origin).origin;
    } catch {
      return callback(null, false);
    }

    return callback(null, allowedOrigins.has(normalized));
  },

  credentials: true,

  methods: [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS'
  ],

  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Idempotency-Key',
    'X-Request-ID'
  ],

  exposedHeaders: [
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-Market-Data-Stale'
  ],

  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

// --------------------------------------------------
// BROWSER ORIGIN PROTECTION
// --------------------------------------------------

const unsafeMethods = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE'
]);

function isTrustedOrigin(origin, req) {
  if (!origin || origin === 'null') {
    return false;
  }

  let normalized;

  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }

  const ownOrigin = `${req.protocol}://${req.get('host')}`;

  return normalized === ownOrigin || allowedOrigins.has(normalized);
}

app.use((req, res, next) => {
  if (!unsafeMethods.has(req.method)) {
    return next();
  }

  const origin = req.get('origin');

  if (origin) {
    if (!isTrustedOrigin(origin, req)) {
      return res.status(403).json({
        error: 'Request origin is not allowed.'
      });
    }

    return next();
  }

  const referer = req.get('referer');

  if (referer && !isTrustedOrigin(referer, req)) {
    return res.status(403).json({
      error: 'Request origin is not allowed.'
    });
  }

  return next();
});

// --------------------------------------------------
// REQUEST BODY
// --------------------------------------------------

app.use(express.json({
  limit: '1mb',
  strict: true
}));

app.use(express.urlencoded({
  extended: false,
  limit: '100kb'
}));

// --------------------------------------------------
// PUBLIC WEBSITE PAGES
// --------------------------------------------------

function sendFirst(res, candidates, noStore = false) {
  for (const candidate of candidates) {
    const filePath = path.resolve(ROOT, candidate);

    if (
      path.dirname(filePath) !== ROOT &&
      !filePath.startsWith(ROOT + path.sep)
    ) {
      continue;
    }

    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        if (noStore) {
          res.set('Cache-Control', 'no-store');
        }

        return res.sendFile(filePath);
      }
    } catch (error) {
      console.error('Static page check failed:', error.message);
    }
  }

  return res.status(404).send('Page not found');
}

app.get('/', (req, res) => {
  sendFirst(res, ['index.html'], true);
});

app.get(['/login', '/signup'], (req, res) => {
  sendFirst(res, ['account.html'], true);
});

app.get('/dashboard', (req, res) => {
  sendFirst(res, ['dashboard.html'], true);
});

app.get('/admin', (req, res) => {
  sendFirst(res, ['admin.html'], true);
});

app.get('/terms', (req, res) => {
  sendFirst(res, ['terms.html'], true);
});

app.get('/privacy', (req, res) => {
  sendFirst(res, ['privacy.html'], true);
});

// --------------------------------------------------
// ASSET DETAIL PAGE
// --------------------------------------------------

app.get('/asset', (req, res) => {
  const symbol = String(req.query.symbol || '')
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9]{1,15}$/.test(symbol)) {
    return res.status(400).send(
      'A valid asset symbol is required.'
    );
  }

  res.set('Cache-Control', 'no-store');

  return sendFirst(res, ['asset.html'], true);
});

// --------------------------------------------------
// DISCOVER PAGES
// --------------------------------------------------

const discoverPages = new Set([
  'markets',
  'buy-sell',
  'security',
  'transactions',
  'account',
  'support'
]);

app.get('/discover/:page', (req, res) => {
  const page = String(req.params.page || '').toLowerCase();

  if (!discoverPages.has(page)) {
    return res.status(404).send('Discover page not found.');
  }

  res.set('Cache-Control', 'no-store');

  return sendFirst(res, ['discover.html'], true);
});

// --------------------------------------------------
// EXPLICIT PUBLIC CSS AND JAVASCRIPT
// --------------------------------------------------

app.get(['/style.css', '/css/style.css'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  sendFirst(res, ['style.css', 'css/style.css']);
});

app.get(['/app.js', '/js/app.js'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  sendFirst(res, ['app.js', 'js/app.js']);
});

app.get('/coinwave-banner.png', (req, res) => {
  sendFirst(res, ['coinwave-banner.png']);
});

// --------------------------------------------------
// PUBLIC ASSETS DIRECTORY
// --------------------------------------------------

const assetsDirectory = path.join(ROOT, 'assets');

if (fs.existsSync(assetsDirectory)) {
  app.use('/assets', express.static(assetsDirectory, {
    dotfiles: 'deny',
    index: false,
    fallthrough: true,
    redirect: false,
    maxAge: '1h'
  }));
}

// --------------------------------------------------
// DATABASE STATUS
// --------------------------------------------------

let dbState = process.env.MONGO_URI
  ? 'connecting'
  : 'not_configured';

mongoose.connection.on('connected', () => {
  dbState = 'connected';
  console.log('MongoDB connected');
});

mongoose.connection.on('disconnected', () => {
  dbState = 'disconnected';
  console.warn('MongoDB disconnected');
});

mongoose.connection.on('error', error => {
  dbState = 'error';
  console.error('MongoDB error:', error.message);
});

function requireDatabase(req, res, next) {
  if (mongoose.connection.readyState === 1) {
    return next();
  }

  return res.status(503).json({
    error: 'Database is temporarily unavailable. Please try again shortly.',
    database: dbState
  });
}

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');

  const healthy = mongoose.connection.readyState === 1;

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    database: dbState,
    timestamp: new Date().toISOString()
  });
});

// --------------------------------------------------
// API ROUTES
// --------------------------------------------------

app.use('/api/auth', requireDatabase, require('./auth'));
app.use('/api/admin', requireDatabase, require('./admin'));
app.use('/api/orders', requireDatabase, require('./orders'));

// --------------------------------------------------
// MARKET DATA CACHE
// --------------------------------------------------

let cache = {
  time: 0,
  data: null
};

let marketRequest = null;

// --------------------------------------------------
// MARKET REQUEST RATE LIMIT
// --------------------------------------------------

const marketLimits = new Map();
const MARKET_WINDOW_MS = 60 * 1000;
const MARKET_MAX_REQUESTS = 60;

function marketRateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  let record = marketLimits.get(ip);

  if (!record || now - record.start >= MARKET_WINDOW_MS) {
    record = {
      start: now,
      count: 0
    };
  }

  record.count += 1;
  marketLimits.set(ip, record);

  if (marketLimits.size > 10000) {
    for (const [key, value] of marketLimits) {
      if (now - value.start >= MARKET_WINDOW_MS) {
        marketLimits.delete(key);
      }
    }
  }

  res.set('X-RateLimit-Limit', String(MARKET_MAX_REQUESTS));

  res.set(
    'X-RateLimit-Remaining',
    String(Math.max(0, MARKET_MAX_REQUESTS - record.count))
  );

  if (record.count > MARKET_MAX_REQUESTS) {
    res.set(
      'Retry-After',
      String(Math.max(
        1,
        Math.ceil(
          (record.start + MARKET_WINDOW_MS - now) / 1000
        )
      ))
    );

    return res.status(429).json({
      error: 'Too many market requests. Please try again shortly.'
    });
  }

  return next();
}

// --------------------------------------------------
// FETCH JSON WITH TIMEOUT
// Requires Node.js 18 or newer.
// --------------------------------------------------

async function fetchJson(url) {
  if (
    typeof fetch !== 'function' ||
    typeof AbortController !== 'function'
  ) {
    throw new Error('This server requires Node.js 18 or newer.');
  }

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    API_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(
        `Market provider returned status ${response.status}`
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------
// MARKET DATA VALIDATION
// --------------------------------------------------

function numberOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function sortByMarketCap(data) {
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter(coin => {
      const symbol = String(coin?.symbol || '');
      const marketCap = numberOrNull(coin?.marketCap);

      return (
        /^[A-Z0-9]{1,15}$/.test(symbol) &&
        marketCap !== null &&
        marketCap >= 0
      );
    })
    .sort((a, b) =>
      numberOrNull(b.marketCap) - numberOrNull(a.marketCap)
    )
    .map((coin, index) => ({
      ...coin,
      rank: index + 1
    }));
}

// --------------------------------------------------
// PRIMARY MARKET SOURCE: COINGECKO
// --------------------------------------------------

async function fromCoinGecko() {
  const url =
    'https://api.coingecko.com/api/v3/coins/markets' +
    '?vs_currency=usd' +
    '&order=market_cap_desc' +
    '&per_page=100' +
    '&page=1' +
    '&price_change_percentage=24h';

  const raw = await fetchJson(url);

  if (!Array.isArray(raw)) {
    throw new Error('Invalid CoinGecko response');
  }

  const data = raw.map(coin => ({
    rank: numberOrNull(coin.market_cap_rank),
    name: String(coin.name || ''),
    symbol: String(coin.symbol || '').toUpperCase(),
    image: coin.image || null,
    price: numberOrNull(coin.current_price),
    change24h: numberOrNull(coin.price_change_percentage_24h),
    volume24h: numberOrNull(coin.total_volume),
    marketCap: numberOrNull(coin.market_cap)
  }));

  return sortByMarketCap(data);
}

// --------------------------------------------------
// BACKUP MARKET SOURCE: COINPAPRIKA
// --------------------------------------------------

async function fromCoinPaprika() {
  const raw = await fetchJson(
    'https://api.coinpaprika.com/v1/tickers?quotes=USD'
  );

  if (!Array.isArray(raw)) {
    throw new Error('Invalid CoinPaprika response');
  }

  const data = raw
    .filter(coin =>
      Number(coin.rank) > 0 &&
      Number(coin.rank) <= 100
    )
    .map(coin => {
      const usd = coin.quotes?.USD || {};

      return {
        rank: numberOrNull(coin.rank),
        name: String(coin.name || ''),
        symbol: String(coin.symbol || '').toUpperCase(),

        image:
          'https://static.coinpaprika.com/coin/' +
          encodeURIComponent(String(coin.id || '')) +
          '/logo.png',

        price: numberOrNull(usd.price),
        change24h: numberOrNull(usd.percent_change_24h),
        volume24h: numberOrNull(usd.volume_24h),
        marketCap: numberOrNull(usd.market_cap)
      };
    });

  return sortByMarketCap(data);
}

// --------------------------------------------------
// MARKET DATA REFRESH
// --------------------------------------------------

async function refreshMarkets() {
  const sources = [
    {
      name: 'CoinGecko',
      getData: fromCoinGecko
    },
    {
      name: 'CoinPaprika',
      getData: fromCoinPaprika
    }
  ];

  for (const source of sources) {
    try {
      const data = await source.getData();

      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('No valid market data returned');
      }

      cache = {
        time: Date.now(),
        data
      };

      console.log(`${source.name} market data updated`);

      return data;
    } catch (error) {
      console.error(
        `${source.name} market error:`,
        error.name === 'AbortError'
          ? 'Request timed out'
          : error.message
      );
    }
  }

  if (cache.data && cache.data.length > 0) {
    console.warn('Using previously cached market data');
    return cache.data;
  }

  throw new Error('Market data is temporarily unavailable');
}

// --------------------------------------------------
// MARKET API
// --------------------------------------------------

app.get('/api/markets', marketRateLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (cache.data && Date.now() - cache.time < CACHE_MS) {
    return res.json(cache.data);
  }

  try {
    if (!marketRequest) {
      marketRequest = refreshMarkets().finally(() => {
        marketRequest = null;
      });
    }

    const data = await marketRequest;

    if (cache.time && Date.now() - cache.time >= CACHE_MS) {
      res.set('X-Market-Data-Stale', 'true');
    }

    return res.json(data);
  } catch (error) {
    console.error('Market API error:', error.message);

    return res.status(503).json({
      error: 'Market data is temporarily unavailable.',
      message: 'Please try again shortly.'
    });
  }
});

// --------------------------------------------------
// API NOT FOUND
// --------------------------------------------------

app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'API endpoint not found.'
  });
});

// --------------------------------------------------
// GLOBAL ERROR HANDLER
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error('CoinWave server error:', error.message);

  if (res.headersSent) {
    return next(error);
  }

  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Request body is too large.'
    });
  }

  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Invalid JSON request.'
    });
  }

  if (error?.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Submitted information is invalid.'
    });
  }

  return res.status(500).json({
    error: 'A server error occurred. Please try again.'
  });
});

// --------------------------------------------------
// DATABASE AND SERVER STARTUP
// --------------------------------------------------

async function startServer() {
  if (process.env.MONGO_URI) {
    try {
      await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 10000
      });

      dbState = 'connected';

      console.log('MongoDB connection established');
    } catch (error) {
      dbState = 'error';

      console.error(
        'MongoDB connection failed:',
        error.message
      );
    }
  } else {
    dbState = 'not_configured';
    console.error('MONGO_URI is not configured');
  }

  const server = app.listen(PORT, () => {
    console.log(`CoinWave v2 running on port ${PORT}`);
  });

  server.requestTimeout = 30000;
  server.headersTimeout = 35000;
  server.keepAliveTimeout = 5000;

  return server;
}

startServer().catch(error => {
  console.error('CoinWave startup error:', error.message);
  process.exit(1);
});

module.exports = app;
