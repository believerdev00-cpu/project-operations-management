// Farming Management: every /api/farming route.
//
// In the order a working day meets them: the dashboard, the animal types and
// what each is measured by, production, herd changes, sales, expenses and
// their approval, problems, the reports, the budget, the alert settings and
// the history. Scoped by farmAccess (server/lib/farming.js): the Director and
// the General Manager read it all, the Farming Manager runs it, a team member
// records.
//
// THE RULES THAT HOLD EVERYWHERE HERE
//
//   * Every check is a function of shared/farming.js, the same one the form
//     runs before sending, so the screen and the API refuse the same things
//     with the same codes.
//   * Stock and head counts are never stored: they are summed from the rows.
//     Every write that changes one locks the measure row (FOR UPDATE) and runs
//     runningBalance over the measure's whole history WITH THE CHANGE APPLIED,
//     so a backdated entry, a correction or a void can never leave an earlier
//     sale selling milk that was not there (STOCK_BELOW_ZERO, 409).
//   * A record is corrected with a reason (>= FARM_CORRECTION_MIN characters)
//     or voided with one, never deleted, and every write leaves a farm_audit
//     row with what it was before and after.
//   * Money is typed in RWF, USD or CDF and frozen to USD at the reference
//     rate of the moment (getCurrentRate/convertAmount, as a trip does). The
//     figures read the frozen USD; nothing here ever re-prices a row.
//   * The farm's budget is the Director's and is separate from the farming
//     monthly plan's: nothing here reads or writes monthly_plans or
//     activity_expenses, so no cost is counted in both.

import express from 'express';
import { pool, safeRollback } from '../db/database.js';
import { asyncRoute, isValidDate } from '../lib/http.js';
import { convertAmount, getCurrentRate } from '../lib/rates.js';
import {
  FarmError, canManage, farmAccess, farmAudit, farmToday, mapAudit, mapExpense, mapHerdEvent, mapIssue, mapMeasure,
  mapProduction, mapSale, mapType, recordId, refuse, requireDirector, requireManage, requireMoney, seesMoney
} from '../lib/farming.js';
import {
  DEFAULT_ALERT_THRESHOLDS, EXPENSE_STATUSES, FARM_EXPENSE_CATEGORIES, FARM_PERIODS, ISSUE_STATUSES,
  SHARED_SCOPE, addDays, correctionReasonValid, farmAlerts, farmSummary, normaliseName, periodKey,
  possibleDuplicateExpense, possibleDuplicateProduction, productDeltas, productionTrend, removalBlocked, runningBalance,
  validateAnimalType, validateExpense, validateHerdEvent, validateIssue, validateMeasure, validateProduction, validateSale,
  validateThresholds
} from '../../shared/farming.js';
import { FARM_OPERATION } from '../../shared/businessOperations.js';
import { COMPLETED_STATUS, DEAD_STATUSES, toDateOnly } from '../lib/monthly.js';

const router = express.Router();
router.use(farmAccess);

const send = (res, body, status = 200) => res.status(status).json(body);

// ---- small readers ---------------------------------------------------------------

function dateParam(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!isValidDate(value)) throw new FarmError(400, 'Dates must be YYYY-MM-DD.', 'DATE_INVALID');
  return value;
}

function monthParam(value) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''))) throw new FarmError(400, 'Month must be YYYY-MM.', 'MONTH_INVALID');
  return value;
}

function monthEnd(month) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}

function requestKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
}

function correctionReason(value) {
  if (!correctionReasonValid(value)) {
    throw new FarmError(400, 'Say what was wrong, in a few words, so the change makes sense later.', 'CORRECTION_REASON');
  }
  return value.trim();
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function loadCatalogue(db) {
  const types = await db.query('SELECT * FROM farm_animal_types ORDER BY sort_order, id');
  const measures = await db.query('SELECT * FROM farm_measures ORDER BY animal_type_id, sort_order, id');
  return { types: types.rows.map(mapType), measures: measures.rows.map(mapMeasure) };
}

// The measure and its animal type, locked for the length of the transaction:
// every write that changes a stock or a head count holds this lock, so two
// people recording against the same milk cannot both see the same balance.
async function lockMeasure(client, measureId) {
  const measure = await client.query('SELECT * FROM farm_measures WHERE id = $1 FOR UPDATE', [measureId]);
  if (!measure.rowCount) throw new FarmError(404, 'That product or herd was not found.', 'NOT_FOUND');
  const type = await client.query('SELECT * FROM farm_animal_types WHERE id = $1', [measure.rows[0].animal_type_id]);
  return { measure: mapMeasure(measure.rows[0]), type: mapType(type.rows[0]) };
}

async function productHistory(db, measureId) {
  const production = await db.query("SELECT * FROM farm_production WHERE measure_id = $1 AND status = 'recorded'", [measureId]);
  const sales = await db.query("SELECT * FROM farm_sales WHERE measure_id = $1 AND status = 'recorded'", [measureId]);
  return { production: production.rows.map(mapProduction), sales: sales.rows.map(mapSale) };
}

async function herdHistory(db, measureId) {
  const events = await db.query("SELECT * FROM farm_herd_events WHERE measure_id = $1 AND status = 'recorded'", [measureId]);
  return events.rows.map(mapHerdEvent);
}

function assertNotNegative(balance, unit) {
  if (balance.lowest < 0) {
    throw new FarmError(409,
      `That would leave less than nothing on ${balance.lowestDate} (${balance.lowest} ${unit}). Check the dates and figures, or record what was produced first.`,
      'STOCK_BELOW_ZERO', { lowestDate: balance.lowestDate, lowest: balance.lowest });
  }
}

function herdBalance(events) {
  return runningBalance(events.map((event) => ({ date: event.date, delta: event.delta })));
}

function headCountOn(events, date) {
  return events.filter((event) => event.date <= date).reduce((sum, event) => sum + event.delta, 0);
}

async function frozenUsd(db, amount, currency) {
  const rate = await getCurrentRate(db);
  return { usd: convertAmount(amount, currency, rate.rwfPerUsd, rate.cdfPerUsd).usd, rwfPerUsd: rate.rwfPerUsd, cdfPerUsd: rate.cdfPerUsd };
}

// The categories an expense may name: the farm's own, plus whatever the
// animal types have added (a shared cost may be any of them).
function categoriesFor(scope, types) {
  if (scope === SHARED_SCOPE) return [...new Set([...FARM_EXPENSE_CATEGORIES, ...types.flatMap((type) => type.expenseCategories)])];
  const type = types.find((candidate) => String(candidate.id) === String(scope));
  return [...FARM_EXPENSE_CATEGORIES, ...(type?.expenseCategories || [])];
}

const actorOf = (req) => ({ id: req.user.id, name: req.user.name });

// ---- the dashboard -------------------------------------------------------------------

// Everything the farm's front page shows, in one read. A team member gets the
// day's work -- production, stock, their tasks, the problems -- and none of
// the money; the manager, the Director and the General Manager get the month's
// figures, the budget and the alerts as well.
router.get('/overview', asyncRoute(async (req, res) => {
  const role = req.farm;
  const today = farmToday();
  const month = today.slice(0, 7);
  const from = dateParam(req.query.from, `${month}-01`);
  const to = dateParam(req.query.to, today);
  if (to < from) throw new FarmError(400, 'The end date is before the start date.', 'DATE_INVALID');
  const { types, measures } = await loadCatalogue(pool);

  const trendFrom = addDays(today, -34);
  const earliest = [from, trendFrom].sort()[0];
  const production = (await pool.query(
    "SELECT * FROM farm_production WHERE status = 'recorded' AND produced_on BETWEEN $1 AND $2", [earliest, today > to ? today : to]
  )).rows.map(mapProduction);
  const sales = (await pool.query(
    "SELECT * FROM farm_sales WHERE status = 'recorded' AND sold_on BETWEEN $1 AND $2", [from, to]
  )).rows.map(mapSale);
  const herdEvents = (await pool.query(
    "SELECT * FROM farm_herd_events WHERE status = 'recorded' AND event_on BETWEEN $1 AND $2", [from, to]
  )).rows.map(mapHerdEvent);

  // Stock on hand and head counts, from all time: summed, never stored.
  const stock = (await pool.query(
    `SELECT m.id AS measure_id,
            COALESCE((SELECT SUM(produced - lost) FROM farm_production p WHERE p.measure_id = m.id AND p.status = 'recorded'), 0)
          - COALESCE((SELECT SUM(quantity) FROM farm_sales s WHERE s.measure_id = m.id AND s.status = 'recorded'), 0) AS on_hand
       FROM farm_measures m WHERE m.kind = 'product'`
  )).rows.map((row) => ({ measureId: row.measure_id, onHand: Number(row.on_hand) }));
  const herd = (await pool.query(
    `SELECT m.id AS measure_id, COALESCE(SUM(e.delta), 0)::int AS head, COUNT(e.id)::int AS events
       FROM farm_measures m LEFT JOIN farm_herd_events e ON e.measure_id = m.id AND e.status = 'recorded'
      WHERE m.kind = 'herd' GROUP BY m.id`
  // A herd nobody has ever counted or recorded a change for is unknown, not
  // empty: null, so the screen says "Not counted yet" rather than "0 head".
  )).rows.map((row) => ({ measureId: row.measure_id, head: row.events ? row.head : null }));

  const todayRows = production.filter((row) => row.date === today);
  const todayProduction = measures.filter((measure) => measure.kind === 'product').map((measure) => {
    const rows = todayRows.filter((row) => row.measureId === measure.id);
    return {
      measureId: measure.id,
      entries: rows.length,
      // null, not 0, when nothing has been recorded today.
      produced: rows.length ? rows.reduce((sum, row) => sum + row.produced, 0) : null,
      lost: rows.length ? rows.reduce((sum, row) => sum + row.lost, 0) : null
    };
  });
  const trend = measures.filter((measure) => measure.kind === 'product' && measure.active)
    .map((measure) => ({ measureId: measure.id, points: productionTrend(production, { measureId: measure.id, period: 'daily', from: addDays(today, -29), to: today }) }));

  // Tasks are the farm's existing work: activities in the Farming operation,
  // scheduled for today or earlier and not finished. There is no second task
  // system; a team member sees what is assigned to them.
  const taskValues = [FARM_OPERATION, today, [COMPLETED_STATUS, ...DEAD_STATUSES, 'Draft']];
  let mine = '';
  if (role === 'staff') { taskValues.push(req.user.id); mine = `AND a.assigned_to = $${taskValues.length}`; }
  const taskRows = (await pool.query(
    `SELECT a.id, a.activity, a.scheduled_for, a.priority, a.status, u.name AS assigned_name
       FROM activities a LEFT JOIN users u ON u.id = a.assigned_to
      WHERE a.sector = $1 AND a.scheduled_for IS NOT NULL AND a.scheduled_for <= $2
        AND NOT (a.status = ANY($3::text[])) ${mine}
      ORDER BY a.scheduled_for, a.id LIMIT 100`,
    taskValues
  )).rows.map((row) => ({
    id: row.id, title: row.activity, dueOn: toDateOnly(row.scheduled_for),
    priority: row.priority, status: row.status, assignedName: row.assigned_name || ''
  }));
  const tasks = {
    today: taskRows.filter((task) => task.dueOn === today),
    overdue: taskRows.filter((task) => task.dueOn < today)
  };

  const issueValues = [];
  let issueScope = '';
  if (role === 'staff') { issueValues.push(req.user.id); issueScope = `AND (raised_by = $1 OR urgent)`; }
  const issues = (await pool.query(
    `SELECT * FROM farm_issues WHERE status = 'open' ${issueScope} ORDER BY urgent DESC, created_at DESC LIMIT 50`, issueValues
  )).rows.map(mapIssue);

  const answer = { role, today, from, to, types, measures, todayProduction, stock, herd, trend, tasks, issues };

  if (role === 'staff') {
    const pendingMine = await pool.query("SELECT COUNT(*)::int AS n FROM farm_expenses WHERE status = 'pending' AND submitted_by = $1", [req.user.id]);
    const summary = farmSummary({ types, measures, production, herdEvents, from, to });
    // Production and herd only: no revenue, costs or results for a team member.
    answer.summary = { animalTypes: summary.animalTypes.map(({ animalTypeId, products, herd: herdLines }) => ({ animalTypeId, products, herd: herdLines })) };
    answer.myPendingExpenses = pendingMine.rows[0].n;
    return send(res, answer);
  }

  const expenses = (await pool.query(
    "SELECT * FROM farm_expenses WHERE status = 'approved' AND spent_on BETWEEN $1 AND $2", [from, to]
  )).rows.map(mapExpense);
  const pending = await pool.query("SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_usd), 0) AS usd FROM farm_expenses WHERE status = 'pending'");
  const todaySpend = await pool.query(
    "SELECT status, COALESCE(SUM(amount_usd), 0) AS usd FROM farm_expenses WHERE spent_on = $1 AND status IN ('approved', 'pending') GROUP BY status", [today]
  );
  const budgetRow = await pool.query('SELECT amount_usd FROM farm_budgets WHERE month = $1', [`${month}-01`]);
  const budgetUsd = budgetRow.rowCount ? Number(budgetRow.rows[0].amount_usd) : null;
  const monthSpent = await pool.query(
    "SELECT COALESCE(SUM(amount_usd), 0) AS usd FROM farm_expenses WHERE status = 'approved' AND spent_on BETWEEN $1 AND $2", [`${month}-01`, monthEnd(month)]
  );

  // The alerts read only what was recorded. Expense history is the six months
  // before this one, by category, approved only.
  const history = (await pool.query(
    `SELECT category, to_char(spent_on, 'YYYY-MM') AS month, SUM(amount_usd) AS usd
       FROM farm_expenses WHERE status = 'approved' AND spent_on >= ($1::date - INTERVAL '6 months') AND spent_on < $1::date
      GROUP BY category, to_char(spent_on, 'YYYY-MM')`, [`${month}-01`]
  )).rows.map((row) => ({ category: row.category, month: row.month, amountUsd: Number(row.usd) }));
  const monthExpenses = (await pool.query(
    "SELECT * FROM farm_expenses WHERE status = 'approved' AND spent_on BETWEEN $1 AND $2", [`${month}-01`, today]
  )).rows.map(mapExpense);
  const recentLosses = (await pool.query(
    "SELECT * FROM farm_herd_events WHERE status = 'recorded' AND kind = 'death' AND event_on >= $1", [addDays(today, -30)]
  )).rows.map(mapHerdEvent);
  const settings = await pool.query('SELECT alert_thresholds FROM farm_settings WHERE id = 1');
  const alerts = farmAlerts({
    today,
    production,
    expenses: monthExpenses,
    herdEvents: recentLosses,
    measures,
    tasks: taskRows.map((task) => ({ id: task.id, critical: task.priority === 'High', dueOn: task.dueOn, status: 'open' })),
    budgetUsd,
    monthSpentUsd: Number(monthSpent.rows[0].usd),
    expenseHistory: history,
    thresholds: settings.rows[0]?.alert_thresholds || {}
  });

  answer.summary = farmSummary({ types, measures, production, sales, expenses, herdEvents, from, to, budgetUsd: from.slice(0, 7) === month && to.slice(0, 7) === month ? budgetUsd : null });
  answer.todayExpenses = Object.fromEntries(todaySpend.rows.map((row) => [row.status, Number(row.usd)]));
  answer.pendingExpenses = { count: pending.rows[0].n, usd: Number(pending.rows[0].usd) };
  answer.budget = { month, budgetUsd, spentUsd: Number(monthSpent.rows[0].usd) };
  answer.alerts = alerts;
  send(res, answer);
}));

// ---- animal types and what they are measured by --------------------------------------

router.get('/animal-types', asyncRoute(async (req, res) => {
  const { types, measures } = await loadCatalogue(pool);
  const counts = await pool.query(
    `SELECT t.id,
            (SELECT COUNT(*) FROM farm_production WHERE animal_type_id = t.id)::int
          + (SELECT COUNT(*) FROM farm_sales WHERE animal_type_id = t.id)::int
          + (SELECT COUNT(*) FROM farm_herd_events WHERE animal_type_id = t.id)::int
          + (SELECT COUNT(*) FROM farm_expenses WHERE animal_type_id = t.id)::int
          + (SELECT COUNT(*) FROM farm_issues WHERE animal_type_id = t.id)::int AS records
       FROM farm_animal_types t`
  );
  const recordsOf = new Map(counts.rows.map((row) => [row.id, row.records]));
  send(res, {
    types: types.map((type) => ({ ...type, records: recordsOf.get(type.id) || 0, measures: measures.filter((measure) => measure.animalTypeId === type.id) })),
    expenseCategories: FARM_EXPENSE_CATEGORIES
  });
}));

router.post('/animal-types', asyncRoute(async (req, res) => {
  requireManage(req);
  const created = await inTransaction(async (client) => {
    const existing = (await client.query('SELECT id, name FROM farm_animal_types')).rows;
    const result = validateAnimalType(req.body || {}, { existing });
    if (result.errors.length) refuse(result.errors);
    const { value } = result;
    const order = await client.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM farm_animal_types');
    const type = await client.query(
      `INSERT INTO farm_animal_types (name, name_key, active, expense_categories, sort_order, created_by)
       VALUES ($1, $2, TRUE, $3::jsonb, $4, $5) RETURNING *`,
      [value.name, normaliseName(value.name), JSON.stringify(value.expenseCategories), order.rows[0].next, req.user.id]
    );
    const typeId = type.rows[0].id;
    for (const [index, measure] of value.measures.entries()) {
      await client.query(
        `INSERT INTO farm_measures (animal_type_id, name, name_key, kind, unit, sellable, perishable, daily_expected, active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [typeId, measure.name, normaliseName(measure.name), measure.kind, measure.unit, measure.sellable, measure.perishable, measure.dailyExpected, measure.active, index]
      );
    }
    await farmAudit(client, { entityType: 'animal_type', entityId: typeId, action: 'created', details: { after: value }, actor: actorOf(req) });
    return mapType(type.rows[0]);
  });
  send(res, created, 201);
}));

router.put('/animal-types/:id', asyncRoute(async (req, res) => {
  requireManage(req);
  const typeId = recordId(req.params.id);
  const updated = await inTransaction(async (client) => {
    const current = await client.query('SELECT * FROM farm_animal_types WHERE id = $1 FOR UPDATE', [typeId]);
    if (!current.rowCount) throw new FarmError(404, 'Animal type not found.', 'NOT_FOUND');
    const before = mapType(current.rows[0]);
    const existing = (await client.query('SELECT id, name FROM farm_animal_types')).rows;
    const result = validateAnimalType({
      name: req.body?.name ?? before.name,
      expenseCategories: req.body?.expenseCategories ?? before.expenseCategories,
      active: req.body?.active ?? before.active
    }, { existing, editingId: typeId });
    if (result.errors.length) refuse(result.errors);
    const { value } = result;
    const row = await client.query(
      `UPDATE farm_animal_types SET name = $2, name_key = $3, expense_categories = $4::jsonb, active = $5, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [typeId, value.name, normaliseName(value.name), JSON.stringify(value.expenseCategories), value.active]
    );
    const after = mapType(row.rows[0]);
    const action = before.active !== after.active ? (after.active ? 'reactivated' : 'deactivated') : 'updated';
    await farmAudit(client, { entityType: 'animal_type', entityId: typeId, action, details: { before, after }, actor: actorOf(req) });
    return after;
  });
  send(res, updated);
}));

// Only a type with no records at all can go -- the one typed by mistake a
// minute ago. Anything with history is deactivated instead, and the database
// enforces the same with ON DELETE RESTRICT.
router.delete('/animal-types/:id', asyncRoute(async (req, res) => {
  requireManage(req);
  const typeId = recordId(req.params.id);
  await inTransaction(async (client) => {
    const current = await client.query('SELECT * FROM farm_animal_types WHERE id = $1 FOR UPDATE', [typeId]);
    if (!current.rowCount) throw new FarmError(404, 'Animal type not found.', 'NOT_FOUND');
    const counts = await client.query(
      `SELECT (SELECT COUNT(*) FROM farm_production WHERE animal_type_id = $1)::int AS production,
              (SELECT COUNT(*) FROM farm_sales WHERE animal_type_id = $1)::int AS sales,
              (SELECT COUNT(*) FROM farm_herd_events WHERE animal_type_id = $1)::int AS herd,
              (SELECT COUNT(*) FROM farm_expenses WHERE animal_type_id = $1)::int AS expenses,
              (SELECT COUNT(*) FROM farm_issues WHERE animal_type_id = $1)::int AS issues`,
      [typeId]
    );
    const blocked = removalBlocked(counts.rows[0]);
    if (blocked) throw new FarmError(409, 'This animal type has records. Switch it off instead; its history stays.', blocked);
    await client.query('DELETE FROM farm_measures WHERE animal_type_id = $1', [typeId]);
    await client.query('DELETE FROM farm_animal_types WHERE id = $1', [typeId]);
    await farmAudit(client, { entityType: 'animal_type', entityId: typeId, action: 'removed', details: { before: mapType(current.rows[0]) }, actor: actorOf(req) });
  });
  send(res, { removed: true });
}));

router.post('/animal-types/:id/measures', asyncRoute(async (req, res) => {
  requireManage(req);
  const typeId = recordId(req.params.id);
  const created = await inTransaction(async (client) => {
    const type = await client.query('SELECT * FROM farm_animal_types WHERE id = $1 FOR UPDATE', [typeId]);
    if (!type.rowCount) throw new FarmError(404, 'Animal type not found.', 'NOT_FOUND');
    const result = validateMeasure(req.body || {});
    if (result.errors.length) refuse(result.errors.map((code) => `MEASURE_${code}`));
    const { value } = result;
    const clash = await client.query('SELECT 1 FROM farm_measures WHERE animal_type_id = $1 AND name_key = $2', [typeId, normaliseName(value.name)]);
    if (clash.rowCount) refuse(['MEASURE_NAME_EXISTS']);
    const order = await client.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM farm_measures WHERE animal_type_id = $1', [typeId]);
    const row = await client.query(
      `INSERT INTO farm_measures (animal_type_id, name, name_key, kind, unit, sellable, perishable, daily_expected, active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [typeId, value.name, normaliseName(value.name), value.kind, value.unit, value.sellable, value.perishable, value.dailyExpected, value.active, order.rows[0].next]
    );
    await farmAudit(client, { entityType: 'measure', entityId: row.rows[0].id, action: 'created', details: { after: value }, actor: actorOf(req) });
    return mapMeasure(row.rows[0]);
  });
  send(res, created, 201);
}));

// What a measure is (a product or a herd) never changes, and its unit does not
// change once anything is recorded in it: a month of milk would otherwise read
// as part litres and part whatever the unit became.
router.put('/measures/:id', asyncRoute(async (req, res) => {
  requireManage(req);
  const measureId = recordId(req.params.id);
  const updated = await inTransaction(async (client) => {
    const { measure: before } = await lockMeasure(client, measureId);
    const result = validateMeasure({
      name: req.body?.name ?? before.name,
      kind: before.kind,
      unit: req.body?.unit ?? before.unit,
      sellable: req.body?.sellable ?? before.sellable,
      perishable: req.body?.perishable ?? before.perishable,
      dailyExpected: req.body?.dailyExpected ?? before.dailyExpected,
      active: req.body?.active ?? before.active
    });
    if (result.errors.length) refuse(result.errors.map((code) => `MEASURE_${code}`));
    const { value } = result;
    if (value.unit !== before.unit) {
      const used = await client.query(
        `SELECT (SELECT COUNT(*) FROM farm_production WHERE measure_id = $1) + (SELECT COUNT(*) FROM farm_sales WHERE measure_id = $1)
              + (SELECT COUNT(*) FROM farm_herd_events WHERE measure_id = $1) AS n`, [measureId]
      );
      if (Number(used.rows[0].n) > 0) throw new FarmError(409, 'The unit cannot change once something is recorded in it. Add a new measure instead.', 'NOT_EDITABLE');
    }
    const clash = await client.query('SELECT 1 FROM farm_measures WHERE animal_type_id = $1 AND name_key = $2 AND id <> $3', [before.animalTypeId, normaliseName(value.name), measureId]);
    if (clash.rowCount) refuse(['MEASURE_NAME_EXISTS']);
    const row = await client.query(
      `UPDATE farm_measures SET name = $2, name_key = $3, unit = $4, sellable = $5, perishable = $6, daily_expected = $7, active = $8, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [measureId, value.name, normaliseName(value.name), value.unit, value.sellable, value.perishable, value.dailyExpected, value.active]
    );
    const after = mapMeasure(row.rows[0]);
    await farmAudit(client, { entityType: 'measure', entityId: measureId, action: before.active !== after.active ? (after.active ? 'reactivated' : 'deactivated') : 'updated', details: { before, after }, actor: actorOf(req) });
    return after;
  });
  send(res, updated);
}));

// ---- lists ---------------------------------------------------------------------------

// The filters every list shares: dates, animal type, measure. A team member's
// lists are the whole farm's production, herd and sales -- the work they all
// share -- but only their own expenses.
function listFilters(query, column, values, filters) {
  const from = dateParam(query.from, null);
  const to = dateParam(query.to, null);
  if (from) { values.push(from); filters.push(`${column} >= $${values.length}`); }
  if (to) { values.push(to); filters.push(`${column} <= $${values.length}`); }
  if (query.animalType === SHARED_SCOPE) filters.push('animal_type_id IS NULL');
  else if (query.animalType) { values.push(recordId(query.animalType)); filters.push(`animal_type_id = $${values.length}`); }
  if (query.measure) { values.push(recordId(query.measure)); filters.push(`measure_id = $${values.length}`); }
  if (query.status) { values.push(String(query.status).slice(0, 20)); filters.push(`status = $${values.length}`); }
}

const limitOf = (query) => Math.min(500, Math.max(1, Number(query.limit) || 100));
const where = (filters) => (filters.length ? `WHERE ${filters.join(' AND ')}` : '');

router.get('/production', asyncRoute(async (req, res) => {
  const values = [];
  const filters = [];
  listFilters(req.query, 'produced_on', values, filters);
  const rows = await pool.query(`SELECT * FROM farm_production ${where(filters)} ORDER BY produced_on DESC, id DESC LIMIT ${limitOf(req.query)}`, values);
  send(res, rows.rows.map(mapProduction));
}));

router.get('/sales', asyncRoute(async (req, res) => {
  const values = [];
  const filters = [];
  listFilters(req.query, 'sold_on', values, filters);
  const rows = await pool.query(`SELECT * FROM farm_sales ${where(filters)} ORDER BY sold_on DESC, id DESC LIMIT ${limitOf(req.query)}`, values);
  send(res, rows.rows.map((row) => {
    const sale = mapSale(row);
    // The money of a sale is the manager's to read; a team member sees what
    // went out, not what it fetched -- unless they recorded it themselves.
    if (!seesMoney(req.farm) && sale.recordedBy !== req.user.id) return { ...sale, amount: null, amountUsd: null };
    return sale;
  }));
}));

router.get('/herd', asyncRoute(async (req, res) => {
  const values = [];
  const filters = [];
  listFilters(req.query, 'event_on', values, filters);
  const rows = await pool.query(`SELECT * FROM farm_herd_events ${where(filters)} ORDER BY event_on DESC, id DESC LIMIT ${limitOf(req.query)}`, values);
  send(res, rows.rows.map(mapHerdEvent));
}));

router.get('/expenses', asyncRoute(async (req, res) => {
  const values = [];
  const filters = [];
  if (req.query.status && !EXPENSE_STATUSES.includes(req.query.status)) throw new FarmError(400, 'Unknown status.', 'KIND_INVALID');
  listFilters(req.query, 'spent_on', values, filters);
  if (req.query.category) { values.push(String(req.query.category).slice(0, 60)); filters.push(`category = $${values.length}`); }
  if (!seesMoney(req.farm)) { values.push(req.user.id); filters.push(`submitted_by = $${values.length}`); }
  const rows = await pool.query(`SELECT * FROM farm_expenses ${where(filters)} ORDER BY spent_on DESC, id DESC LIMIT ${limitOf(req.query)}`, values);
  send(res, rows.rows.map(mapExpense));
}));

// ---- production ------------------------------------------------------------------------

router.post('/production', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const key = requestKey(body.requestKey);
  if (key) {
    const again = await pool.query('SELECT * FROM farm_production WHERE request_key = $1', [key]);
    if (again.rowCount) return send(res, mapProduction(again.rows[0]));
  }
  const today = farmToday();
  const created = await inTransaction(async (client) => {
    const { measure, type } = await lockMeasure(client, recordId(body.measureId));
    const history = await productHistory(client, measure.id);
    const opening = runningBalance(productDeltas(history).filter((row) => row.date < body.date)).balance;
    const result = validateProduction(body, { type, measure, today, openingStock: opening });
    if (result.errors.length) refuse(result.errors);
    const { value } = result;
    const duplicates = possibleDuplicateProduction({ date: value.date, measureId: measure.id }, history.production);
    if (duplicates.length && body.confirmDuplicate !== true) {
      throw new FarmError(409, 'Something is already recorded for this product on this day. Send again to record a second entry.', 'POSSIBLE_DUPLICATE',
        { matches: duplicates.map(({ id, date, produced, lost, recordedByName }) => ({ id, date, produced, lost, recordedByName })) });
    }
    assertNotNegative(runningBalance(productDeltas({ ...history, production: [...history.production, { date: value.date, produced: value.produced, lost: value.lost }] })), measure.unit);
    const row = await client.query(
      `INSERT INTO farm_production (measure_id, animal_type_id, produced_on, produced, lost, notes, recorded_by, recorded_by_name, request_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [measure.id, type.id, value.date, value.produced, value.lost, value.notes, req.user.id, req.user.name, key]
    );
    const entry = mapProduction(row.rows[0]);
    await farmAudit(client, { entityType: 'production', entityId: entry.id, action: 'recorded', details: { after: value }, actor: actorOf(req) });
    return entry;
  });
  send(res, created, 201);
}));

// Who may correct a record: the manager and the Director, and the person who
// recorded it. Nobody else, whatever the screen drew.
function mayCorrect(req, row) {
  return canManage(req.farm) || Number(row.recorded_by) === Number(req.user.id);
}

router.put('/production/:id', asyncRoute(async (req, res) => {
  const entryId = recordId(req.params.id);
  const reason = correctionReason(req.body?.reason);
  const updated = await inTransaction(async (client) => {
    const current = await client.query('SELECT * FROM farm_production WHERE id = $1', [entryId]);
    if (!current.rowCount) throw new FarmError(404, 'Record not found.', 'NOT_FOUND');
    if (!mayCorrect(req, current.rows[0])) throw new FarmError(403, 'Only the person who recorded this, or the Farming Manager, can correct it.', 'NOT_ALLOWED');
    const before = mapProduction(current.rows[0]);
    if (before.status !== 'recorded') throw new FarmError(409, 'A voided record cannot be corrected.', 'NOT_EDITABLE');
    const { measure, type } = await lockMeasure(client, before.measureId);
    const history = await productHistory(client, measure.id);
    const others = history.production.filter((row) => row.id !== entryId);
    const opening = runningBalance(productDeltas({ ...history, production: others }).filter((row) => row.date < before.date)).balance;
    // A correction keeps the day and the product; only the figures and the
    // note change. The type may have been switched off since -- correcting an
    // old record of it is still allowed.
    const result = validateProduction({ date: before.date, produced: req.body?.produced ?? before.produced, lost: req.body?.lost ?? before.lost, notes: req.body?.notes ?? before.notes },
      { type: { ...type, active: true }, measure: { ...measure, active: true }, today: farmToday(), openingStock: opening });
    if (result.errors.length) refuse(result.errors);
    const { value } = result;
    assertNotNegative(runningBalance(productDeltas({ ...history, production: [...others, { ...before, produced: value.produced, lost: value.lost }] })), measure.unit);
    const row = await client.query(
      'UPDATE farm_production SET produced = $2, lost = $3, notes = $4, updated_at = NOW() WHERE id = $1 AND status = \'recorded\' RETURNING *',
      [entryId, value.produced, value.lost, value.notes]
    );
    if (!row.rowCount) throw new FarmError(409, 'This record changed while you were editing it. Reload and try again.', 'NOT_EDITABLE');
    const after = mapProduction(row.rows[0]);
    await farmAudit(client, { entityType: 'production', entityId: entryId, action: 'corrected', reason, details: { before: { produced: before.produced, lost: before.lost, notes: before.notes }, after: { produced: after.produced, lost: after.lost, notes: after.notes } }, actor: actorOf(req) });
    return after;
  });
  send(res, updated);
}));

router.post('/production/:id/void', asyncRoute(async (req, res) => {
  requireManage(req);
  const entryId = recordId(req.params.id);
  const reason = correctionReason(req.body?.reason);
  const voided = await inTransaction(async (client) => {
    const current = await client.query('SELECT * FROM farm_production WHERE id = $1', [entryId]);
    if (!current.rowCount) throw new FarmError(404, 'Record not found.', 'NOT_FOUND');
    const before = mapProduction(current.rows[0]);
    if (before.status !== 'recorded') throw new FarmError(409, 'This record is already voided.', 'NOT_EDITABLE');
    const { measure } = await lockMeasure(client, before.measureId);
    const history = await productHistory(client, measure.id);
    assertNotNegative(runningBalance(productDeltas({ ...history, production: history.production.filter((row) => row.id !== entryId) })), measure.unit);
    const row = await client.query(
      `UPDATE farm_production SET status = 'voided', void_reason = $2, voided_by = $3, voided_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'recorded' RETURNING *`, [entryId, reason, req.user.id]
    );
    if (!row.rowCount) throw new FarmError(409, 'This record changed. Reload and try again.', 'NOT_EDITABLE');
    await farmAudit(client, { entityType: 'production', entityId: entryId, action: 'voided', reason, details: { before }, actor: actorOf(req) });
    return mapProduction(row.rows[0]);
  });
  send(res, voided);
}));

// ---- herd changes -------------------------------------------------------------------

router.post('/herd', asyncRoute(async (req, res) => {
  const body = req.body || {};
  // A sale of animals is recorded on the sales form, which writes the herd
  // change with the money: one record of one fact.
  if (body.kind === 'sale') throw new FarmError(400, 'Record a sale of animals as a sale, so the money is recorded with it.', 'KIND_INVALID');
  const key = requestKey(body.requestKey);
  if (key) {
    const again = await pool.query('SELECT * FROM farm_herd_events WHERE request_key = $1', [key]);
    if (again.rowCount) return send(res, mapHerdEvent(again.rows[0]));
  }
  const created = await inTransaction(async (client) => {
    const { measure, type } = await lockMeasure(client, recordId(body.measureId));
    const events = await herdHistory(client, measure.id);
    const result = validateHerdEvent(body, { type, measure, today: farmToday(), headCount: isValidDate(body.date) ? headCountOn(events, body.date) : 0 });
    if (result.errors.length) refuse(result.errors);
    const { value } = result;
    assertNotNegative(herdBalance([...events, { date: value.date, delta: value.delta }]), measure.unit);
    const row = await client.query(
      `INSERT INTO farm_herd_events (measure_id, animal_type_id, event_on, kind, count, delta, reason, recorded_by, recorded_by_name, request_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [measure.id, type.id, value.date, value.kind, value.count, value.delta, value.reason, req.user.id, req.user.name, key]
    );
    const event = mapHerdEvent(row.rows[0]);
    await farmAudit(client, { entityType: 'herd', entityId: event.id, action: 'recorded', details: { after: value }, actor: actorOf(req) });
    return event;
  });
  send(res, created, 201);
}));

router.post('/herd/:id/void', asyncRoute(async (req, res) => {
  requireManage(req);
  const eventId = recordId(req.params.id);
  const reason = correctionReason(req.body?.reason);
  const voided = await inTransaction(async (client) => {
    const current = await client.query('SELECT * FROM farm_herd_events WHERE id = $1', [eventId]);
    if (!current.rowCount) throw new FarmError(404, 'Record not found.', 'NOT_FOUND');
    const before = mapHerdEvent(current.rows[0]);
    if (before.status !== 'recorded') throw new FarmError(409, 'This record is already voided.', 'NOT_EDITABLE');
    if (before.saleId) throw new FarmError(409, 'This came from a sale. Void the sale, and the animals go back with it.', 'NOT_EDITABLE');
    const { measure } = await lockMeasure(client, before.measureId);
    const events = await herdHistory(client, measure.id);
    assertNotNegative(herdBalance(events.filter((event) => event.id !== eventId)), measure.unit);
    const row = await client.query(
      `UPDATE farm_herd_events SET status = 'voided', void_reason = $2, voided_by = $3, voided_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'recorded' RETURNING *`, [eventId, reason, req.user.id]
    );
    if (!row.rowCount) throw new FarmError(409, 'This record changed. Reload and try again.', 'NOT_EDITABLE');
    await farmAudit(client, { entityType: 'herd', entityId: eventId, action: 'voided', reason, details: { before }, actor: actorOf(req) });
    return mapHerdEvent(row.rows[0]);
  });
  send(res, voided);
}));

// ---- sales ------------------------------------------------------------------------------

// A sale's effect on what is left: a product's stock, or -- for animals -- the
// head count, through the herd event written with it.
async function checkSaleBalance(client, measure, change) {
  if (measure.kind === 'product') {
    const history = await productHistory(client, measure.id);
    const sales = history.sales.filter((sale) => sale.id !== change.id);
    if (change.quantity !== null) sales.push({ id: change.id, date: change.date, quantity: change.quantity });
    assertNotNegative(runningBalance(productDeltas({ production: history.production, sales })), measure.unit);
  } else {
    const events = (await herdHistory(client, measure.id)).filter((event) => !(change.id && event.saleId === change.id));
    if (change.quantity !== null) events.push({ date: change.date, delta: -change.quantity });
    assertNotNegative(herdBalance(events), measure.unit);
  }
}

router.post('/sales', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const key = requestKey(body.requestKey);
  if (key) {
    const again = await pool.query('SELECT * FROM farm_sales WHERE request_key = $1', [key]);
    if (again.rowCount) return send(res, mapSale(again.rows[0]));
  }
  const created = await inTransaction(async (client) => {
    const { measure, type } = await lockMeasure(client, recordId(body.measureId));
    const result = validateSale(body, { type, measure, today: farmToday() });
    if (result.errors.length) refuse(result.errors);
    if (measure.active === false) refuse(['MEASURE_INACTIVE']);
    const { value } = result;
    await checkSaleBalance(client, measure, { id: null, date: value.date, quantity: value.quantity });
    const money = await frozenUsd(client, value.amount, value.currency);
    const row = await client.query(
      `INSERT INTO farm_sales (measure_id, animal_type_id, sold_on, quantity, amount, currency, amount_usd, fx_rwf_per_usd, fx_cdf_per_usd,
                               buyer, notes, recorded_by, recorded_by_name, request_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [measure.id, type.id, value.date, value.quantity, value.amount, value.currency, money.usd, money.rwfPerUsd, money.cdfPerUsd,
        value.buyer, String(body.notes || '').trim().slice(0, 1000), req.user.id, req.user.name, key]
    );
    const sale = mapSale(row.rows[0]);
    if (measure.kind === 'herd') {
      await client.query(
        `INSERT INTO farm_herd_events (measure_id, animal_type_id, event_on, kind, count, delta, sale_id, recorded_by, recorded_by_name)
         VALUES ($1, $2, $3, 'sale', $4, $5, $6, $7, $8)`,
        [measure.id, type.id, value.date, value.quantity, -value.quantity, sale.id, req.user.id, req.user.name]
      );
    }
    await farmAudit(client, { entityType: 'sale', entityId: sale.id, action: 'recorded', details: { after: { ...value, amountUsd: money.usd } }, actor: actorOf(req) });
    return sale;
  });
  send(res, created, 201);
}));

router.put('/sales/:id', asyncRoute(async (req, res) => {
  const saleId = recordId(req.params.id);
  const reason = correctionReason(req.body?.reason);
  const updated = await inTransaction(async (client) => {
    const current = await client.query('SELECT * FROM farm_sales WHERE id = $1', [saleId]);
    if (!current.rowCount) throw new FarmError(404, 'Record not found.', 'NOT_FOUND');
    if (!mayCorrect(req, current.rows[0])) throw new FarmError(403, 'Only the person who recorded this, or the Farming Manager, can correct it.', 'NOT_ALLOWED');
    const before = mapSale(current.rows[0]);
    if (before.status !== 'recorded') throw new FarmError(409, 'A voided record cannot be corrected.', 'NOT_EDITABLE');
    const { measure, type } = await lockMeasure(client, before.measureId);
    const result = validateSale({
      date: before.date,
      quantity: req.body?.quantity ?? before.quantity,
      amount: req.body?.amount ?? before.amount,
      currency: req.body?.currency ?? before.currency,
      buyer: req.body?.buyer ?? before.buyer
    }, { type: { ...type, active: true }, measure: { ...measure, active: true }, today: farmToday() });
    if (result.errors.length) refuse(result.errors);
    const { value } = result;
    await checkSaleBalance(client, measure, { id: saleId, date: before.date, quantity: value.quantity });
    // The rate frozen on the sale stays; a corrected amount is converted at it,
    // so correcting a typo never re-prices the sale at today's rate.
    const fx = current.rows[0];
    const amountUsd = convertAmount(value.amount, value.currency, Number(fx.fx_rwf_per_usd), Number(fx.fx_cdf_per_usd)).usd;
    const row = await client.query(
      `UPDATE farm_sales SET quantity = $2, amount = $3, currency = $4, amount_usd = $5, buyer = $6, notes = $7, updated_at = NOW()
        WHERE id = $1 AND status = 'recorded' RETURNING *`,
      [saleId, value.quantity, value.amount, value.currency, amountUsd, value.buyer, String(req.body?.notes ?? before.notes).trim().slice(0, 1000)]
    );
    if (!row.rowCount) throw new FarmError(409, 'This record changed while you were editing it. Reload and try again.', 'NOT_EDITABLE');
    if (measure.kind === 'herd') {
      await client.query("UPDATE farm_herd_events SET count = $2, delta = $3, updated_at = NOW() WHERE sale_id = $1 AND status = 'recorded'", [saleId, value.quantity, -value.quantity]);
    }
    const after = mapSale(row.rows[0]);
    await farmAudit(client, { entityType: 'sale', entityId: saleId, action: 'corrected', reason, details: { before: { quantity: before.quantity, amount: before.amount, currency: before.currency, buyer: before.buyer }, after: { quantity: after.quantity, amount: after.amount, currency: after.currency, buyer: after.buyer } }, actor: actorOf(req) });
    return after;
  });
  send(res, updated);
}));

router.post('/sales/:id/void', asyncRoute(async (req, res) => {
  requireManage(req);
  const saleId = recordId(req.params.id);
  const reason = correctionReason(req.body?.reason);
  const voided = await inTransaction(async (client) => {
    const current = await client.query('SELECT * FROM farm_sales WHERE id = $1', [saleId]);
    if (!current.rowCount) throw new FarmError(404, 'Record not found.', 'NOT_FOUND');
    const before = mapSale(current.rows[0]);
    if (before.status !== 'recorded') throw new FarmError(409, 'This record is already voided.', 'NOT_EDITABLE');
    await lockMeasure(client, before.measureId);
    // Voiding a sale only ever puts goods or animals back, so no balance can
    // fall below zero because of it.
    const row = await client.query(
      `UPDATE farm_sales SET status = 'voided', void_reason = $2, voided_by = $3, voided_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'recorded' RETURNING *`, [saleId, reason, req.user.id]
    );
    if (!row.rowCount) throw new FarmError(409, 'This record changed. Reload and try again.', 'NOT_EDITABLE');
    await client.query(
      `UPDATE farm_herd_events SET status = 'voided', void_reason = $2, voided_by = $3, voided_at = NOW(), updated_at = NOW()
        WHERE sale_id = $1 AND status = 'recorded'`, [saleId, reason, req.user.id]
    );
    await farmAudit(client, { entityType: 'sale', entityId: saleId, action: 'voided', reason, details: { before }, actor: actorOf(req) });
    return mapSale(row.rows[0]);
  });
  send(res, voided);
}));

// ---- expenses ---------------------------------------------------------------------------

// A team member's expense waits for the Farming Manager. The manager's or the
// Director's own is approved as it is recorded: they are the ones who approve,
// and the audit row says it was recorded and approved by the same person.
router.post('/expenses', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const key = requestKey(body.requestKey);
  if (key) {
    const again = await pool.query('SELECT * FROM farm_expenses WHERE request_key = $1', [key]);
    if (again.rowCount) return send(res, mapExpense(again.rows[0]));
  }
  const created = await inTransaction(async (client) => {
    const { types } = await loadCatalogue(client);
    const result = validateExpense(body, { types, categories: categoriesFor(body.scope, types), today: farmToday() });
    if (result.errors.length) refuse(result.errors);
    const { value } = result;
    const sameDay = await client.query("SELECT * FROM farm_expenses WHERE spent_on = $1 AND status IN ('pending', 'approved')", [value.date]);
    const duplicates = possibleDuplicateExpense(value, sameDay.rows.map(mapExpense));
    if (duplicates.length && body.confirmDuplicate !== true) {
      throw new FarmError(409, 'The same cost is already recorded for this day. Send again if this is a second, separate purchase.', 'POSSIBLE_DUPLICATE',
        { matches: duplicates.map(({ id, date, amount, currency, category, submittedByName, status }) => ({ id, date, amount, currency, category, submittedByName, status })) });
    }
    const money = await frozenUsd(client, value.amount, value.currency);
    const approver = canManage(req.farm);
    const row = await client.query(
      `INSERT INTO farm_expenses (spent_on, amount, currency, amount_usd, fx_rwf_per_usd, fx_cdf_per_usd, animal_type_id, category, description,
                                  payee, receipt_ref, status, submitted_by, submitted_by_name, decided_by, decided_by_name, decided_at, request_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
      [value.date, value.amount, value.currency, money.usd, money.rwfPerUsd, money.cdfPerUsd, value.animalTypeId, value.category, value.description,
        value.payee, value.receiptRef, approver ? 'approved' : 'pending', req.user.id, req.user.name,
        approver ? req.user.id : null, approver ? req.user.name : '', approver ? new Date() : null, key]
    );
    const expense = mapExpense(row.rows[0]);
    await farmAudit(client, { entityType: 'expense', entityId: expense.id, action: approver ? 'recorded_and_approved' : 'submitted', details: { after: { ...value, amountUsd: money.usd } }, actor: actorOf(req) });
    return expense;
  });
  send(res, created, 201);
}));

// Only a pending expense is edited, by whoever submitted it or the manager.
// Once decided it is a fact: an approved expense is voided and entered again,
// never changed in place.
router.put('/expenses/:id', asyncRoute(async (req, res) => {
  const expenseId = recordId(req.params.id);
  const updated = await inTransaction(async (client) => {
    const current = await client.query('SELECT * FROM farm_expenses WHERE id = $1 FOR UPDATE', [expenseId]);
    if (!current.rowCount) throw new FarmError(404, 'Expense not found.', 'NOT_FOUND');
    const row = current.rows[0];
    if (!canManage(req.farm) && Number(row.submitted_by) !== Number(req.user.id)) throw new FarmError(404, 'Expense not found.', 'NOT_FOUND');
    if (row.status !== 'pending') throw new FarmError(409, 'Only an expense still waiting for approval can be changed. Ask the Farming Manager to void it and enter it again.', 'NOT_EDITABLE');
    const before = mapExpense(row);
    const { types } = await loadCatalogue(client);
    const scope = req.body?.scope ?? (before.shared ? SHARED_SCOPE : String(before.animalTypeId));
    const result = validateExpense({
      date: req.body?.date ?? before.date,
      amount: req.body?.amount ?? before.amount,
      currency: req.body?.currency ?? before.currency,
      scope,
      category: req.body?.category ?? before.category,
      description: req.body?.description ?? before.description,
      payee: req.body?.payee ?? before.payee,
      receiptRef: req.body?.receiptRef ?? before.receiptRef
    }, { types, categories: categoriesFor(scope, types), today: farmToday() });
    if (result.errors.length) refuse(result.errors);
    const { value } = result;
    const money = await frozenUsd(client, value.amount, value.currency);
    const saved = await client.query(
      `UPDATE farm_expenses SET spent_on = $2, amount = $3, currency = $4, amount_usd = $5, fx_rwf_per_usd = $6, fx_cdf_per_usd = $7,
              animal_type_id = $8, category = $9, description = $10, payee = $11, receipt_ref = $12, updated_at = NOW()
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [expenseId, value.date, value.amount, value.currency, money.usd, money.rwfPerUsd, money.cdfPerUsd, value.animalTypeId,
        value.category, value.description, value.payee, value.receiptRef]
    );
    const after = mapExpense(saved.rows[0]);
    await farmAudit(client, { entityType: 'expense', entityId: expenseId, action: 'edited', details: { before, after }, actor: actorOf(req) });
    return after;
  });
  send(res, updated);
}));

router.post('/expenses/:id/decision', asyncRoute(async (req, res) => {
  requireManage(req);
  const expenseId = recordId(req.params.id);
  const approve = req.body?.approve === true;
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  // Refusing says why, as sending work back does everywhere else.
  if (!approve && !correctionReasonValid(note)) throw new FarmError(400, 'Say why the expense is refused, so whoever submitted it knows what to fix.', 'CORRECTION_REASON');
  const decided = await inTransaction(async (client) => {
    const row = await client.query(
      `UPDATE farm_expenses SET status = $2, decided_by = $3, decided_by_name = $4, decided_at = NOW(), decision_note = $5, updated_at = NOW()
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [expenseId, approve ? 'approved' : 'rejected', req.user.id, req.user.name, note.slice(0, 1000)]
    );
    if (!row.rowCount) {
      const exists = await client.query('SELECT status FROM farm_expenses WHERE id = $1', [expenseId]);
      if (!exists.rowCount) throw new FarmError(404, 'Expense not found.', 'NOT_FOUND');
      throw new FarmError(409, 'This expense has already been decided.', 'ALREADY_DECIDED');
    }
    await farmAudit(client, { entityType: 'expense', entityId: expenseId, action: approve ? 'approved' : 'rejected', reason: note, actor: actorOf(req) });
    return mapExpense(row.rows[0]);
  });
  send(res, decided);
}));

router.post('/expenses/:id/void', asyncRoute(async (req, res) => {
  requireManage(req);
  const expenseId = recordId(req.params.id);
  const reason = correctionReason(req.body?.reason);
  const voided = await inTransaction(async (client) => {
    const row = await client.query(
      `UPDATE farm_expenses SET status = 'voided', void_reason = $2, voided_by = $3, voided_at = NOW(),
              decided_at = COALESCE(decided_at, NOW()), updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'approved') RETURNING *`, [expenseId, reason, req.user.id]
    );
    if (!row.rowCount) {
      const exists = await client.query('SELECT status FROM farm_expenses WHERE id = $1', [expenseId]);
      if (!exists.rowCount) throw new FarmError(404, 'Expense not found.', 'NOT_FOUND');
      throw new FarmError(409, 'Only a pending or approved expense can be voided.', 'NOT_EDITABLE');
    }
    await farmAudit(client, { entityType: 'expense', entityId: expenseId, action: 'voided', reason, actor: actorOf(req) });
    return mapExpense(row.rows[0]);
  });
  send(res, voided);
}));

// ---- problems ---------------------------------------------------------------------------

router.get('/issues', asyncRoute(async (req, res) => {
  const values = [];
  const filters = [];
  if (req.query.status) {
    if (!ISSUE_STATUSES.includes(req.query.status)) throw new FarmError(400, 'Unknown status.', 'KIND_INVALID');
    values.push(req.query.status); filters.push(`status = $${values.length}`);
  }
  // A team member sees what they raised, and every urgent issue (a sick animal
  // is everybody's business); the manager sees all of them.
  if (!seesMoney(req.farm)) { values.push(req.user.id); filters.push(`(raised_by = $${values.length} OR urgent)`); }
  const rows = await pool.query(`SELECT * FROM farm_issues ${where(filters)} ORDER BY status, urgent DESC, created_at DESC LIMIT ${limitOf(req.query)}`, values);
  send(res, rows.rows.map(mapIssue));
}));

router.post('/issues', asyncRoute(async (req, res) => {
  const { types } = await loadCatalogue(pool);
  const result = validateIssue(req.body || {}, { types });
  if (result.errors.length) refuse(result.errors);
  const { value } = result;
  const created = await inTransaction(async (client) => {
    const row = await client.query(
      `INSERT INTO farm_issues (kind, urgent, animal_type_id, description, raised_by, raised_by_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [value.kind, value.urgent, value.animalTypeId, value.description, req.user.id, req.user.name]
    );
    await farmAudit(client, { entityType: 'issue', entityId: row.rows[0].id, action: 'raised', details: { after: value }, actor: actorOf(req) });
    return mapIssue(row.rows[0]);
  });
  send(res, created, 201);
}));

router.post('/issues/:id/resolve', asyncRoute(async (req, res) => {
  requireManage(req);
  const issueId = recordId(req.params.id);
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 1000) : '';
  const resolved = await inTransaction(async (client) => {
    const row = await client.query(
      `UPDATE farm_issues SET status = 'resolved', resolved_by = $2, resolved_by_name = $3, resolved_at = NOW(), resolution_note = $4, updated_at = NOW()
        WHERE id = $1 AND status = 'open' RETURNING *`, [issueId, req.user.id, req.user.name, note]
    );
    if (!row.rowCount) throw new FarmError(404, 'Open issue not found.', 'NOT_FOUND');
    await farmAudit(client, { entityType: 'issue', entityId: issueId, action: 'resolved', reason: note, actor: actorOf(req) });
    return mapIssue(row.rows[0]);
  });
  send(res, resolved);
}));

// ---- reports ----------------------------------------------------------------------------

// A period's figures, and the same figures per day, week or month inside it --
// worked out from the records every time, so nobody prepares them by hand.
// Filters narrow the rows before anything is summed: an animal type, a
// product, an expense category.
router.get('/report', asyncRoute(async (req, res) => {
  requireMoney(req);
  const today = farmToday();
  const period = FARM_PERIODS.includes(req.query.period) ? req.query.period : 'daily';
  const from = dateParam(req.query.from, `${today.slice(0, 7)}-01`);
  const to = dateParam(req.query.to, today);
  if (to < from) throw new FarmError(400, 'The end date is before the start date.', 'DATE_INVALID');
  if (req.query.from && req.query.to && (Date.parse(to) - Date.parse(from)) / 86400000 > 731) {
    throw new FarmError(400, 'Choose two years or less.', 'DATE_INVALID');
  }
  const { types, measures } = await loadCatalogue(pool);
  const typeFilter = req.query.animalType ? (req.query.animalType === SHARED_SCOPE ? SHARED_SCOPE : recordId(req.query.animalType)) : null;
  const measureFilter = req.query.measure ? recordId(req.query.measure) : null;
  const category = req.query.category ? String(req.query.category).slice(0, 60) : null;

  // Production, sales and herd changes always belong to one animal type, so
  // asking for the shared costs leaves them all out.
  const keepRecord = (row) => {
    if (typeFilter === SHARED_SCOPE) return false;
    if (typeFilter && row.animalTypeId !== typeFilter) return false;
    return !measureFilter || row.measureId === measureFilter;
  };
  const production = (await pool.query("SELECT * FROM farm_production WHERE status = 'recorded' AND produced_on BETWEEN $1 AND $2", [from, to])).rows.map(mapProduction).filter(keepRecord);
  const sales = (await pool.query("SELECT * FROM farm_sales WHERE status = 'recorded' AND sold_on BETWEEN $1 AND $2", [from, to])).rows.map(mapSale).filter(keepRecord);
  const herdEvents = (await pool.query("SELECT * FROM farm_herd_events WHERE status = 'recorded' AND event_on BETWEEN $1 AND $2", [from, to])).rows.map(mapHerdEvent).filter(keepRecord);
  const expenses = (await pool.query("SELECT * FROM farm_expenses WHERE status = 'approved' AND spent_on BETWEEN $1 AND $2", [from, to])).rows.map(mapExpense)
    .filter((row) => (!typeFilter || (typeFilter === SHARED_SCOPE ? row.shared : row.animalTypeId === typeFilter)) && (!category || row.category === category));
  const pending = await pool.query("SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_usd), 0) AS usd FROM farm_expenses WHERE status = 'pending' AND spent_on BETWEEN $1 AND $2", [from, to]);

  const buckets = new Map();
  const bucket = (date) => {
    const key = periodKey(date, period);
    if (!buckets.has(key)) buckets.set(key, { production: [], sales: [], herdEvents: [], expenses: [] });
    return buckets.get(key);
  };
  production.forEach((row) => bucket(row.date).production.push(row));
  sales.forEach((row) => bucket(row.date).sales.push(row));
  herdEvents.forEach((row) => bucket(row.date).herdEvents.push(row));
  expenses.forEach((row) => bucket(row.date).expenses.push(row));

  send(res, {
    period, from, to,
    filters: { animalType: typeFilter, measure: measureFilter, category },
    types, measures,
    summary: farmSummary({ types, measures, production, sales, herdEvents, expenses, from, to }),
    // Approved expenses are what was spent; these are what is still waiting.
    pendingExpenses: { count: pending.rows[0].n, usd: Number(pending.rows[0].usd) },
    periods: [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, rows]) => {
      const figures = farmSummary({ measures, ...rows });
      return { period: key, ...figures.farm, animalTypes: figures.animalTypes };
    })
  });
}));

// ---- budget, settings, history ---------------------------------------------------------

router.get('/budget', asyncRoute(async (req, res) => {
  requireMoney(req);
  const month = monthParam(req.query.month || farmToday().slice(0, 7));
  const row = await pool.query('SELECT * FROM farm_budgets WHERE month = $1', [`${month}-01`]);
  send(res, { month, budgetUsd: row.rowCount ? Number(row.rows[0].amount_usd) : null, setByName: row.rows[0]?.set_by_name || '', updatedAt: row.rows[0]?.updated_at || null });
}));

// The farm's monthly figure is the Director's, as every ceiling is. It is
// separate from the farming monthly plan's approved budget and never added to
// it. Zero clears it: no budget means no budget line, not "0 of 0".
router.put('/budget/:month', asyncRoute(async (req, res) => {
  requireDirector(req);
  const month = monthParam(req.params.month);
  const amount = Number(req.body?.amountUsd);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e15) throw new FarmError(400, 'The budget must be a number, zero or more.', 'BUDGET_INVALID');
  const saved = await inTransaction(async (client) => {
    const before = await client.query('SELECT amount_usd FROM farm_budgets WHERE month = $1 FOR UPDATE', [`${month}-01`]);
    const row = await client.query(
      `INSERT INTO farm_budgets (month, amount_usd, set_by, set_by_name, updated_at) VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (month) DO UPDATE SET amount_usd = EXCLUDED.amount_usd, set_by = EXCLUDED.set_by, set_by_name = EXCLUDED.set_by_name, updated_at = NOW()
       RETURNING *`,
      [`${month}-01`, Math.round(amount * 100) / 100, req.user.id, req.user.name]
    );
    await farmAudit(client, { entityType: 'budget', entityId: null, action: 'budget_set', details: { month, before: before.rows[0] ? Number(before.rows[0].amount_usd) : null, after: Number(row.rows[0].amount_usd) }, actor: actorOf(req) });
    return { month, budgetUsd: Number(row.rows[0].amount_usd) };
  });
  send(res, saved);
}));

router.get('/settings', asyncRoute(async (req, res) => {
  requireMoney(req);
  const row = await pool.query('SELECT alert_thresholds FROM farm_settings WHERE id = 1');
  const saved = row.rows[0]?.alert_thresholds || {};
  send(res, { thresholds: { ...DEFAULT_ALERT_THRESHOLDS, ...saved }, defaults: DEFAULT_ALERT_THRESHOLDS });
}));

router.put('/settings', asyncRoute(async (req, res) => {
  requireManage(req);
  const result = validateThresholds(req.body?.thresholds || {});
  if (result.errors.length) refuse(result.errors);
  const saved = await inTransaction(async (client) => {
    const before = await client.query('SELECT alert_thresholds FROM farm_settings WHERE id = 1 FOR UPDATE');
    const merged = { ...(before.rows[0]?.alert_thresholds || {}), ...result.value };
    await client.query('UPDATE farm_settings SET alert_thresholds = $1::jsonb, updated_by = $2, updated_at = NOW() WHERE id = 1', [JSON.stringify(merged), req.user.id]);
    await farmAudit(client, { entityType: 'settings', action: 'thresholds_changed', details: { before: before.rows[0]?.alert_thresholds || {}, after: merged }, actor: actorOf(req) });
    return { ...DEFAULT_ALERT_THRESHOLDS, ...merged };
  });
  send(res, { thresholds: saved, defaults: DEFAULT_ALERT_THRESHOLDS });
}));

router.get('/audit', asyncRoute(async (req, res) => {
  requireMoney(req);
  const values = [];
  const filters = [];
  if (req.query.entityType) { values.push(String(req.query.entityType).slice(0, 30)); filters.push(`entity_type = $${values.length}`); }
  if (req.query.entityId) { values.push(recordId(req.query.entityId)); filters.push(`entity_id = $${values.length}`); }
  const rows = await pool.query(`SELECT * FROM farm_audit ${where(filters)} ORDER BY created_at DESC, id DESC LIMIT ${limitOf(req.query)}`, values);
  send(res, rows.rows.map(mapAudit));
}));

// What the caller did wrong is answered with its status and code; everything
// else goes to the global handler.
router.use((error, req, res, next) => {
  if (error instanceof FarmError) {
    return res.status(error.status).json({ message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.extra || {}) });
  }
  next(error);
});

export default router;
