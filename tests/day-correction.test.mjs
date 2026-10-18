// A manager corrects the last day they recorded, and only that; and a report
// is exported by the Director alone.
//
//   1. the manager's Home feed (?mine=1) is their own days, newest first, and
//      only the newest is marked correctable;
//   2. they can correct that day -- work, cost, notes -- within the same target
//      and budget checks as recording it, and the month follows the new figure;
//   3. an older day, somebody else's day, and the Director are refused;
//   4. once the month-end report is with the Director the day is fixed;
//   5. a manager cannot export a report; the Director can.
//
// Drives the live API against a real database and removes what it creates.

import bcrypt from 'bcryptjs';
import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';

const API = process.env.API || 'http://localhost:5000';
const MONTH = '2097-03';
const day = (n) => `${MONTH}-${String(n).padStart(2, '0')}`;

let passed = 0;
let failed = 0;
const created = { users: [], plans: [] };

const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200)}` : ''}`); }
};
const section = (title) => console.log(`\n=== ${title} ===`);

async function api(token, path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const post = (token, path, body) => api(token, path, { method: 'POST', body: JSON.stringify(body || {}) });
const put = (token, path, body) => api(token, path, { method: 'PUT', body: JSON.stringify(body || {}) });

async function manager(username, name) {
  const row = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, sector)
     VALUES ($1, $2, $3, 'manager', 'mining') RETURNING id`,
    [username, bcrypt.hashSync('test-pass-123', 10), name]
  );
  created.users.push(row.rows[0].id);
  const login = await api(null, '/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password: 'test-pass-123' })
  });
  if (login.status !== 200) throw new Error(`login ${username}: ${login.status} ${login.body.message}`);
  return { id: row.rows[0].id, token: login.body.token };
}

try {
  section('setup');
  const { token: admin } = await directorSession();
  const managerA = await manager('zz-fix-a', 'ZZ Mining Manager A');
  const managerB = await manager('zz-fix-b', 'ZZ Mining Manager B');
  await pool.query("DELETE FROM monthly_plans WHERE sector = 'mining' AND month = $1::date", [`${MONTH}-01`]);
  const plan = await post(admin, '/api/monthly-plans', {
    operation: 'mining', month: MONTH,
    objective: 'Extract 10 tonnes of ore.', targetQuantity: 10, targetUnit: 'tonnes',
    approvedBudget: 300
  });
  check('a Mining month with a 10-tonne target and $300', plan.status === 201, plan.body);
  created.plans.push(plan.body.id);
  const planId = plan.body.id;

  const first = await post(managerA.token, `/api/monthly-plans/${planId}/reports`, { date: day(2), quantityDone: 2, cost: 50 });
  const second = await post(managerA.token, `/api/monthly-plans/${planId}/reports`, { date: day(3), quantityDone: 8, cost: 50, notes: 'typo: meant 3' });
  const fromB = await post(managerB.token, `/api/monthly-plans/${planId}/reports`, { date: day(4), quantityDone: 0, cost: 10, notes: 'B was here' });
  check('Manager A records two days, Manager B one', [first, second, fromB].every((r) => r.status === 201),
    [first, second, fromB].map((r) => r.status).join(','));
  check('  the month reads Completed at 10 of 10', second.body.plan.status === 'Completed', second.body.plan?.status);

  section('1. The Home feed: own days only, the newest correctable');
  const feed = await api(managerA.token, '/api/monthly-plans/updates?limit=5&mine=1');
  const mineOnly = (feed.body.updates || []).filter((u) => u.planId === planId);
  check('Manager A\'s feed holds only their own two days', mineOnly.length === 2 && mineOnly.every((u) => u.submittedBy === managerA.id),
    mineOnly.map((u) => u.submittedBy));
  check('  newest first, and only it is correctable', mineOnly[0]?.id === second.body.day.id && mineOnly[0].correctable && !mineOnly[1].correctable,
    mineOnly.map((u) => [u.id, u.correctable]));
  const directorFeed = await api(admin, '/api/monthly-plans/updates?limit=5');
  check('the Director\'s feed is not narrowed by ?mine', (directorFeed.body.updates || []).some((u) => u.submittedBy === managerB.id));

  section('2. Manager A corrects their last day');
  const dayPath = (id) => `/api/monthly-plans/${planId}/reports/${id}`;
  const fixed = await put(managerA.token, dayPath(second.body.day.id), { quantityDone: 3, cost: 60, notes: 'corrected' });
  check('the correction is saved', fixed.status === 200, fixed.body);
  check('  progress follows it: 5 of 10, $120 spent', fixed.body.plan?.quantityDone === 5 && fixed.body.plan?.totalSpent === 120,
    `${fixed.body.plan?.quantityDone} / ${fixed.body.plan?.totalSpent}`);
  check('  and the month is no longer Completed', fixed.body.plan?.status === 'In Progress', fixed.body.plan?.status);
  const history = await pool.query("SELECT 1 FROM monthly_plan_history WHERE plan_id = $1 AND action = 'Day corrected'", [planId]);
  check('  the correction is in the month\'s history', history.rowCount === 1);
  const pastTarget = await put(managerA.token, dayPath(second.body.day.id), { quantityDone: 9, cost: 60 });
  check('a correction past the target is refused', pastTarget.status === 400 && pastTarget.body.code === 'OVER_TARGET', pastTarget.body);
  const pastBudget = await put(managerA.token, dayPath(second.body.day.id), { quantityDone: 3, cost: 300 });
  check('a correction past the budget is refused', pastBudget.status === 400, pastBudget.body);
  const atBudget = await put(managerA.token, dayPath(second.body.day.id), { quantityDone: 3, cost: 240 });
  check('  but spending exactly what is left is allowed', atBudget.status === 200, atBudget.body);
  const empty = await put(managerA.token, dayPath(second.body.day.id), { quantityDone: 0, cost: 0, notes: '' });
  check('an empty correction is refused', empty.status === 400, empty.body);

  section('3. Not an older day, not someone else\'s, not the Director');
  const older = await put(managerA.token, dayPath(first.body.day.id), { quantityDone: 1 });
  check('an older day is refused', older.status === 409, older.body);
  const notMine = await put(managerB.token, dayPath(second.body.day.id), { quantityDone: 1 });
  check('Manager B cannot correct Manager A\'s day', notMine.status === 403, notMine.body);
  const byDirector = await put(admin, dayPath(second.body.day.id), { quantityDone: 1 });
  check('the Director cannot rewrite a manager\'s day', byDirector.status === 403, byDirector.body);
  const ownB = await put(managerB.token, dayPath(fromB.body.day.id), { quantityDone: 0, cost: 5, notes: 'B corrected' });
  check('Manager B corrects their own last day', ownB.status === 200, ownB.body);

  section('4. Fixed once the month-end report is with the Director');
  const submitted = await post(managerA.token, `/api/monthly-plans/${planId}/report`, { unusedBalanceExplanation: 'Work continues next month.' });
  check('Manager A submits the month-end report', submitted.status === 201, submitted.body);
  const afterSubmit = await put(managerA.token, dayPath(second.body.day.id), { quantityDone: 2, cost: 60 });
  check('  after which the day cannot be corrected', afterSubmit.status === 409, afterSubmit.body);
  const feedAfter = await api(managerA.token, '/api/monthly-plans/updates?limit=1&mine=1');
  check('  and the feed no longer offers it', feedAfter.body.updates?.[0] && !feedAfter.body.updates[0].correctable, feedAfter.body.updates);

  section('5. Only the Director exports a report');
  const query = `period=monthly&month=${MONTH}`;
  const onScreen = await api(managerA.token, `/api/reports/activities?${query}`);
  check('a manager still reads the report on screen', onScreen.status === 200, String(onScreen.status));
  for (const format of ['pdf', 'xlsx']) {
    const managerExport = await api(managerA.token, `/api/reports/activities/export?${query}&format=${format}`);
    check(`  but cannot export it as ${format}`, managerExport.status === 403 && managerExport.body.code === 'EXPORT_DIRECTOR_ONLY', managerExport.body);
  }
  const directorExport = await fetch(`${API}/api/reports/activities/export?${query}&format=xlsx`, { headers: { Authorization: `Bearer ${admin}` } });
  check('the Director can', directorExport.status === 200, String(directorExport.status));
} catch (error) {
  failed += 1;
  console.log(`  FAIL  unexpected error -- ${error.stack || error.message}`);
} finally {
  for (const id of created.plans) await pool.query('DELETE FROM monthly_plans WHERE id = $1', [id]);
  await pool.query("DELETE FROM users WHERE username LIKE 'zz-fix-%'");
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
