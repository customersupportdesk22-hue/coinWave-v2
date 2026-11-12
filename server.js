
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

const app = express();

// --------------------------------------------------
// SECURITY AND MIDDLEWARE
// --------------------------------------------------

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(cors());

app.set('trust proxy', 1);

app.use(express.json({
  limit: '1mb'
}));

// Prevent private backend files from being served
// through the public static directory.
const privateFiles = new Set([
  'server.js',
  'auth.js',
  'admin.js',
  'orders.js',
  'ledger.js',
  'package.json',
  'package-lock.json',
  'yarn.lock'
]);

app.use((req, res, next) => {
  const filename = path.basename(req.path);

  if (privateFiles.has(filename)) {
    return res.sendStatus(404);
  }

  next();
});

app.use(express.static(__dirname));

// --------------------------------------------------
// API ROUTES
// --------------------------------------------------

app.use('/api/auth', require('./auth'));

app.use('/api/admin', require('./admin'));

// Customer and admin order management.
app.use('/api/orders', require('./orders'));

// --------------------------------------------------
// WEBSITE PAGE ROUTES
// --------------------------------------------------

function sendFirst(res, candidates) {
  for (const candidate of candidates) {
    const filePath = path.join(__dirname, candidate);

    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
  }

  return res.status(404).send('Page not found');
}

app.get('/', (req, res) => {
  sendFirst(res, ['index.html']);
});

app.get(['/login', '/signup'], (req, res) => {
  sendFirst(res, ['account.html']);
});

app.get('/dashboard', (req, res) => {
  res.set('Cache-Control', 'no-store');

  sendFirst(res, ['dashboard.html']);
});

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');

  sendFirst(res, ['admin.html']);
});

// Terms and Privacy pages.
app.get('/terms', (req, res) => {
  sendFirst(res, ['terms.html']);
});

app.get('/privacy', (req, res) => {
  sendFirst(res, ['privacy.html']);
});

// CSS and JavaScript compatibility routes.
app.get(['/style.css', '/css/style.css'], (req, res) => {
  sendFirst(res, ['style.css', 'css/style.css']);
});

app.get(['/app.js', '/js/app.js'], (req, res) => {
  sendFirst(res, ['app.js', 'js/app.js']);
});

// --------------------------------------------------
// DATABASE STATUS
// --------------------------------------------------

let dbState = process.env.MONGO_URI
  ? 'connecting'
  : 'MONGO_URI not set';

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.json({
    status: 'ok',
    db: dbState,
    jwt: process.env.JWT_SECRET ? 'set' : 'JWT_SECRET not set'
  });
});

// --------------------------------------------------
// MARKET DATA CACHE
// --------------------------------------------------

const CACHE_MS = 60 * 1000;
const API_TIMEOUT_MS = 12000;

let cache = {
  time: 0,
  data: null
};

// Fetch JSON with a timeout.
async function fetchJson(url) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(
        'API returned status ' + response.status
      );
    }

    return await response.json();

  } finally {
    clearTimeout(timer);
  }
}

// Validate and sort by market capitalization.
function sortByMarketCap(data) {
  return data
    .filter(c =>
      c &&
      typeof c === 'object' &&
      c.symbol &&
      Number.isFinite(Number(c.marketCap)) &&
      Number(c.marketCap) >= 0
    )
    .sort((a, b) =>
      Number(b.marketCap) - Number(a.marketCap)
    )
    .map((c, index) => ({
      ...c,
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

  const data = raw.map(c => ({
    rank: c.market_cap_rank,
    name: c.name,
    symbol: (c.symbol || '').toUpperCase(),
    image: c.image,
    price: c.current_price,
    change24h: c.price_change_percentage_24h,
    volume24h: c.total_volume,
    marketCap: c.market_cap
  }));

  return sortByMarketCap(data);
}

// --------------------------------------------------
// BACKUP MARKET SOURCE: COINPAPRIKA
// --------------------------------------------------

async function fromCoinPaprika() {
  const url =
    'https://api.coinpaprika.com/v1/tickers?quotes=USD';

  const raw = await fetchJson(url);

  if (!Array.isArray(raw)) {
    throw new Error('Invalid CoinPaprika response');
  }

  const data = raw
    .filter(c => c.rank > 0 && c.rank <= 100)
    .map(c => {
      const usd = c.quotes && c.quotes.USD
        ? c.quotes.USD
        : {};

      return {
        rank: c.rank,
        name: c.name,
        symbol: (c.symbol || '').toUpperCase(),

        image:
          'https://static.coinpaprika.com/coin/' +
          c.id +
          '/logo.png',

        price: usd.price ?? null,
        change24h: usd.percent_change_24h ?? null,
        volume24h: usd.volume_24h ?? null,
        marketCap: usd.market_cap ?? null
      };
    });

  return sortByMarketCap(data);
}

// --------------------------------------------------
// MARKET API
// --------------------------------------------------

app.get('/api/markets', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  // Return fresh cached market data.
  if (
    cache.data &&
    Date.now() - cache.time < CACHE_MS
  ) {
    return res.json(cache.data);
  }

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

      if (Array.isArray(data) && data.length > 0) {
        cache = {
          time: Date.now(),
          data
        };

        console.log(
          source.name + ' market data updated'
        );

        return res.json(data);
      }

      throw new Error(
        'No valid market data returned'
      );

    } catch (err) {
      console.error(
        source.name + ' market error:',
        err.name === 'AbortError'
          ? 'Request timed out'
          : err.message
      );
    }
  }

  // Use previous successful data if both providers fail.
  if (cache.data && cache.data.length) {
    console.warn(
      'Using previously cached market data'
    );

    return res.json(cache.data);
  }

  // No provider or cached data is available.
  return res.status(503).json({
    error: 'Market data is temporarily unavailable.',
    message: 'Please try again shortly.'
  });
});

// --------------------------------------------------
// API ERROR HANDLER
// Keep this after the API routes.
// --------------------------------------------------

app.use((err, req, res, next) => {
  console.error(
    'CoinWave server error:',
    err.message
  );

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    error: 'A server error occurred. Please try again.'
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const PORT = process.env.PORT || 3000;

(async () => {
  if (process.env.MONGO_URI) {
    try {
      await mongoose.connect(process.env.MONGO_URI);

      dbState = 'connected';

      console.log('MongoDB connected');

    } catch (err) {
      dbState = 'error';

      console.error(
        'MongoDB connection failed:',
        err.message
      );
    }

  } else {
    console.log(
      'MONGO_URI is not set, running without a database'
    );
  }

  app.listen(PORT, () => {
    console.log(
      'CoinWave v2 running on port ' + PORT
    );
  });
})();
