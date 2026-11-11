require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
['index.html', 'style.css', 'app.js'].forEach(function (f) {
  app.get(f === 'index.html' ? '/' : '/' + f, function (req, res) {
    res.sendFile(path.join(__dirname, f));
  });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Real market data, cached on the server so the page never flashes or hits rate limits.
const CACHE_MS = 60 * 1000;
let cache = { time: 0, data: null };

app.get('/api/markets', async (req, res) => {
  if (cache.data && Date.now() - cache.time < CACHE_MS) return res.json(cache.data);
  try {
    const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h';
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('Upstream status ' + r.status);
    const raw = await r.json();
    const data = raw.map(c => ({
      rank: c.market_cap_rank,
      name: c.name,
      symbol: (c.symbol || '').toUpperCase(),
      image: c.image,
      price: c.current_price,
      change24h: c.price_change_percentage_24h
    }));
    cache = { time: Date.now(), data };
    res.json(data);
  } catch (err) {
    console.error('Markets error:', err.message);
    if (cache.data) return res.json(cache.data);
    res.status(503).json({ error: 'Market data is temporarily unavailable.' });
  }
});

const PORT = process.env.PORT || 3000;
(async () => {
  if (process.env.MONGO_URI) {
    try { await mongoose.connect(process.env.MONGO_URI); console.log('MongoDB connected'); }
    catch (e) { console.error('MongoDB error:', e.message); }
  }
  app.listen(PORT, () => console.log('CoinWave v2 on port ' + PORT));
})();
