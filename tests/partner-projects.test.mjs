// A partner reads the projects shared with them in full, and exports the report.
//
//   1. nothing is opened until the Director shares a project by name: a
//      partner of the operation with no share reads no project and gets 404;
//   2. once shared, the partner reads the Director's own report for that
//      project -- its monthly plan, objectives, the recorded days and the
//      money -- and downloads it as Excel and as PDF;
//   3. it reaches no further: another project in the same operation, a project
//      in an operation they do not follow, the Director's general report and
//      export, and every write stay refused;
//   4. taking the share away closes it again at once;
//   5. a manager still cannot export (EXPORT_DIRECTOR_ONLY is unchanged).
//
// Drives the live API against a real database. Its rows are a ZZTEST partner
// and manager, the farming test project and a second ZZTEST project, and a
// plan for 2099-04 -- all removed in `finally`.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';
import { createProject, removeProject, PROJECT_IDS } from './fixtures.mjs';

const API = process.env.API || 'http://localhost:5000';
let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` : ''}`); }
};
const section = (title) => console.log(`\n=== ${title} ===`);

async function call(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json().catch(() => ({})) : Buffer.from(await response.arrayBuffer());
  return { status: response.status, type, body: payload };
}
const get = (token, path) => call(token, 'GET', path);

const MONTH = '2099-04';
const SECOND_PROJECT = 'ZZ-PRJ-FARMING-TWO';
const created = [];
let planId = null;

async function account(username, name, role, sector) {
  const row = await pool.query(
    'INSERT INTO users (username, password_hash, name, role, sector) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [username, bcrypt.hashSync('zz-partner-unused-1', 4), name, role, sector]
  );
  created.push(row.rows[0].id);
  return { id: row.rows[0].id, token: jwt.sign({ id: row.rows[0].id }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }) };
}

try {
  section('setup');
  const { token: director } = await directorSession();
  const partner = await account('zz-pp-partner', 'ZZTEST Project Partner', 'partner', 'farming');
  await pool.query('INSERT INTO partner_operations (partner_id, sector) VALUES ($1, $2) ON CONFLICT DO NOTHING', [partner.id, 'farming']);
  const manager = await account('zz-pp-manager', 'ZZTEST Farming Manager', 'manager', 'farming');
  const project = await createProject('farming', { name: 'ZZTEST Partner farm project' });
  await pool.query(
    `INSERT INTO projects (id, name, sector, location, owner, status, progress, budget, spent, category)
     VALUES ($1, 'ZZTEST Other farm project', 'farming', 'ZZTEST', 'ZZTEST', 'On Track', 0, 0, 0, 'ZZTEST') ON CONFLICT (id) DO NOTHING`,
    [SECOND_PROJECT]
  );
  const miningProject = await createProject('mining', { name: 'ZZTEST Mining project' });
  await pool.query("DELETE FROM monthly_plans WHERE month = $1::date AND sector = 'farming'", [`${MONTH}-01`]);
  const plan = await call(director, 'POST', '/api/monthly-plans', {
    operation: 'farming', month: MONTH, projectId: project, approvedBudget: 500,
    objectives: [{ title: 'ZZTEST Plant 40 fruit trees', targetQuantity: 40, targetUnit: 'trees' }]
  });
  planId = plan.body.id;
  check('a month is filed under the project', plan.status === 201, plan.body);
  const objective = (await pool.query('SELECT id FROM plan_objectives WHERE plan_id = $1', [planId])).rows[0].id;
  await pool.query(
    `INSERT INTO plan_daily_reports (plan_id, objective_id, report_date, quantity_done, cost, notes)
     VALUES ($1, $2, $3, 10, 75, 'ZZTEST first ten trees planted')`, [planId, objective, `${MONTH}-05`]
  );

  section('1. nothing is open until it is shared');
  const none = await get(partner.token, '/api/partner/projects');
  check('a partner with no shared project lists none', none.status === 200 && Array.isArray(none.body) && none.body.length === 0, none.body);
  const early = await get(partner.token, `/api/partner/projects/${project}/report?period=monthly&month=${MONTH}`);
  check('  and their operation’s project is not readable in full', early.status === 404, early.status);

  section('2. once shared: the full report, and the files');
  const share = await call(director, 'PUT', `/api/partners/${partner.id}/projects`, { projectIds: [project] });
  check('the Director shares the project', share.status === 200, share.body);
  const listed = await get(partner.token, '/api/partner/projects');
  check('  it is the one project listed', listed.body.length === 1 && listed.body[0].id === project && listed.body[0].operation === 'farming', listed.body);
  const report = await get(partner.token, `/api/partner/projects/${project}/report?period=monthly&month=${MONTH}`);
  const work = report.body.monthlyWork;
  check('the partner reads the report for it', report.status === 200 && report.body.scope?.projectId === project, report.status);
  check('  with the objective agreed for the month', work?.objectives?.some((item) => item.title === 'ZZTEST Plant 40 fruit trees'), work?.objectives);
  check('  the day that was recorded', work?.days?.some((day) => String(day.notes || day.description || '').includes('ZZTEST first ten trees')), work?.days);
  check('  and the money: the budget and what was spent', work?.money?.budget === 500 && work?.money?.spent === 75, work?.money);
  const asDirector = await get(director, `/api/reports/activities?period=monthly&month=${MONTH}&project=${project}`);
  check('  exactly what the Director reads for the same project and month',
    JSON.stringify(asDirector.body.monthlyWork) === JSON.stringify(work), 'monthlyWork differs');
  const xlsx = await get(partner.token, `/api/partner/projects/${project}/report/export?format=xlsx&period=monthly&month=${MONTH}&language=fr`);
  check('the partner downloads it as Excel', xlsx.status === 200 && xlsx.type.includes('spreadsheetml') && xlsx.body.length > 1000, `${xlsx.status} ${xlsx.type}`);
  const pdf = await get(partner.token, `/api/partner/projects/${project}/report/export?format=pdf&period=monthly&month=${MONTH}`);
  check('  and as PDF', pdf.status === 200 && pdf.type.includes('pdf') && pdf.body.slice(0, 4).toString() === '%PDF', `${pdf.status} ${pdf.type}`);
  const badFormat = await get(partner.token, `/api/partner/projects/${project}/report/export?format=docx&period=monthly&month=${MONTH}`);
  check('  in those two formats only', badFormat.status === 400, badFormat.status);

  section('3. no further than the shared project');
  const sibling = await get(partner.token, `/api/partner/projects/${SECOND_PROJECT}/report?period=monthly&month=${MONTH}`);
  check('another project in the same operation stays closed', sibling.status === 404, sibling.status);
  const mining = await get(partner.token, `/api/partner/projects/${miningProject}/report/export?format=xlsx&period=monthly&month=${MONTH}`);
  check('a project in an operation they do not follow stays closed', mining.status === 404, mining.status);
  const forged = await pool.query('INSERT INTO partner_projects (partner_id, project_id) VALUES ($1, $2) RETURNING project_id', [partner.id, miningProject]);
  const forgedRead = await get(partner.token, `/api/partner/projects/${miningProject}/report?period=monthly&month=${MONTH}`);
  check('  even with a share row written past the Director’s check', forged.rowCount === 1 && forgedRead.status === 404, forgedRead.status);
  await pool.query('DELETE FROM partner_projects WHERE partner_id = $1 AND project_id = $2', [partner.id, miningProject]);
  const general = await get(partner.token, `/api/reports/activities?period=monthly&month=${MONTH}`);
  const generalExport = await get(partner.token, `/api/reports/activities/export?format=xlsx&period=monthly&month=${MONTH}`);
  check('the Director’s general report and export stay closed', general.status === 403 && generalExport.status === 403, `${general.status} ${generalExport.status}`);
  const write = await call(partner.token, 'POST', `/api/monthly-plans/${planId}/reports`, { reportDate: `${MONTH}-06`, quantityDone: 1, cost: 0, notes: 'ZZTEST partner write' });
  const planRead = await get(partner.token, `/api/monthly-plans/${planId}`);
  check('the partner still writes nothing and opens no internal page', write.status === 403 && planRead.status === 403, `${write.status} ${planRead.status}`);
  const badPeriod = await get(partner.token, `/api/partner/projects/${project}/report?period=yearly`);
  check('a period the report does not know is refused as bad input', badPeriod.status === 400, badPeriod.status);

  section('4. taking the share away closes it');
  const unshare = await call(director, 'PUT', `/api/partners/${partner.id}/projects`, { projectIds: [] });
  const after = await get(partner.token, `/api/partner/projects/${project}/report/export?format=pdf&period=monthly&month=${MONTH}`);
  check('the Director removes the share and the export is refused at once', unshare.status === 200 && after.status === 404, after.status);

  section('5. the manager’s export is unchanged');
  const managerExport = await get(manager.token, `/api/reports/activities/export?format=xlsx&period=monthly&month=${MONTH}`);
  check('a manager still cannot export', managerExport.status === 403 && managerExport.body.code === 'EXPORT_DIRECTOR_ONLY', managerExport.body);
} catch (error) {
  failed += 1;
  console.log(`  FAIL  the suite stopped: ${error.stack || error.message}`);
} finally {
  await pool.query('DELETE FROM partner_projects WHERE partner_id = ANY($1::int[])', [created]);
  await pool.query('DELETE FROM partner_operations WHERE partner_id = ANY($1::int[])', [created]);
  await pool.query('DELETE FROM organization_history WHERE subject_user_id = ANY($1::int[])', [created]);
  if (planId) await pool.query('DELETE FROM monthly_plans WHERE id = $1', [planId]);
  await pool.query("DELETE FROM monthly_plans WHERE month = $1::date AND notes LIKE 'ZZTEST%'", [`${MONTH}-01`]);
  await removeProject('farming');
  await removeProject('mining');
  await pool.query('UPDATE monthly_plans SET project_id = NULL WHERE project_id = $1', [SECOND_PROJECT]);
  await pool.query('DELETE FROM projects WHERE id = $1', [SECOND_PROJECT]);
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::int[])', [created]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [created]);
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
