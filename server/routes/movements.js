import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/database.js';
import { authMiddleware } from '../lib/auth.js';
import { asyncRoute, isAdmin, requiredText, validNumber, sectorIds } from '../lib/http.js';
import { CURRENCIES, convertAmount, getCurrentRate, round2 } from '../lib/rates.js';

const router = express.Router();

export const MOVEMENT_TYPES = ['Staff', 'Equipment', 'Materials', 'Field Operation', 'Other'];
export const MOVEMENT_STATUSES = ['Draft', 'Pending', 'Approved', 'Funds Released', 'Ongoing', 'Completed', 'Rejected', 'Cancelled'];
export const EVIDENCE_KINDS = ['Receipt', 'Invoice', 'Fuel Slip', 'Hotel Receipt', 'Transport Ticket', 'Payment Proof', 'Photograph', 'Other'];
export const EVIDENCE_STATUSES = ['Pending', 'Partial', 'Complete'];
const COST_FIELDS = ['transport', 'fuel', 'accommodation', 'meals', 'handling', 'other'];

// Which status can follow which. The Director can reinstate a rejected or
// cancelled request, and can reopen a completed one to correct the final figures.
const STATUS_FLOW = {
  Draft: ['Pending', 'Cancelled'],
  Pending: ['Approved', 'Rejected', 'Cancelled', 'Draft'],
  Approved: ['Funds Released', 'Ongoing', 'Rejected', 'Cancelled'],
  'Funds Released': ['Ongoing', 'Completed', 'Cancelled'],
  Ongoing: ['Completed', 'Cancelled'],
  Completed: ['Ongoing'],
  Rejected: ['Pending'],
  Cancelled: ['Pending']
};

const uploadRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads', 'movements');
fs.mkdirSync(uploadRoot, { recursive: true });

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf'
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, done) => done(null, uploadRoot),
    filename: (req, file, done) => {
      const extension = path.extname(file.originalname).toLowerCase().slice(0, 10);
      done(null, `${crypto.randomUUID()}${extension.replace(/[^a-z0-9.]/g, '')}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, done) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return done(new MovementError(400, 'Evidence must be a JPG, PNG, GIF, WEBP, HEIC image or a PDF.'));
    }
    done(null, true);
  }
});

class MovementError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function canCreate(user) {
  return isAdmin(user) || user.sector === 'movement';
}

// Section 7 keeps approval, funds and final expenditure with the Director.
function requireAdmin(user, action) {
  if (!isAdmin(user)) throw new MovementError(403, `Only the Director can ${action}.`);
}

function mapEvidence(row) {
  return {
    id: row.id,
    movementId: row.movement_id,
    kind: row.kind,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    amount: Number(row.amount),
    note: row.note,
    uploadedBy: row.uploaded_by,
    uploadedByName: row.uploaded_by_name,
    createdAt: row.created_at
  };
}

// node-postgres hands back a DATE column as a Date at local midnight. Sending
// that on as a timestamp shifts the calendar day for any reader in a different
// zone, so a date-only column leaves as a date-only string.
function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function mapHistory(row) {
  return {
    id: row.id,
    movementId: row.movement_id,
    action: row.action,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    actorId: row.actor_id,
    actorName: row.actor_name,
    createdAt: row.created_at
  };
}

export function mapMovement(row) {
  const currency = row.currency || 'RWF';
  const rwfPerUsd = Number(row.fx_rwf_per_usd) > 0 ? Number(row.fx_rwf_per_usd) : null;
  const cdfPerUsd = Number(row.fx_cdf_per_usd) > 0 ? Number(row.fx_cdf_per_usd) : null;
  const estimatedTotal = Number(row.cost);
  const fundsReleased = Number(row.funds_released);
  const actualExpense = Number(row.actual_expense);

  return {
    id: row.id,
    ref: row.ref,
    sector: row.sector,
    relatedArea: row.related_area || null,
    projectId: row.project_id || null,
    movementType: row.movement_type,
    purpose: row.purpose,
    origin: row.origin || '',
    destination: row.destination,
    departureDate: toDateOnly(row.departure_date),
    returnDate: toDateOnly(row.return_date),
    personTeam: row.person_team || '',
    transportType: row.transport_type || '',
    vehicleDriver: row.vehicle_driver || '',
    currency,
    status: row.status,
    category: row.category,
    notes: row.notes || '',
    costs: {
      transport: Number(row.cost_transport),
      fuel: Number(row.cost_fuel),
      accommodation: Number(row.cost_accommodation),
      meals: Number(row.cost_meals),
      handling: Number(row.cost_handling),
      other: Number(row.cost_other)
    },
    estimatedTotal,
    // Retained so the cross-module dashboard keeps reading one number.
    cost: estimatedTotal,
    fundsReleased,
    actualExpense,
    balanceReturn: round2(fundsReleased - actualExpense),
    evidenceStatus: row.evidence_status,
    evidenceCount: row.evidence_count === undefined ? undefined : Number(row.evidence_count),
    rate: {
      rwfPerUsd,
      cdfPerUsd,
      source: row.fx_source,
      recordedAt: row.fx_recorded_at
    },
    converted: rwfPerUsd && cdfPerUsd
      ? {
          estimatedTotal: convertAmount(estimatedTotal, currency, rwfPerUsd, cdfPerUsd),
          fundsReleased: convertAmount(fundsReleased, currency, rwfPerUsd, cdfPerUsd),
          actualExpense: convertAmount(actualExpense, currency, rwfPerUsd, cdfPerUsd),
          balanceReturn: convertAmount(round2(fundsReleased - actualExpense), currency, rwfPerUsd, cdfPerUsd)
        }
      : null,
    createdBy: row.created_by,
    createdByName: row.created_by_name || null,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name || null,
    approvedAt: row.approved_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const SELECT_MOVEMENT = `
  SELECT m.*,
         creator.name AS created_by_name,
         approver.name AS approved_by_name,
         (SELECT COUNT(*) FROM movement_evidence e WHERE e.movement_id = m.id) AS evidence_count
  FROM movements m
  LEFT JOIN users creator ON creator.id = m.created_by
  LEFT JOIN users approver ON approver.id = m.approved_by`;

// Admin sees everything. A manager assigned to the Movement area sees the whole
// module; a manager of another area sees the movements that supported it
// (section 5), which is the only movement data that concerns them.
function visibilityScope(user, values) {
  if (isAdmin(user) || user.sector === 'movement') return '';
  values.push(user.sector);
  return `m.related_area = $${values.length}`;
}

// Accepts a plain calendar date, and tolerates a full ISO timestamp so a record
// read back from the API can be edited and sent straight in again.
function isValidDate(value) {
  return value === null || value === undefined || value === ''
    || (/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(String(value)) && !Number.isNaN(Date.parse(String(value).slice(0, 10))));
}

function optionalDate(value) {
  if (value === '' || value === undefined || value === null) return null;
  return String(value).slice(0, 10);
}

function optionalText(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Shared shape validation for create and edit.
function readMovementPayload(payload) {
  if (!requiredText(payload.purpose)) throw new MovementError(400, 'Purpose is required.');
  if (!requiredText(payload.destination)) throw new MovementError(400, 'Destination is required.');
  if (!requiredText(payload.origin)) throw new MovementError(400, 'Origin is required.');

  const movementType = payload.movementType || 'Other';
  if (!MOVEMENT_TYPES.includes(movementType)) throw new MovementError(400, 'Movement type is invalid.');

  const currency = payload.currency || 'RWF';
  if (!CURRENCIES.includes(currency)) throw new MovementError(400, 'Currency must be RWF, USD or CDF.');

  // A movement is either standalone or linked to one other area of operation.
  // Logistics & Facilitation is never its own related area.
  const relatedArea = payload.relatedArea === '' || payload.relatedArea === undefined || payload.relatedArea === null
    ? null
    : payload.relatedArea;
  if (relatedArea !== null && (!sectorIds.has(relatedArea) || relatedArea === 'movement')) {
    throw new MovementError(400, 'Related area must be Farming, Agriculture or Mining, or left empty.');
  }

  if (!isValidDate(payload.departureDate) || !isValidDate(payload.returnDate)) {
    throw new MovementError(400, 'Departure and return dates must be valid calendar dates.');
  }
  const departureDate = optionalDate(payload.departureDate);
  const returnDate = optionalDate(payload.returnDate);
  if (departureDate && returnDate && returnDate < departureDate) {
    throw new MovementError(400, 'Return date cannot fall before the departure date.');
  }

  const costs = {};
  for (const field of COST_FIELDS) {
    const value = payload.costs?.[field];
    if (!validNumber(value === '' || value === undefined ? 0 : value)) {
      throw new MovementError(400, 'Every facilitation cost must be a non-negative number.');
    }
    costs[field] = round2(value === '' || value === undefined ? 0 : value);
  }
  const estimatedTotal = round2(COST_FIELDS.reduce((total, field) => total + costs[field], 0));

  return {
    purpose: payload.purpose.trim().slice(0, 200),
    destination: payload.destination.trim().slice(0, 200),
    origin: payload.origin.trim().slice(0, 200),
    movementType,
    currency,
    relatedArea,
    departureDate,
    returnDate,
    personTeam: optionalText(payload.personTeam),
    transportType: optionalText(payload.transportType, 100),
    vehicleDriver: optionalText(payload.vehicleDriver),
    category: optionalText(payload.category, 100) || movementType,
    notes: optionalText(payload.notes, 2000),
    costs,
    estimatedTotal
  };
}

// MF-2026-0048: a per-year counter, starting at one. The UPDATE locks the
// counter row for the transaction, so two concurrent requests cannot take the
// same number. References issued before this module existed do not follow the
// sequence, so a number already in use is skipped rather than seeding the
// counter from the highest one and starting the year in the thousands.
async function nextReference(client) {
  const year = new Date().getFullYear();
  await client.query(
    'INSERT INTO movement_ref_counters (year, last_number) VALUES ($1, 0) ON CONFLICT (year) DO NOTHING',
    [year]
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.query(
      'UPDATE movement_ref_counters SET last_number = last_number + 1 WHERE year = $1 RETURNING last_number',
      [year]
    );
    const ref = `MF-${year}-${String(result.rows[0].last_number).padStart(4, '0')}`;
    const taken = await client.query('SELECT 1 FROM movements WHERE ref = $1', [ref]);
    if (!taken.rowCount) return ref;
  }
  throw new MovementError(500, 'Could not allocate a movement reference number.');
}

async function logHistory(client, movementId, user, entries) {
  for (const entry of entries) {
    await client.query(
      `INSERT INTO movement_history (movement_id, action, field, old_value, new_value, actor_id, actor_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [movementId, entry.action, entry.field || null, stringify(entry.oldValue), stringify(entry.newValue), user.id, user.name]
    );
  }
}

function stringify(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

async function loadMovement(id, user) {
  const values = [id];
  const scope = visibilityScope(user, values);
  const result = await pool.query(
    `${SELECT_MOVEMENT} WHERE m.id = $1${scope ? ` AND ${scope}` : ''}`,
    values
  );
  if (!result.rowCount) throw new MovementError(404, 'Movement not found.');
  return result.rows[0];
}

function canEdit(user, row) {
  if (isAdmin(user)) return true;
  // A movement officer may correct their own request only while it is still
  // theirs to change; once it is with the Director it is read-only to them.
  return user.sector === 'movement'
    && row.created_by === user.id
    && ['Draft', 'Pending'].includes(row.status);
}

router.use(authMiddleware);

router.get('/', asyncRoute(async (req, res) => {
  const { status, relatedArea, currency, destination, personTeam, movementType, search, dateFrom, dateTo, limit } = req.query;
  const values = [];
  const filters = [];

  const scope = visibilityScope(req.user, values);
  if (scope) filters.push(scope);

  if (status && status !== 'All') {
    if (!MOVEMENT_STATUSES.includes(status)) return res.status(400).json({ message: 'Status filter is invalid.' });
    values.push(status);
    filters.push(`m.status = $${values.length}`);
  }
  if (relatedArea && relatedArea !== 'All') {
    if (relatedArea === 'None') {
      filters.push('m.related_area IS NULL');
    } else {
      values.push(relatedArea);
      filters.push(`m.related_area = $${values.length}`);
    }
  }
  if (currency && currency !== 'All') {
    values.push(currency);
    filters.push(`m.currency = $${values.length}`);
  }
  if (movementType && movementType !== 'All') {
    values.push(movementType);
    filters.push(`m.movement_type = $${values.length}`);
  }
  if (destination) {
    values.push(`%${destination}%`);
    filters.push(`m.destination ILIKE $${values.length}`);
  }
  if (personTeam) {
    values.push(`%${personTeam}%`);
    filters.push(`m.person_team ILIKE $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    filters.push(`(m.ref ILIKE $${values.length} OR m.purpose ILIKE $${values.length} OR m.destination ILIKE $${values.length} OR m.origin ILIKE $${values.length} OR m.person_team ILIKE $${values.length})`);
  }
  if (dateFrom) {
    if (!isValidDate(dateFrom)) return res.status(400).json({ message: 'dateFrom must be a valid date.' });
    values.push(dateFrom);
    filters.push(`COALESCE(m.departure_date, m.created_at::date) >= $${values.length}`);
  }
  if (dateTo) {
    if (!isValidDate(dateTo)) return res.status(400).json({ message: 'dateTo must be a valid date.' });
    values.push(dateTo);
    filters.push(`COALESCE(m.departure_date, m.created_at::date) <= $${values.length}`);
  }

  const requested = Number(limit || 200);
  const safeLimit = Number.isInteger(requested) && requested > 0 && requested <= 500 ? requested : 200;
  values.push(safeLimit);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(
    `${SELECT_MOVEMENT} ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT $${values.length}`,
    values
  );
  res.json(result.rows.map(mapMovement));
}));

// Dashboard tiles and headline totals (mockup section 2).
router.get('/summary', asyncRoute(async (req, res) => {
  const values = [];
  const scope = visibilityScope(req.user, values);
  const where = scope ? `WHERE ${scope}` : '';

  const [counts, rows, rate] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE m.status = 'Draft')::int AS draft,
              COUNT(*) FILTER (WHERE m.status = 'Pending')::int AS pending,
              COUNT(*) FILTER (WHERE m.status = 'Approved')::int AS approved,
              COUNT(*) FILTER (WHERE m.status = 'Funds Released')::int AS funds_released,
              COUNT(*) FILTER (WHERE m.status = 'Ongoing')::int AS ongoing,
              COUNT(*) FILTER (WHERE m.status = 'Completed')::int AS completed,
              COUNT(*) FILTER (WHERE m.status = 'Rejected')::int AS rejected,
              COUNT(*) FILTER (WHERE m.status = 'Cancelled')::int AS cancelled
       FROM movements m ${where}`,
      values
    ),
    pool.query(`SELECT m.* FROM movements m ${where} LIMIT 5000`, values),
    getCurrentRate(pool)
  ]);

  const totals = accumulate(rows.rows, rate);
  res.json({
    counts: {
      total: counts.rows[0].total,
      draft: counts.rows[0].draft,
      pending: counts.rows[0].pending,
      approved: counts.rows[0].approved,
      fundsReleased: counts.rows[0].funds_released,
      ongoing: counts.rows[0].ongoing,
      completed: counts.rows[0].completed,
      rejected: counts.rows[0].rejected,
      cancelled: counts.rows[0].cancelled
    },
    totals,
    rate
  });
}));

// Section 9 reporting. Mixed-currency records are normalised through each
// record's own frozen rate into USD, then presented in all three currencies
// using the current reference rate, so the figures are comparable.
router.get('/reports', asyncRoute(async (req, res) => {
  const values = [];
  const scope = visibilityScope(req.user, values);
  const filters = scope ? [scope] : [];

  if (req.query.dateFrom) {
    if (!isValidDate(req.query.dateFrom)) return res.status(400).json({ message: 'dateFrom must be a valid date.' });
    values.push(req.query.dateFrom);
    filters.push(`COALESCE(m.departure_date, m.created_at::date) >= $${values.length}`);
  }
  if (req.query.dateTo) {
    if (!isValidDate(req.query.dateTo)) return res.status(400).json({ message: 'dateTo must be a valid date.' });
    values.push(req.query.dateTo);
    filters.push(`COALESCE(m.departure_date, m.created_at::date) <= $${values.length}`);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const [result, rate] = await Promise.all([
    pool.query(`SELECT m.* FROM movements m ${where} ORDER BY m.created_at DESC LIMIT 5000`, values),
    getCurrentRate(pool)
  ]);
  const rows = result.rows;

  const byMonth = groupTotals(rows, rate, (row) => {
    const source = row.departure_date || row.created_at;
    return new Date(source).toISOString().slice(0, 7);
  });
  const byArea = groupTotals(rows, rate, (row) => row.related_area || 'unlinked');
  const byCurrency = groupTotals(rows, rate, (row) => row.currency);
  const byStatus = groupTotals(rows, rate, (row) => row.status);
  const byDestination = groupTotals(rows, rate, (row) => row.destination);

  // Fuel and transport are called out separately in section 9.
  const fuelAndTransport = rows.reduce(
    (carry, row) => {
      const converted = usdOf(row, rate);
      carry.fuelUsd += converted(row.cost_fuel);
      carry.transportUsd += converted(row.cost_transport);
      return carry;
    },
    { fuelUsd: 0, transportUsd: 0 }
  );

  res.json({
    generatedAt: new Date().toISOString(),
    rate,
    movementCount: rows.length,
    totals: accumulate(rows, rate),
    outstanding: rows.filter((row) => ['Draft', 'Pending', 'Approved', 'Funds Released', 'Ongoing'].includes(row.status)).length,
    completed: rows.filter((row) => row.status === 'Completed').length,
    evidenceOutstanding: rows.filter((row) => row.evidence_status !== 'Complete' && ['Funds Released', 'Ongoing', 'Completed'].includes(row.status)).length,
    fuelAndTransport: {
      fuel: inAllCurrencies(fuelAndTransport.fuelUsd, rate),
      transport: inAllCurrencies(fuelAndTransport.transportUsd, rate)
    },
    byMonth: sortByKey(byMonth),
    byArea,
    byCurrency,
    byStatus,
    byDestination: byDestination.sort((a, b) => b.totals.estimated.usd - a.totals.estimated.usd).slice(0, 25)
  });
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const row = await loadMovement(req.params.id, req.user);
  const [evidence, history] = await Promise.all([
    pool.query('SELECT * FROM movement_evidence WHERE movement_id = $1 ORDER BY created_at DESC', [row.id]),
    pool.query('SELECT * FROM movement_history WHERE movement_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200', [row.id])
  ]);
  res.json({
    movement: mapMovement(row),
    evidence: evidence.rows.map(mapEvidence),
    history: history.rows.map(mapHistory)
  });
}));

router.post('/', asyncRoute(async (req, res) => {
  if (!canCreate(req.user)) {
    return res.status(403).json({ message: 'Only the Director or a Logistics & Facilitation officer can create a movement.' });
  }
  const payload = readMovementPayload(req.body || {});

  const status = req.body?.status === 'Draft' ? 'Draft' : 'Pending';
  const rate = await getCurrentRate(pool);
  const overrideRate = readRateOverride(req.body, req.user);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ref = await nextReference(client);
    const id = `MOV-${Date.now()}-${crypto.randomInt(1000, 9999)}`;

    const result = await client.query(
      `INSERT INTO movements (
         id, ref, sector, related_area, movement_type, purpose, origin, destination,
         departure_date, return_date, person_team, transport_type, vehicle_driver,
         currency, status, category, notes,
         cost_transport, cost_fuel, cost_accommodation, cost_meals, cost_handling, cost_other,
         cost, funds_released, actual_expense, evidence_status,
         fx_rwf_per_usd, fx_cdf_per_usd, fx_source, fx_recorded_at, created_by
       ) VALUES (
         $1, $2, 'movement', $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15, $16,
         $17, $18, $19, $20, $21, $22,
         $23, 0, 0, 'Pending',
         $24, $25, $26, NOW(), $27
       ) RETURNING *`,
      [
        id, ref, payload.relatedArea, payload.movementType, payload.purpose, payload.origin, payload.destination,
        payload.departureDate, payload.returnDate, payload.personTeam, payload.transportType, payload.vehicleDriver,
        payload.currency, status, payload.category, payload.notes,
        payload.costs.transport, payload.costs.fuel, payload.costs.accommodation,
        payload.costs.meals, payload.costs.handling, payload.costs.other,
        payload.estimatedTotal,
        overrideRate?.rwfPerUsd ?? rate.rwfPerUsd,
        overrideRate?.cdfPerUsd ?? rate.cdfPerUsd,
        overrideRate ? 'actual' : 'reference',
        req.user.id
      ]
    );

    await logHistory(client, id, req.user, [
      { action: 'Created', field: 'status', oldValue: null, newValue: status },
      { action: 'Estimated facilitation', field: 'estimatedTotal', oldValue: null, newValue: `${payload.currency} ${payload.estimatedTotal}` }
    ]);
    await client.query('COMMIT');
    res.status(201).json(mapMovement(result.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

// Only the Director may pin an actual transaction rate onto a record.
function readRateOverride(body, user) {
  const { rateOverride } = body || {};
  if (!rateOverride) return null;
  if (!isAdmin(user)) throw new MovementError(403, 'Only the Director can override the exchange rate.');
  if (!validNumber(rateOverride.rwfPerUsd, { minimum: 0.000001 }) || !validNumber(rateOverride.cdfPerUsd, { minimum: 0.000001 })) {
    throw new MovementError(400, 'An overridden exchange rate must be greater than zero for both currencies.');
  }
  return { rwfPerUsd: Number(rateOverride.rwfPerUsd), cdfPerUsd: Number(rateOverride.cdfPerUsd) };
}

router.put('/:id', asyncRoute(async (req, res) => {
  const existing = await loadMovement(req.params.id, req.user);
  if (!canEdit(req.user, existing)) {
    return res.status(403).json({ message: 'This movement can no longer be edited by your account.' });
  }
  const payload = readMovementPayload(req.body || {});
  const overrideRate = readRateOverride(req.body, req.user);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE movements SET
         related_area = $2, movement_type = $3, purpose = $4, origin = $5, destination = $6,
         departure_date = $7, return_date = $8, person_team = $9, transport_type = $10, vehicle_driver = $11,
         currency = $12, category = $13, notes = $14,
         cost_transport = $15, cost_fuel = $16, cost_accommodation = $17,
         cost_meals = $18, cost_handling = $19, cost_other = $20, cost = $21,
         fx_rwf_per_usd = COALESCE($22, fx_rwf_per_usd),
         fx_cdf_per_usd = COALESCE($23, fx_cdf_per_usd),
         fx_source = CASE WHEN $22 IS NULL THEN fx_source ELSE 'actual' END,
         fx_recorded_at = CASE WHEN $22 IS NULL THEN fx_recorded_at ELSE NOW() END,
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        existing.id, payload.relatedArea, payload.movementType, payload.purpose, payload.origin, payload.destination,
        payload.departureDate, payload.returnDate, payload.personTeam, payload.transportType, payload.vehicleDriver,
        payload.currency, payload.category, payload.notes,
        payload.costs.transport, payload.costs.fuel, payload.costs.accommodation,
        payload.costs.meals, payload.costs.handling, payload.costs.other, payload.estimatedTotal,
        overrideRate?.rwfPerUsd ?? null, overrideRate?.cdfPerUsd ?? null
      ]
    );

    const changes = diffMovement(existing, result.rows[0]);
    if (overrideRate) {
      changes.push({
        action: 'Exchange rate overridden',
        field: 'rate',
        oldValue: `${existing.fx_rwf_per_usd} RWF / ${existing.fx_cdf_per_usd} CDF per USD`,
        newValue: `${overrideRate.rwfPerUsd} RWF / ${overrideRate.cdfPerUsd} CDF per USD`
      });
    }
    await logHistory(client, existing.id, req.user, changes);
    await client.query('COMMIT');
    res.json(mapMovement(result.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

const TRACKED_FIELDS = [
  ['purpose', 'purpose'], ['origin', 'origin'], ['destination', 'destination'],
  ['related_area', 'relatedArea'], ['movement_type', 'movementType'],
  ['departure_date', 'departureDate'], ['return_date', 'returnDate'],
  ['person_team', 'personTeam'], ['transport_type', 'transportType'],
  ['vehicle_driver', 'vehicleDriver'], ['currency', 'currency'],
  ['cost_transport', 'transportCost'], ['cost_fuel', 'fuelCost'],
  ['cost_accommodation', 'accommodationCost'], ['cost_meals', 'mealsCost'],
  ['cost_handling', 'handlingCost'], ['cost_other', 'otherCost'],
  ['cost', 'estimatedTotal'], ['notes', 'notes']
];

function diffMovement(before, after) {
  const changes = [];
  for (const [column, label] of TRACKED_FIELDS) {
    const oldValue = normaliseValue(before[column]);
    const newValue = normaliseValue(after[column]);
    if (oldValue !== newValue) {
      changes.push({ action: 'Edited', field: label, oldValue, newValue });
    }
  }
  return changes;
}

function normaliseValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return toDateOnly(value);
  if (typeof value === 'string' && /^-?\d+\.\d+$/.test(value)) return String(Number(value));
  return String(value);
}

// Section 6: approve, reject, release funds, run and complete.
router.patch('/:id/status', asyncRoute(async (req, res) => {
  const existing = await loadMovement(req.params.id, req.user);
  const { status } = req.body || {};
  if (!MOVEMENT_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'Movement status is invalid.' });
  }
  if (status === existing.status) {
    return res.status(400).json({ message: `This movement is already ${status}.` });
  }
  if (!(STATUS_FLOW[existing.status] || []).includes(status)) {
    return res.status(400).json({ message: `A ${existing.status} movement cannot move straight to ${status}.` });
  }

  // A movement officer may only submit their own draft for review.
  const selfSubmit = !isAdmin(req.user)
    && existing.created_by === req.user.id
    && existing.status === 'Draft'
    && status === 'Pending';
  if (!selfSubmit) requireAdmin(req.user, 'change the status of a movement');

  const fields = ['status = $2', 'updated_at = NOW()'];
  const values = [existing.id, status];

  if (status === 'Approved') {
    values.push(req.user.id);
    fields.push(`approved_by = $${values.length}`, 'approved_at = NOW()');
  }
  if (status === 'Completed') {
    fields.push('completed_at = NOW()');
  }
  if (status === 'Rejected' || status === 'Cancelled') {
    fields.push('approved_by = NULL', 'approved_at = NULL');
  }

  // Funds released and the final actual expense are recorded on the transition
  // that produces them (section 8), so the numbers and the status stay together.
  if (req.body.fundsReleased !== undefined && req.body.fundsReleased !== '') {
    requireAdmin(req.user, 'record released funds');
    if (!validNumber(req.body.fundsReleased)) return res.status(400).json({ message: 'Funds released must be a non-negative number.' });
    values.push(round2(req.body.fundsReleased));
    fields.push(`funds_released = $${values.length}`);
  }
  if (req.body.actualExpense !== undefined && req.body.actualExpense !== '') {
    requireAdmin(req.user, 'record the actual expenditure');
    if (!validNumber(req.body.actualExpense)) return res.status(400).json({ message: 'Actual expense must be a non-negative number.' });
    values.push(round2(req.body.actualExpense));
    fields.push(`actual_expense = $${values.length}`);
  }
  if (status === 'Funds Released' && req.body.fundsReleased === undefined && Number(existing.funds_released) === 0) {
    // Releasing without a figure defaults to the approved estimate.
    values.push(round2(existing.cost));
    fields.push(`funds_released = $${values.length}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE movements SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
      values
    );
    const after = result.rows[0];
    const entries = [{ action: 'Status changed', field: 'status', oldValue: existing.status, newValue: status }];
    if (Number(existing.funds_released) !== Number(after.funds_released)) {
      entries.push({ action: 'Funds released recorded', field: 'fundsReleased', oldValue: existing.funds_released, newValue: after.funds_released });
    }
    if (Number(existing.actual_expense) !== Number(after.actual_expense)) {
      entries.push({ action: 'Actual expenditure recorded', field: 'actualExpense', oldValue: existing.actual_expense, newValue: after.actual_expense });
    }
    if (requiredText(req.body.reason)) {
      entries.push({ action: 'Note', field: 'reason', oldValue: null, newValue: req.body.reason.trim().slice(0, 500) });
    }
    await logHistory(client, existing.id, req.user, entries);
    await client.query('COMMIT');
    res.json(mapMovement(after));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

// Funds and final expenditure can also be corrected without a status change.
router.patch('/:id/finance', asyncRoute(async (req, res) => {
  const existing = await loadMovement(req.params.id, req.user);
  requireAdmin(req.user, 'record funds and final expenditure');

  const fields = ['updated_at = NOW()'];
  const values = [existing.id];
  if (req.body.fundsReleased !== undefined) {
    if (!validNumber(req.body.fundsReleased)) return res.status(400).json({ message: 'Funds released must be a non-negative number.' });
    values.push(round2(req.body.fundsReleased));
    fields.push(`funds_released = $${values.length}`);
  }
  if (req.body.actualExpense !== undefined) {
    if (!validNumber(req.body.actualExpense)) return res.status(400).json({ message: 'Actual expense must be a non-negative number.' });
    values.push(round2(req.body.actualExpense));
    fields.push(`actual_expense = $${values.length}`);
  }
  if (req.body.evidenceStatus !== undefined) {
    if (!EVIDENCE_STATUSES.includes(req.body.evidenceStatus)) return res.status(400).json({ message: 'Evidence status is invalid.' });
    values.push(req.body.evidenceStatus);
    fields.push(`evidence_status = $${values.length}`);
  }
  if (values.length === 1) return res.status(400).json({ message: 'Nothing to update.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`UPDATE movements SET ${fields.join(', ')} WHERE id = $1 RETURNING *`, values);
    const after = result.rows[0];
    const entries = [];
    if (Number(existing.funds_released) !== Number(after.funds_released)) {
      entries.push({ action: 'Funds released recorded', field: 'fundsReleased', oldValue: existing.funds_released, newValue: after.funds_released });
    }
    if (Number(existing.actual_expense) !== Number(after.actual_expense)) {
      entries.push({ action: 'Actual expenditure recorded', field: 'actualExpense', oldValue: existing.actual_expense, newValue: after.actual_expense });
    }
    if (existing.evidence_status !== after.evidence_status) {
      entries.push({ action: 'Evidence status changed', field: 'evidenceStatus', oldValue: existing.evidence_status, newValue: after.evidence_status });
    }
    await logHistory(client, existing.id, req.user, entries);
    await client.query('COMMIT');
    res.json(mapMovement(after));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const existing = await loadMovement(req.params.id, req.user);
  requireAdmin(req.user, 'delete a movement');

  const files = await pool.query('SELECT stored_name FROM movement_evidence WHERE movement_id = $1', [existing.id]);
  const result = await pool.query('DELETE FROM movements WHERE id = $1 RETURNING *', [existing.id]);
  for (const file of files.rows) {
    fs.promises.unlink(path.join(uploadRoot, file.stored_name)).catch(() => {});
  }
  res.json({ message: 'Movement deleted successfully.', deletedMovement: mapMovement(result.rows[0]) });
}));

// ---- Evidence (section 8) -------------------------------------------------

router.get('/:id/evidence', asyncRoute(async (req, res) => {
  const existing = await loadMovement(req.params.id, req.user);
  const result = await pool.query('SELECT * FROM movement_evidence WHERE movement_id = $1 ORDER BY created_at DESC', [existing.id]);
  res.json(result.rows.map(mapEvidence));
}));

router.post('/:id/evidence', upload.array('files', 10), asyncRoute(async (req, res) => {
  const cleanup = () => (req.files || []).forEach((file) => fs.promises.unlink(file.path).catch(() => {}));
  let existing;
  try {
    existing = await loadMovement(req.params.id, req.user);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (!isAdmin(req.user) && !(req.user.sector === 'movement' && existing.created_by === req.user.id)) {
    cleanup();
    return res.status(403).json({ message: 'You cannot attach evidence to this movement.' });
  }
  if (!req.files?.length) return res.status(400).json({ message: 'Select at least one receipt, invoice or photograph to upload.' });

  const kind = EVIDENCE_KINDS.includes(req.body.kind) ? req.body.kind : 'Receipt';
  const amount = validNumber(req.body.amount || 0) ? round2(req.body.amount || 0) : 0;
  const note = optionalText(req.body.note, 500);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = [];
    for (const file of req.files) {
      const result = await client.query(
        `INSERT INTO movement_evidence
           (movement_id, kind, original_name, stored_name, mime_type, size_bytes, amount, note, uploaded_by, uploaded_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [existing.id, kind, file.originalname.slice(0, 255), file.filename, file.mimetype, file.size, amount, note, req.user.id, req.user.name]
      );
      saved.push(mapEvidence(result.rows[0]));
    }
    // First attachment moves the record off "Pending"; the Director marks it
    // Complete once the returned evidence is judged sufficient.
    await client.query(
      `UPDATE movements SET evidence_status = CASE WHEN evidence_status = 'Pending' THEN 'Partial' ELSE evidence_status END,
       updated_at = NOW() WHERE id = $1`,
      [existing.id]
    );
    await logHistory(client, existing.id, req.user, saved.map((item) => ({
      action: 'Evidence uploaded', field: 'evidence', oldValue: null, newValue: `${item.kind}: ${item.originalName}`
    })));
    await client.query('COMMIT');
    res.status(201).json(saved);
  } catch (error) {
    await client.query('ROLLBACK');
    cleanup();
    throw error;
  } finally {
    client.release();
  }
}));

router.get('/:id/evidence/:evidenceId/file', asyncRoute(async (req, res) => {
  const existing = await loadMovement(req.params.id, req.user);
  const result = await pool.query(
    'SELECT * FROM movement_evidence WHERE id = $1 AND movement_id = $2',
    [Number(req.params.evidenceId) || 0, existing.id]
  );
  if (!result.rowCount) return res.status(404).json({ message: 'Evidence not found.' });

  const record = result.rows[0];
  const absolute = path.join(uploadRoot, path.basename(record.stored_name));
  if (!fs.existsSync(absolute)) return res.status(404).json({ message: 'The stored file is missing from the server.' });

  res.type(record.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${record.original_name.replace(/"/g, '')}"`);
  fs.createReadStream(absolute).pipe(res);
}));

router.delete('/:id/evidence/:evidenceId', asyncRoute(async (req, res) => {
  const existing = await loadMovement(req.params.id, req.user);
  requireAdmin(req.user, 'remove evidence');

  const result = await pool.query(
    'DELETE FROM movement_evidence WHERE id = $1 AND movement_id = $2 RETURNING *',
    [Number(req.params.evidenceId) || 0, existing.id]
  );
  if (!result.rowCount) return res.status(404).json({ message: 'Evidence not found.' });

  fs.promises.unlink(path.join(uploadRoot, path.basename(result.rows[0].stored_name))).catch(() => {});
  await logHistory(pool, existing.id, req.user, [
    { action: 'Evidence removed', field: 'evidence', oldValue: result.rows[0].original_name, newValue: null }
  ]);
  res.json({ message: 'Evidence removed.', deletedEvidence: mapEvidence(result.rows[0]) });
}));

router.get('/:id/history', asyncRoute(async (req, res) => {
  const existing = await loadMovement(req.params.id, req.user);
  const result = await pool.query(
    'SELECT * FROM movement_history WHERE movement_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200',
    [existing.id]
  );
  res.json(result.rows.map(mapHistory));
}));

// ---- aggregation helpers --------------------------------------------------

function usdOf(row, rate) {
  const rwf = Number(row.fx_rwf_per_usd) > 0 ? Number(row.fx_rwf_per_usd) : rate.rwfPerUsd;
  const cdf = Number(row.fx_cdf_per_usd) > 0 ? Number(row.fx_cdf_per_usd) : rate.cdfPerUsd;
  return (amount) => convertAmount(amount, row.currency || 'RWF', rwf, cdf).usd;
}

function inAllCurrencies(usd, rate) {
  return {
    usd: round2(usd),
    rwf: round2(usd * rate.rwfPerUsd),
    cdf: round2(usd * rate.cdfPerUsd)
  };
}

function accumulate(rows, rate) {
  const sums = rows.reduce(
    (carry, row) => {
      const converted = usdOf(row, rate);
      carry.estimated += converted(row.cost);
      carry.released += converted(row.funds_released);
      carry.actual += converted(row.actual_expense);
      return carry;
    },
    { estimated: 0, released: 0, actual: 0 }
  );
  return {
    estimated: inAllCurrencies(sums.estimated, rate),
    released: inAllCurrencies(sums.released, rate),
    actual: inAllCurrencies(sums.actual, rate),
    balance: inAllCurrencies(sums.released - sums.actual, rate)
  };
}

function groupTotals(rows, rate, keyOf) {
  const buckets = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  return [...buckets.entries()].map(([key, group]) => ({
    key,
    count: group.length,
    totals: accumulate(group, rate)
  }));
}

function sortByKey(entries) {
  return entries.sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

// Multer and the validation helpers throw before the shared error handler runs,
// so translate them into the message the operator should actually see.
router.use((error, req, res, next) => {
  if (error instanceof MovementError) {
    return res.status(error.status).json({ message: error.message });
  }
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Each evidence file must be 10 MB or smaller.'
      : error.code === 'LIMIT_FILE_COUNT'
        ? 'Upload at most 10 evidence files at a time.'
        : 'The evidence upload was rejected.';
    return res.status(400).json({ message });
  }
  return next(error);
});

export default router;
