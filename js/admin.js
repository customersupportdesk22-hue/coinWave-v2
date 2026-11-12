const express = require('express');
const mongoose = require('mongoose');
const auth = require('./auth');

const router = express.Router();

const Setting = mongoose.models.Setting || mongoose.model('Setting', new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { minimize: false }));

async function adminOnly(req, res, next) {
  if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'Server is not configured.' });
  if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'Service is starting. Try again in a moment.' });
  const user = await auth.authUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  if (!auth.isAdmin(user)) return res.status(403).json({ error: 'You do not have access to this page.' });
  next();
}
router.use(adminOnly);

const SYMBOL = /^[A-Z0-9]{1,15}$/;

router.get('/addresses', async (req, res) => {
  const doc = await Setting.findOne({ key: 'addresses' });
  res.json(doc ? doc.value : {});
});

router.put('/addresses/:symbol', async (req, res) => {
  const sym = String(req.params.symbol || '').toUpperCase();
  const address = String(req.body.address || '').trim();
  const network = String(req.body.network || '').trim().slice(0, 40);
  const memo = String(req.body.memo || '').trim().slice(0, 80);
  if (!SYMBOL.test(sym)) return res.status(400).json({ error: 'Invalid coin symbol.' });
  if (address.length < 10 || address.length > 150 || !/^[A-Za-z0-9:_\-.]+$/.test(address)) {
    return res.status(400).json({ error: 'Enter a valid wallet address (10 to 150 characters, no spaces).' });
  }
  const entry = { address, network, memo, updatedAt: new Date() };
  await Setting.findOneAndUpdate({ key: 'addresses' }, { $set: { ['value.' + sym]: entry } }, { upsert: true });
  res.json(entry);
});

router.delete('/addresses/:symbol', async (req, res) => {
  const sym = String(req.params.symbol || '').toUpperCase();
  if (!SYMBOL.test(sym)) return res.status(400).json({ error: 'Invalid coin symbol.' });
  await Setting.findOneAndUpdate({ key: 'addresses' }, { $unset: { ['value.' + sym]: '' } });
  res.json({ ok: true });
});

module.exports = router;
