require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(__dirname));
app.use('/api/auth', require('./auth'));
app.use('/api/admin', require('./admin'));

// Serve a page file from the main folder, or from css/ or js/ if it lives there.
function sendFirst(res, candidates) {
  for (const c of candidates) {
    const p = path.join(__dirname, c);
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).send('Not found');
}
app.get('/', (req, res) => sendFirst(res, ['index.html']));
app.get(['/login', '/signup'], (req, res) => sendFirst(res, ['account.html']));
app.get('/dashboard', (req, res) => sendFirst(res, ['dashboard.html']));
app.get('/admin', (req, res) => { res.set('Cache-Control', 'no-store'); sendFirst(res, ['admin.html']); });
app.get(['/style.css', '/css/style.css'], (req, res) => sendFirst(res, ['style.css', 'css/style.css']));
app.get(['/app.js', '/js/app.js'], (req, res) => sendFirst(res, ['app.js', 'js/app.js']));

let dbState = process.env.MONGO_URI ? 'connecting' : 'MONGO_URI not set';
app.get('/api/health', (req, res) => res.json({ status: 'ok', db: dbState, jwt: process.env.JWT_SECRET ? 'set' : 'JWT_SECRET not set' }));

// Market data: two sources, cached so the page never flashes or hits rate limits.
const CACHE_MS = 60 * 1000;
let cache = { time: 0, data: null };

async function fromCoinGecko() {
  const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h';
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('CoinGecko status ' + r.status);
  const raw = await r.json();
  return raw.map(c => ({
    rank: c.market_cap_rank,
    name: c.name,
    symbol: (c.symbol || '').toUpperCase(),
    image: c.image,
    price: c.current_price,
    change24h: c.price_change_percentage_24h
  }));
}

async function fromCoinPaprika() {
  const r = await fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD', { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('CoinPaprika status ' + r.status);
  const raw = await r.json();
  return raw
    .filter(c => c.rank > 0 && c.rank <= 100)
    .sort((a, b) => a.rank - b.rank)
    .map(c => ({
      rank: c.rank,
      name: c.name,
      symbol: (c.symbol || '').toUpperCase(),
      image: 'https://static.coinpaprika.com/coin/' + c.id + '/logo.png',
      price: c.quotes && c.quotes.USD ? c.quotes.USD.price : null,
      change24h: c.quotes && c.quotes.USD ? c.quotes.USD.percent_change_24h : null
    }));
}

app.get('/api/markets', async (req, res) => {
  if (cache.data && Date.now() - cache.time < CACHE_MS) return res.json(cache.data);
  const sources = [fromCoinGecko, fromCoinPaprika];
  for (const source of sources) {
    try {
      const data = await source();
      if (data && data.length) {
        cache = { time: Date.now(), data };
        return res.json(data);
      }
    } catch (err) {
      console.error('Markets error:', err.message);
    }
  }
  if (cache.data) return res.json(cache.data);
  res.status(503).json({ error: 'Market data is temporarily unavailable.' });
});

const PORT = process.env.PORT || 3000;
(async () => {
  if (process.env.MONGO_URI) {
    try { await mongoose.connect(process.env.MONGO_URI); dbState = 'connected'; console.log('MongoDB connected'); }
    catch (e) { dbState = 'error: ' + e.message; console.error('MongoDB error:', e.message); }
  } else {
    console.log('MONGO_URI is not set, running without a database');
  }
  app.listen(PORT, () => console.log('CoinWave v2 on port ' + PORT));
})();
