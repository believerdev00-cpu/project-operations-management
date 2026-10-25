// Farming Management, end to end.
//
//   1. who reaches the farm: its own people and senior management; a Mining
//      manager is refused, the General Manager reads and writes nothing;
//   2. animal types are data: the Farming Manager adds one with its measures,
//      a duplicate name is refused, a team member cannot add one;
//   3. production: a team member records it, the same day twice is a warning
//      that a second send confirms, a repeated request key answers the first
//      row, a future date and the wrong kind of measure are refused;
//   4. stock is summed over the whole history: selling more than was produced
//      is refused, and so is voiding the production a sale depended on;
//   5. corrections say why and leave a history row; only the manager voids;
//   6. the herd: a death needs a cause, a sale of animals writes the herd
//      change with it, and that change is undone only by voiding the sale;
//   7. expenses: a team member's waits for the Farming Manager, who refuses
//      only with a reason; an approved one cannot be edited; the same cost twice
//      is a warning; the manager's own is approved as recorded; a shared cost
//      stays shared; a team member sees only their own;
//   8. switching an animal off keeps its history and its figures, refuses new
//      records, and a type with records cannot be removed;
//   9. the money -- reports, budget, alerts -- is the manager's and senior
//      management's, the budget the Director's alone.
//
// Drives the live API against a real database. Every row it makes is a
// ZZTEST animal type (and the records under it), a ZZTEST shared expense, a
// budget for 2099-01 and the alert settings, which it puts back -- all removed
// or restored in `finally`.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';

const API = process.env.API || 'http://localhost:5000';
let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` : ''}`); }
};
const section = (title) => console.log(`\n=== ${title} ===`);

async function api(token, path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const get = (token, path) => api(token, path);
const post = (token, path, body) => api(token, path, { method: 'POST', body: JSON.stringify(body || {}) });
const put = (token, path, body) => api(token, path, { method: 'PUT', body: JSON.stringify(body || {}) });
const del = (token, path) => api(token, path, { method: 'DELETE' });

// The farm's day, as the API reads it.
const farmDay = (offset = 0) => {
  const now = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.FARM_TIMEZONE || process.env.BOUTIQUE_TIMEZONE || 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
};
const TODAY = farmDay(0);
const YESTERDAY = farmDay(-1);
const TOMORROW = farmDay(1);

const created = [];
async function account(username, name, role, sector) {
  const row = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, sector) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [username, bcrypt.hashSync('zz-farm-unused-1', 4), name, role, sector]
  );
  created.push(row.rows[0].id);
  // Signed exactly as the API signs a session; authMiddleware reads the
  // account back on every request, so every check below is the real one.
  return { id: row.rows[0].id, token: jwt.sign({ id: row.rows[0].id }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }) };
}

let savedThresholds = null;

try {
  section('setup');
  const { token: director } = await directorSession();
  const manager = await account('zz-farm-manager', 'ZZTEST Farm Manager', 'manager', 'farming');
  const staff = await account('zz-farm-staff', 'ZZTEST Farm Hand', 'staff', 'farming');
  const other = await account('zz-farm-staff-two', 'ZZTEST Second Hand', 'staff', 'farming');
  const miner = await account('zz-farm-miner', 'ZZTEST Mining Manager', 'manager', 'mining');
  const general = await account('zz-farm-gm', 'ZZTEST General Manager', 'general-manager', null);
  savedThresholds = (await pool.query('SELECT alert_thresholds FROM farm_settings WHERE id = 1')).rows[0]?.alert_thresholds || {};
  check('the migration made the farm tables and seeded three animal types',
    (await pool.query("SELECT COUNT(*)::int AS n FROM farm_animal_types WHERE seed_key IN ('cows', 'chickens', 'goats')")).rows[0].n === 3);

  section('1. who reaches the farm');
  const refused = await get(miner.token, '/api/farming/overview');
  check('a Mining manager is refused', refused.status === 403 && refused.body.code === 'FARM_ACCESS', refused);
  const reads = await get(general.token, '/api/farming/overview');
  check('the General Manager reads the farm', reads.status === 200 && reads.body.role === 'reader', reads.status);
  const gmWrite = await post(general.token, '/api/farming/issues', { kind: 'other', description: 'ZZTEST should not land' });
  check('  and writes nothing', gmWrite.status === 403, gmWrite);
  const staffView = await get(staff.token, '/api/farming/overview');
  check('a farm team member gets the day without the money', staffView.status === 200 && staffView.body.role === 'staff'
    && staffView.body.alerts === undefined && staffView.body.budget === undefined && staffView.body.summary?.farm === undefined, staffView.body);
  const managerView = await get(manager.token, '/api/farming/overview');
  check('the Farming Manager gets the money and the alerts', managerView.status === 200 && Array.isArray(managerView.body.alerts) && managerView.body.summary?.farm, managerView.status);

  section('2. animal types are data');
  const sheep = await post(manager.token, '/api/farming/animal-types', {
    name: 'ZZTEST Sheep',
    expenseCategories: ['ZZTEST shearing'],
    measures: [{ name: 'ZZTEST Wool', kind: 'product', unit: 'kg', sellable: true }, { name: 'ZZTEST Flock', kind: 'herd', unit: 'head' }]
  });
  check('the Farming Manager adds an animal with what it is measured by', sheep.status === 201, sheep);
  const sheepId = sheep.body.id;
  const catalogue = (await get(staff.token, '/api/farming/animal-types')).body;
  const sheepRow = catalogue.types.find((type) => type.id === sheepId);
  const wool = sheepRow?.measures.find((measure) => measure.kind === 'product');
  const flock = sheepRow?.measures.find((measure) => measure.kind === 'herd');
  check('  and it appears in the catalogue with both measures', Boolean(wool && flock), sheepRow);
  const blank = (await get(manager.token, '/api/farming/overview')).body;
  check('nothing recorded yet reads as unknown, not 0: no stock, no head count',
    blank.stock.find((line) => line.measureId === wool.id)?.onHand === null && blank.herd.find((line) => line.measureId === flock.id)?.head === null,
    { stock: blank.stock.find((line) => line.measureId === wool.id), herd: blank.herd.find((line) => line.measureId === flock.id) });
  const twin = await post(manager.token, '/api/farming/animal-types', { name: '  zztest   SHEEP ' });
  check('the same name again is refused, whatever its spacing or capitals', twin.status === 400 && twin.body.code === 'NAME_EXISTS', twin.body);
  const staffAdds = await post(staff.token, '/api/farming/animal-types', { name: 'ZZTEST Rabbits' });
  check('a team member cannot add an animal', staffAdds.status === 403, staffAdds.status);

  section('3. production');
  const first = await post(staff.token, '/api/farming/production', { measureId: wool.id, date: YESTERDAY, produced: 20, lost: 0, requestKey: 'zztest-farm-wool-0001' });
  check('a team member records production', first.status === 201 && first.body.produced === 20, first.body);
  const replay = await post(staff.token, '/api/farming/production', { measureId: wool.id, date: YESTERDAY, produced: 20, lost: 0, requestKey: 'zztest-farm-wool-0001' });
  check('the same request sent twice answers the first row', replay.status === 200 && replay.body.id === first.body.id, replay.body);
  const twice = await post(staff.token, '/api/farming/production', { measureId: wool.id, date: YESTERDAY, produced: 5 });
  check('a second entry the same day is a warning', twice.status === 409 && twice.body.code === 'POSSIBLE_DUPLICATE' && twice.body.matches?.length === 1, twice.body);
  const confirmed = await post(staff.token, '/api/farming/production', { measureId: wool.id, date: YESTERDAY, produced: 5, confirmDuplicate: true });
  check('  that a second send confirms', confirmed.status === 201, confirmed.body);
  const future = await post(staff.token, '/api/farming/production', { measureId: wool.id, date: TOMORROW, produced: 1 });
  check('a date after today is refused', future.status === 400 && future.body.code === 'DATE_IN_FUTURE', future.body);
  const wrongKind = await post(staff.token, '/api/farming/production', { measureId: flock.id, date: TODAY, produced: 1 });
  check('production on a herd is refused', wrongKind.status === 400 && wrongKind.body.code === 'MEASURE_NOT_PRODUCT', wrongKind.body);
  const negative = await post(staff.token, '/api/farming/production', { measureId: wool.id, date: TODAY, produced: -3 });
  check('a negative figure is refused', negative.status === 400 && negative.body.code === 'PRODUCED_INVALID', negative.body);

  section('4. stock is summed over the whole history');
  const sold = await post(staff.token, '/api/farming/sales', { measureId: wool.id, date: TODAY, quantity: 22, amount: 44000, currency: 'RWF', requestKey: 'zztest-farm-sale-0001' });
  check('selling what was produced is accepted, frozen to USD', sold.status === 201 && sold.body.amountUsd > 0, sold.body);
  const oversold = await post(staff.token, '/api/farming/sales', { measureId: wool.id, date: TODAY, quantity: 4, amount: 8000, currency: 'RWF' });
  check('selling more than is left is refused', oversold.status === 409 && oversold.body.code === 'STOCK_BELOW_ZERO', oversold.body);
  const early = await post(staff.token, '/api/farming/sales', { measureId: wool.id, date: farmDay(-3), quantity: 1, amount: 100, currency: 'RWF' });
  check('a backdated sale before anything was produced is refused', early.status === 409 && early.body.code === 'STOCK_BELOW_ZERO', early.body);
  const strand = await post(manager.token, `/api/farming/production/${first.body.id}/void`, { reason: 'ZZTEST typed on the wrong day' });
  check('voiding the production a sale depended on is refused', strand.status === 409 && strand.body.code === 'STOCK_BELOW_ZERO', strand.body);
  const staffVoid = await post(staff.token, `/api/farming/production/${confirmed.body.id}/void`, { reason: 'ZZTEST the team member tries' });
  check('a team member cannot void', staffVoid.status === 403, staffVoid.status);

  section('5. corrections say why');
  const noReason = await put(staff.token, `/api/farming/production/${first.body.id}`, { produced: 21 });
  check('a correction without a reason is refused', noReason.status === 400 && noReason.body.code === 'CORRECTION_REASON', noReason.body);
  const corrected = await put(staff.token, `/api/farming/production/${first.body.id}`, { produced: 21, reason: 'ZZTEST scale read 21 kg' });
  check('the recorder corrects their own with a reason', corrected.status === 200 && corrected.body.produced === 21, corrected.body);
  const notTheirs = await put(other.token, `/api/farming/production/${first.body.id}`, { produced: 30, reason: 'ZZTEST someone else tries' });
  check('another team member cannot correct it', notTheirs.status === 403, notTheirs.status);
  const trail = await get(manager.token, `/api/farming/audit?entityType=production&entityId=${first.body.id}`);
  check('the correction is in the history with its reason and both figures', trail.status === 200
    && trail.body.some((row) => row.action === 'corrected' && row.reason === 'ZZTEST scale read 21 kg' && row.details.before.produced === 20 && row.details.after.produced === 21), trail.body);
  const tooLow = await put(staff.token, `/api/farming/production/${first.body.id}`, { produced: 10, reason: 'ZZTEST would strand the sale' });
  check('a correction that would strand a sale is refused', tooLow.status === 409 && tooLow.body.code === 'STOCK_BELOW_ZERO', tooLow.body);

  section('6. the herd');
  const born = await post(staff.token, '/api/farming/herd', { measureId: flock.id, date: YESTERDAY, kind: 'birth', count: 5 });
  check('births are recorded', born.status === 201 && born.body.delta === 5, born.body);
  const silentDeath = await post(staff.token, '/api/farming/herd', { measureId: flock.id, date: TODAY, kind: 'death', count: 1 });
  check('a death without a cause is refused', silentDeath.status === 400 && silentDeath.body.code === 'REASON_REQUIRED', silentDeath.body);
  const death = await post(staff.token, '/api/farming/herd', { measureId: flock.id, date: TODAY, kind: 'death', count: 1, reason: 'ZZTEST bloat, vet called' });
  check('  and accepted with one', death.status === 201 && death.body.delta === -1, death.body);
  const herdSaleViaHerd = await post(staff.token, '/api/farming/herd', { measureId: flock.id, date: TODAY, kind: 'sale', count: 1 });
  check('a sale of animals is not a bare herd change', herdSaleViaHerd.status === 400, herdSaleViaHerd.body);
  const animalSale = await post(staff.token, '/api/farming/sales', { measureId: flock.id, date: TODAY, quantity: 2, amount: 300, currency: 'USD' });
  check('selling animals records the money', animalSale.status === 201, animalSale.body);
  const linked = await pool.query("SELECT * FROM farm_herd_events WHERE sale_id = $1 AND status = 'recorded'", [animalSale.body.id]);
  check('  and writes the herd change with it', linked.rowCount === 1 && linked.rows[0].delta === -2, linked.rows);
  const tooMany = await post(staff.token, '/api/farming/sales', { measureId: flock.id, date: TODAY, quantity: 3, amount: 450, currency: 'USD' });
  check('selling more animals than are there is refused', tooMany.status === 409 && tooMany.body.code === 'STOCK_BELOW_ZERO', tooMany.body);
  const unlink = await post(manager.token, `/api/farming/herd/${linked.rows[0].id}/void`, { reason: 'ZZTEST void the herd half only' });
  const counted = (await get(manager.token, '/api/farming/overview')).body;
  // 21 kg (20 corrected to 21) + 5 kg produced - 22 kg sold; 5 born - 1 died - 2 sold.
  check('once recorded, the figures are real: 4 kg of wool left, 2 head',
    counted.stock.find((line) => line.measureId === wool.id)?.onHand === 4 && counted.herd.find((line) => line.measureId === flock.id)?.head === 2,
    { stock: counted.stock.find((line) => line.measureId === wool.id), herd: counted.herd.find((line) => line.measureId === flock.id) });
  check('the herd half of a sale cannot be voided on its own', unlink.status === 409 && unlink.body.code === 'NOT_EDITABLE', unlink.body);
  const voidSale = await post(manager.token, `/api/farming/sales/${animalSale.body.id}/void`, { reason: 'ZZTEST buyer did not take them' });
  const relinked = await pool.query('SELECT status FROM farm_herd_events WHERE sale_id = $1', [animalSale.body.id]);
  check('voiding the sale puts the animals back', voidSale.status === 200 && relinked.rows[0]?.status === 'voided', voidSale.body);

  section('7. expenses');
  const submitted = await post(staff.token, '/api/farming/expenses', {
    date: TODAY, amount: 12000, currency: 'RWF', scope: String(sheepId), category: 'animal_feed', description: 'ZZTEST two bags of feed', payee: 'ZZTEST Agro'
  });
  check('a team member’s expense waits for the Farming Manager', submitted.status === 201 && submitted.body.status === 'pending', submitted.body);
  const ownCategory = await post(staff.token, '/api/farming/expenses', {
    date: TODAY, amount: 5, currency: 'USD', scope: String(sheepId), category: 'ZZTEST shearing', description: 'ZZTEST shearing blades'
  });
  check('the animal’s own kind of cost is accepted', ownCategory.status === 201, ownCategory.body);
  const otherStaffList = await get(other.token, '/api/farming/expenses');
  check('another team member does not see it', otherStaffList.status === 200 && !otherStaffList.body.some((row) => row.id === submitted.body.id), otherStaffList.body.length);
  const staffDecides = await post(staff.token, `/api/farming/expenses/${submitted.body.id}/decision`, { approve: true });
  check('a team member cannot approve', staffDecides.status === 403, staffDecides.status);
  const bareRefusal = await post(manager.token, `/api/farming/expenses/${submitted.body.id}/decision`, { approve: false, note: 'no' });
  check('refusing needs a reason', bareRefusal.status === 400 && bareRefusal.body.code === 'CORRECTION_REASON', bareRefusal.body);
  const approved = await post(manager.token, `/api/farming/expenses/${submitted.body.id}/decision`, { approve: true });
  check('the Farming Manager approves', approved.status === 200 && approved.body.status === 'approved' && approved.body.decidedByName === 'ZZTEST Farm Manager', approved.body);
  const again = await post(manager.token, `/api/farming/expenses/${submitted.body.id}/decision`, { approve: false, note: 'ZZTEST changed my mind' });
  check('  once', again.status === 409 && again.body.code === 'ALREADY_DECIDED', again.body);
  const editApproved = await put(staff.token, `/api/farming/expenses/${submitted.body.id}`, { amount: 99999 });
  check('an approved expense cannot be edited', editApproved.status === 409 && editApproved.body.code === 'NOT_EDITABLE', editApproved.body);
  const dup = await post(staff.token, '/api/farming/expenses', {
    date: TODAY, amount: 12000, currency: 'RWF', scope: String(sheepId), category: 'animal_feed', description: 'ZZTEST two bags again', payee: 'zztest agro'
  });
  check('the same cost twice on one day is a warning', dup.status === 409 && dup.body.code === 'POSSIBLE_DUPLICATE', dup.body);
  const nextWeek = await post(staff.token, '/api/farming/expenses', {
    date: farmDay(-7), amount: 12000, currency: 'RWF', scope: String(sheepId), category: 'animal_feed', description: 'ZZTEST last week’s bags', payee: 'ZZTEST Agro'
  });
  check('the same purchase on another day is not', nextWeek.status === 201, nextWeek.body);
  const managersOwn = await post(manager.token, '/api/farming/expenses', {
    date: TODAY, amount: 40, currency: 'USD', scope: 'shared', category: 'water_electricity', description: 'ZZTEST water bill'
  });
  check('the manager’s own expense is approved as recorded, and a shared one stays shared',
    managersOwn.status === 201 && managersOwn.body.status === 'approved' && managersOwn.body.animalTypeId === null, managersOwn.body);
  const ownTrail = await get(manager.token, `/api/farming/audit?entityType=expense&entityId=${managersOwn.body.id}`);
  check('  and the history says it was recorded and approved by the same person', ownTrail.body.some?.((row) => row.action === 'recorded_and_approved'), ownTrail.body);
  const voidBare = await post(manager.token, `/api/farming/expenses/${nextWeek.body.id}/void`, {});
  check('voiding needs a reason', voidBare.status === 400 && voidBare.body.code === 'CORRECTION_REASON', voidBare.body);

  section('8. switching an animal off');
  const off = await put(manager.token, `/api/farming/animal-types/${sheepId}`, { active: false });
  check('the Farming Manager switches the animal off', off.status === 200 && off.body.active === false, off.body);
  const afterOff = await post(staff.token, '/api/farming/production', { measureId: wool.id, date: TODAY, produced: 1, confirmDuplicate: true });
  check('  new records against it are refused', afterOff.status === 400 && afterOff.body.code === 'TYPE_INACTIVE', afterOff.body);
  const history = await get(manager.token, `/api/farming/production?animalType=${sheepId}`);
  check('  its history is still there', history.status === 200 && history.body.length >= 2, history.body.length);
  const report = await get(manager.token, `/api/farming/report?period=daily&from=${YESTERDAY}&to=${TODAY}&animalType=${sheepId}`);
  const line = report.body.summary?.animalTypes?.find((entry) => entry.animalTypeId === sheepId);
  const woolLine = line?.products.find((product) => product.measureId === wool.id);
  check('  and still counts in the figures (26 kg produced, 22 sold)', report.status === 200 && woolLine?.produced === 26 && woolLine?.sold === 22, line);
  check('  its own costs are its approved expenses only', line?.directExpensesUsd > 0 && report.body.pendingExpenses.count >= 1, line);
  const removeIt = await del(manager.token, `/api/farming/animal-types/${sheepId}`);
  check('an animal with records cannot be removed', removeIt.status === 409 && removeIt.body.code === 'HAS_RECORDS_DEACTIVATE_INSTEAD', removeIt.body);
  const unitChange = await put(manager.token, `/api/farming/measures/${wool.id}`, { unit: 'bales' });
  check('the unit of a measure with records cannot change', unitChange.status === 409 && unitChange.body.code === 'NOT_EDITABLE', unitChange.body);

  section('9. the money is the manager’s; the budget the Director’s');
  const staffReport = await get(staff.token, '/api/farming/report');
  check('a team member does not read the reports', staffReport.status === 403, staffReport.status);
  const gmReport = await get(general.token, `/api/farming/report?from=${YESTERDAY}&to=${TODAY}`);
  check('the General Manager does', gmReport.status === 200, gmReport.status);
  const managerBudget = await put(manager.token, '/api/farming/budget/2099-01', { amountUsd: 500 });
  check('the Farming Manager cannot set the budget', managerBudget.status === 403, managerBudget.status);
  const directorBudget = await put(director, '/api/farming/budget/2099-01', { amountUsd: 500 });
  check('the Director can', directorBudget.status === 200 && directorBudget.body.budgetUsd === 500, directorBudget.body);
  const planBudgets = await pool.query("SELECT COUNT(*)::int AS n FROM monthly_plans WHERE month = '2099-01-01'");
  check('  and it is not a monthly plan', planBudgets.rows[0].n === 0);
  const silly = await put(manager.token, '/api/farming/settings', { thresholds: { declinePercent: 1 } });
  check('an alert threshold outside its range is refused', silly.status === 400 && silly.body.code === 'THRESHOLD_INVALID', silly.body);
  const sensible = await put(manager.token, '/api/farming/settings', { thresholds: { declinePercent: 25 } });
  check('a sensible one is kept', sensible.status === 200 && sensible.body.thresholds.declinePercent === 25, sensible.body);

  section('10. problems');
  const welfare = await post(staff.token, '/api/farming/issues', { kind: 'animal_welfare', description: 'ZZTEST lamb not feeding', animalTypeId: null, urgent: false });
  check('an animal-welfare problem is always urgent', welfare.status === 201 && welfare.body.urgent === true, welfare.body);
  const otherSees = await get(other.token, '/api/farming/issues');
  check('  and every team member sees an urgent one', otherSees.body.some?.((issue) => issue.id === welfare.body.id), otherSees.body);
  const staffResolves = await post(staff.token, `/api/farming/issues/${welfare.body.id}/resolve`, {});
  check('only the manager marks it dealt with', staffResolves.status === 403, staffResolves.status);
  const resolved = await post(manager.token, `/api/farming/issues/${welfare.body.id}/resolve`, { note: 'ZZTEST bottle-fed' });
  check('  which they do', resolved.status === 200 && resolved.body.status === 'resolved', resolved.body);
} catch (error) {
  failed += 1;
  console.log(`  FAIL  the suite stopped: ${error.stack || error.message}`);
} finally {
  // Everything the suite made, children first. The seeded types and every
  // real record are untouched: only ZZTEST rows, the 2099 budget and the
  // settings row (put back as it was).
  const types = (await pool.query("SELECT id FROM farm_animal_types WHERE name LIKE 'ZZTEST%'")).rows.map((row) => row.id);
  const expenseIds = (await pool.query(
    "SELECT id FROM farm_expenses WHERE animal_type_id = ANY($1::int[]) OR description LIKE 'ZZTEST%'", [types]
  )).rows.map((row) => row.id);
  const issueIds = (await pool.query("SELECT id FROM farm_issues WHERE description LIKE 'ZZTEST%' OR animal_type_id = ANY($1::int[])", [types])).rows.map((row) => row.id);
  const productionIds = (await pool.query('SELECT id FROM farm_production WHERE animal_type_id = ANY($1::int[])', [types])).rows.map((row) => row.id);
  const saleIds = (await pool.query('SELECT id FROM farm_sales WHERE animal_type_id = ANY($1::int[])', [types])).rows.map((row) => row.id);
  const herdIds = (await pool.query('SELECT id FROM farm_herd_events WHERE animal_type_id = ANY($1::int[])', [types])).rows.map((row) => row.id);
  const measureIds = (await pool.query('SELECT id FROM farm_measures WHERE animal_type_id = ANY($1::int[])', [types])).rows.map((row) => row.id);
  await pool.query(`DELETE FROM farm_audit WHERE actor_id = ANY($1::int[])
      OR (entity_type = 'animal_type' AND entity_id = ANY($2::int[])) OR (entity_type = 'measure' AND entity_id = ANY($3::int[]))
      OR (entity_type = 'production' AND entity_id = ANY($4::int[])) OR (entity_type = 'sale' AND entity_id = ANY($5::int[]))
      OR (entity_type = 'herd' AND entity_id = ANY($6::int[])) OR (entity_type = 'expense' AND entity_id = ANY($7::int[]))
      OR (entity_type = 'issue' AND entity_id = ANY($8::int[]))
      OR (entity_type = 'budget' AND details->>'month' = '2099-01')`,
  [created, types, measureIds, productionIds, saleIds, herdIds, expenseIds, issueIds]);
  await pool.query('DELETE FROM farm_herd_events WHERE id = ANY($1::int[])', [herdIds]);
  await pool.query('DELETE FROM farm_sales WHERE id = ANY($1::int[])', [saleIds]);
  await pool.query('DELETE FROM farm_production WHERE id = ANY($1::int[])', [productionIds]);
  await pool.query('DELETE FROM farm_expenses WHERE id = ANY($1::int[])', [expenseIds]);
  await pool.query('DELETE FROM farm_issues WHERE id = ANY($1::int[])', [issueIds]);
  await pool.query('DELETE FROM farm_measures WHERE id = ANY($1::int[])', [measureIds]);
  await pool.query('DELETE FROM farm_animal_types WHERE id = ANY($1::int[])', [types]);
  await pool.query("DELETE FROM farm_budgets WHERE month = '2099-01-01'");
  if (savedThresholds !== null) {
    await pool.query('UPDATE farm_settings SET alert_thresholds = $1::jsonb WHERE id = 1', [JSON.stringify(savedThresholds)]);
    await pool.query("DELETE FROM farm_audit WHERE entity_type = 'settings' AND actor_id = ANY($1::int[])", [created]);
  }
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [created]);
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
