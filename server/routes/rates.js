import express from 'express';
import { pool } from '../db/database.js';
import { authMiddleware } from '../lib/auth.js';
import { asyncRoute, isAdmin, validNumber } from '../lib/http.js';
import { convertAmount, getCurrentRate, mapRate } from '../lib/rates.js';

const router = express.Router();

router.use(authMiddleware);

router.get('/', asyncRoute(async (req, res) => {
  res.json(await getCurrentRate(pool));
}));

router.get('/history', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM exchange_rates ORDER BY id DESC LIMIT 50');
  res.json(result.rows.map(mapRate));
}));

// Each revision is a new row, so a rate change never rewrites the rates that
// past movements were saved with.
router.put('/', asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Only the Director can update the reference exchange rate.' });
  }
  const { rwfPerUsd, cdfPerUsd, note } = req.body || {};
  if (!validNumber(rwfPerUsd, { minimum: 0.000001 }) || !validNumber(cdfPerUsd, { minimum: 0.000001 })) {
    return res.status(400).json({ message: 'Both rates must be greater than zero.' });
  }

  const result = await pool.query(
    `INSERT INTO exchange_rates (rwf_per_usd, cdf_per_usd, note, updated_by, updated_by_name)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [Number(rwfPerUsd), Number(cdfPerUsd), typeof note === 'string' ? note.trim().slice(0, 300) : '', req.user.id, req.user.name]
  );
  res.status(201).json(mapRate(result.rows[0]));
}));

// Conversion preview used by the create/edit form before a record is saved.
router.get('/convert', asyncRoute(async (req, res) => {
  const { amount, currency } = req.query;
  if (!validNumber(amount)) return res.status(400).json({ message: 'Amount must be a non-negative number.' });
  const rate = await getCurrentRate(pool);
  res.json({ rate, converted: convertAmount(amount, currency || 'RWF', rate.rwfPerUsd, rate.cdfPerUsd) });
}));

export default router;
