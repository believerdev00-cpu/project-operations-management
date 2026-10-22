// End-to-end check of the organisation: the General Manager, reporting lines,
// teams, the project manager's check of finished work, and project-by-project
// partner sharing -- against the running API and the real database.
//
//   1. The Director creates a General Manager; nobody else can create accounts
//      or change a role, and the General Manager reads every operation but
//      decides and creates nothing the Director alone may.
//   2. Reporting lines follow the hierarchy, in the API and in the table: a
//      partner can never be put in the internal line, and a loop is refused.
//   3. Teams: a project manager runs teams only in their own projects; only
//      team members join; a team member on a team is narrowed to its project.
//   4. A team member's finished work is checked by their project manager
//      before the Director's final check, and only the Director marks it done.
//   5. A partner reaches none of it, and a project shared with them narrows
//      their operation to that project.
//   6. Existing projects and their records are untouched by any of the above.
//
// Fixtures use zz- usernames and ZZ-PRJ-/ZZTEST names, and are removed in
// `finally`. Accounts are written straight to the table with a minted session
// (as tests/director.mjs does) except where creating them IS the thing under test.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';
import { PROJECT_IDS, createProject, removeProject } from './fixtures.mjs';

const API = process.env.API || 'http://localhost:5000';
const TEMPORARY = 'test-pass-123';

let passed = 0;
let failed = 0;
const created = { users: [], activities: [], teams: [] };

const check = (label, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` : ''}`); }
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
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}
const send = (token, method, path, body) => api(token, path, { method, body: JSON.stringify(body ?? {}) });

const hash = bcrypt.hashSync(TEMPORARY, 4);

// An account written straight to the table, with a session minted for it the
// way the API mints one. authMiddleware still re-reads the row on every call.
async function person(username, role, { sector = null, managerId = null, name } = {}) {
  const inserted = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, sector, manager_id, access_level, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE) RETURNING id`,
    [username, hash, name || `ZZTEST ${username}`, role, sector, managerId, role === 'partner' ? 'view-only' : 'internal']
  );
  const id = inserted.rows[0].id;
  created.users.push(id);
  if (role === 'manager' && sector) {
    await pool.query('INSERT INTO manager_operations (manager_id, sector) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, sector]);
  }
  if (role === 'partner') {
    await pool.query('INSERT INTO partner_operations (partner_id, sector) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, sector]);
  }
  const token = jwt.sign({ id }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  return { id, token, username };
}

async function activity(projectId, sector, { assignedTo = null, name } = {}) {
  const id = `ZZTEST-ORG-${Math.random().toString(36).slice(2, 10)}`;
  await pool.query(
    `INSERT INTO activities (id, project_id, sector, category, activity, description, status, approval_status,
                             approval_required, externally_visible, assigned_to, approved_budget, cost_usd)
     VALUES ($1, $2, $3, 'ZZTEST', $4, 'Automated test record.', 'Approved', 'approved', FALSE, TRUE, $5, 10, 10)`,
    [id, projectId, sector, name || `ZZTEST ${id}`, assignedTo]
  );
  created.activities.push(id);
  return id;
}

const SECOND_PROJECT = 'ZZ-PRJ-MINING-2';

async function cleanup() {
  await pool.query('DELETE FROM organization_history WHERE actor_id = ANY($1::int[]) OR subject_user_id = ANY($1::int[])', [created.users]);
  await pool.query("DELETE FROM organization_history WHERE detail->>'teamName' LIKE 'ZZTEST%'");
  // Other suites create ZZTEST accounts with a manager, which writes a
  // reporting_changed row; the trail outlives the account by design, so the
  // rows are cleared here -- this suite runs last in `npm test`.
  await pool.query("DELETE FROM organization_history WHERE subject_name LIKE 'ZZTEST%'");
  await pool.query("DELETE FROM teams WHERE name LIKE 'ZZTEST%'");
  for (const id of created.activities) await pool.query('DELETE FROM activities WHERE id = $1', [id]);
  await pool.query('UPDATE users SET manager_id = NULL WHERE manager_id = ANY($1::int[])', [created.users]);
  await pool.query('UPDATE users SET partner_contact_id = NULL WHERE partner_contact_id = ANY($1::int[])', [created.users]);
  for (const id of created.users) {
    await pool.query('UPDATE projects SET manager_id = NULL WHERE manager_id = $1', [id]);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
  await pool.query('UPDATE activities SET project_id = NULL WHERE project_id = $1', [SECOND_PROJECT]);
  await pool.query('DELETE FROM projects WHERE id = $1', [SECOND_PROJECT]);
  await removeProject('mining');
  await removeProject('farming');
}

async function run() {
  const director = await directorSession();
  const projectsBefore = await pool.query("SELECT id, name, sector, manager_id FROM projects WHERE id NOT LIKE 'ZZ-%' ORDER BY id");
  const activitiesBefore = await pool.query("SELECT COUNT(*)::int AS total FROM activities WHERE id NOT LIKE 'ZZTEST%'");

  // ---- the cast --------------------------------------------------------------
  const pmA = await person('zz-org-pm-a', 'manager', { sector: 'mining' });
  const pmB = await person('zz-org-pm-b', 'manager', { sector: 'mining' });
  const pmFarm = await person('zz-org-pm-farm', 'manager', { sector: 'farming' });
  const staffA = await person('zz-org-staff-a', 'staff', { sector: 'mining', managerId: pmA.id });
  const staffB = await person('zz-org-staff-b', 'staff', { sector: 'mining', managerId: pmB.id });
  const staffFarm = await person('zz-org-staff-farm', 'staff', { sector: 'farming' });
  const partner = await person('zz-org-partner', 'partner', { sector: 'mining' });

  await createProject('mining', { managerId: pmA.id, name: 'ZZTEST Mining A' });
  await pool.query(
    `INSERT INTO projects (id, name, sector, manager_id, location, owner, status, progress, budget, spent, category)
     VALUES ($1, 'ZZTEST Mining B', 'mining', $2, 'ZZTEST site', 'ZZTEST owner', 'On Track', 0, 1000, 0, 'ZZTEST')
     ON CONFLICT (id) DO UPDATE SET manager_id = EXCLUDED.manager_id`,
    [SECOND_PROJECT, pmB.id]
  );
  await createProject('farming', { managerId: pmFarm.id });
  const workA = await activity(PROJECT_IDS.mining, 'mining', { name: 'ZZTEST work on A' });
  const workB = await activity(SECOND_PROJECT, 'mining', { name: 'ZZTEST work on B' });

  // ---- 1. the General Manager ---------------------------------------------------
  section('1. the General Manager is created by the Director and oversees without deciding');
  const gmCreated = await send(director.token, 'POST', '/api/users', {
    username: 'zz-org-gm', name: 'ZZTEST General Manager', role: 'general-manager', password: TEMPORARY, managerId: director.id
  });
  if (gmCreated.status === 201) created.users.push(gmCreated.body.id);
  check('the Director creates a General Manager reporting to them', gmCreated.status === 201 && gmCreated.body.role === 'general-manager'
    && gmCreated.body.managerId === director.id, gmCreated.body);
  await pool.query('UPDATE users SET must_change_password = FALSE WHERE id = $1', [gmCreated.body.id]);
  const gm = { id: gmCreated.body.id, token: jwt.sign({ id: gmCreated.body.id }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }) };

  for (const [who, token] of [['a project manager', pmA.token], ['a team member', staffA.token], ['the General Manager', gm.token]]) {
    const attempt = await send(token, 'POST', '/api/users', { username: 'zz-org-sneak', name: 'Sneak', role: 'general-manager', password: TEMPORARY });
    if (attempt.status === 201) created.users.push(attempt.body.id);
    check(`${who} cannot create accounts (no self-promotion)`, attempt.status === 403, attempt);
  }
  const promote = await send(pmA.token, 'PATCH', `/api/users/${pmA.id}/assignment`, { managerId: null });
  check('a project manager cannot change their own reporting line', promote.status === 403, promote);
  const superAdmin = await send(director.token, 'POST', '/api/users', { username: 'zz-org-sa', name: 'X', role: 'super-admin', password: TEMPORARY });
  if (superAdmin.status === 201) created.users.push(superAdmin.body.id);
  check('nobody can mint a second Director through the API', superAdmin.status === 400, superAdmin);

  const gmActivities = await api(gm.token, '/api/activities?limit=200');
  const gmIds = new Set((gmActivities.body || []).map((row) => row.id));
  check('the General Manager reads activities in every operation and project', gmIds.has(workA) && gmIds.has(workB), gmActivities.status);
  const gmProjects = await api(gm.token, '/api/projects');
  check('the General Manager sees every project', [PROJECT_IDS.mining, SECOND_PROJECT, PROJECT_IDS.farming]
    .every((id) => (gmProjects.body || []).some((project) => project.id === id)));
  const gmReport = await api(gm.token, '/api/reports/activities?period=monthly');
  check('the General Manager reads reports on screen', gmReport.status === 200, gmReport.status);
  const gmExport = await api(gm.token, '/api/reports/activities/export?period=monthly&format=pdf');
  check('...but cannot export them (the Director alone does)', gmExport.status === 403, gmExport.status);
  const gmRaise = await send(gm.token, 'POST', '/api/activities', {
    projectId: PROJECT_IDS.mining, sector: 'mining', category: 'ZZTEST', activity: 'ZZTEST gm', description: 'x', quantity: 1, costUsd: 1
  });
  if (gmRaise.status === 201) created.activities.push(gmRaise.body.id);
  check('the General Manager cannot raise or assign an activity', gmRaise.status === 403, gmRaise);
  const gmTrip = await send(gm.token, 'POST', '/api/movements', { purpose: 'ZZTEST', destination: 'x' });
  check('the General Manager cannot raise a trip', gmTrip.status === 403, gmTrip);
  const gmProject = await send(gm.token, 'POST', '/api/projects', { name: 'ZZTEST', sector: 'mining' });
  check('the General Manager cannot create projects', gmProject.status === 403, gmProject);
  const gmPartners = await api(gm.token, '/api/partners');
  check('the General Manager cannot manage partners', gmPartners.status === 403, gmPartners.status);
  const gmInbox = await api(gm.token, '/api/partner-comments');
  check("the General Manager cannot read partners' messages to the Director", gmInbox.status === 403, gmInbox.status);
  const gmSummary = await api(gm.token, '/api/summary');
  check('the General Manager gets the organisation-wide summary', gmSummary.status === 200
    && gmSummary.body.sectorBreakdown?.length === 4 && typeof gmSummary.body.summary?.managerChecksWaiting === 'number', gmSummary.status);

  // ---- 2. reporting lines --------------------------------------------------------
  section('2. reporting lines follow the hierarchy');
  const toGm = await send(director.token, 'PATCH', `/api/users/${pmA.id}/assignment`, { managerId: gm.id });
  check('a project manager can report to the General Manager', toGm.status === 200 && toGm.body.managerId === gm.id, toGm.body);
  await send(director.token, 'PATCH', `/api/users/${pmB.id}/assignment`, { managerId: gm.id });
  const staffToGm = await send(director.token, 'PATCH', `/api/users/${staffA.id}/assignment`, { managerId: gm.id });
  check('a team member cannot report straight to the General Manager', staffToGm.status === 400, staffToGm);
  const gmToPm = await send(director.token, 'PATCH', `/api/users/${gm.id}/assignment`, { managerId: pmA.id });
  check('the General Manager cannot report to a project manager', gmToPm.status === 400, gmToPm);
  const partnerLine = await send(director.token, 'PATCH', `/api/users/${partner.id}/assignment`, { managerId: gm.id });
  check('a partner cannot be put in the internal line through the API', partnerLine.status === 403, partnerLine);
  let tableRefused = false;
  try { await pool.query('UPDATE users SET manager_id = $2 WHERE id = $1', [partner.id, gm.id]); } catch (error) { tableRefused = error.code === 'P0001'; }
  check('...nor directly in the table (the trigger refuses it)', tableRefused);
  let loopRefused = false;
  await pool.query('UPDATE users SET manager_id = $2 WHERE id = $1', [pmB.id, pmA.id]);
  try { await pool.query('UPDATE users SET manager_id = $2 WHERE id = $1', [pmA.id, pmB.id]); } catch (error) { loopRefused = /loop/.test(error.message); }
  check('a reporting loop is refused by the table', loopRefused);
  const loopApi = await send(director.token, 'PATCH', `/api/users/${pmA.id}/assignment`, { managerId: pmB.id });
  check('...and by the API', loopApi.status === 400, loopApi);
  await pool.query('UPDATE users SET manager_id = $2 WHERE id = $1', [pmB.id, gm.id]);
  const gmSector = await send(director.token, 'PATCH', `/api/users/${gm.id}/assignment`, { sector: 'mining' });
  check('the General Manager has no operation to narrow', gmSector.status === 400, gmSector);

  // ---- 3. teams ------------------------------------------------------------------
  section('3. teams belong to projects and are run by the people above them');
  const teamA = await send(pmA.token, 'POST', '/api/organization/teams', { projectId: PROJECT_IDS.mining, name: 'ZZTEST Drill crew' });
  if (teamA.status === 201) created.teams.push(teamA.body.id);
  check('a project manager creates a team in their own project', teamA.status === 201 && teamA.body.leadId === pmA.id, teamA);
  const dup = await send(pmA.token, 'POST', '/api/organization/teams', { projectId: PROJECT_IDS.mining, name: ' zztest drill CREW ' });
  check('the same team name twice in one project is refused', dup.status === 409, dup);
  const teamA2 = await send(pmA.token, 'POST', '/api/organization/teams', { projectId: PROJECT_IDS.mining, name: 'ZZTEST Haulage crew' });
  check('a project can have several teams', teamA2.status === 201, teamA2);
  const foreign = await send(pmA.token, 'POST', '/api/organization/teams', { projectId: SECOND_PROJECT, name: 'ZZTEST Not mine' });
  check("a project manager cannot create a team in a colleague's project", foreign.status === 403, foreign);
  const teamB = await send(gm.token, 'POST', '/api/organization/teams', { projectId: SECOND_PROJECT, name: 'ZZTEST Crew B' });
  check('the General Manager creates a team in any project', teamB.status === 201, teamB);
  const pickSupervisor = await send(pmA.token, 'PATCH', `/api/organization/teams/${teamA.body.id}`, { supervisorId: pmB.id });
  check('a project manager cannot hand their team to another supervisor', pickSupervisor.status === 403, pickSupervisor);
  const farmSupervisor = await send(gm.token, 'PATCH', `/api/organization/teams/${teamA.body.id}`, { supervisorId: pmFarm.id });
  check("a supervisor must work in the team's operation", farmSupervisor.status === 400, farmSupervisor);

  const addStaff = await send(pmA.token, 'POST', `/api/organization/teams/${teamA.body.id}/members`, { userId: staffA.id, isLeader: true });
  check('a project manager adds a team member to their team, as leader', addStaff.status === 201, addStaff);
  const again = await send(pmA.token, 'POST', `/api/organization/teams/${teamA.body.id}/members`, { userId: staffA.id });
  check('adding the same person twice is refused', again.status === 409, again);
  const addPartner = await send(gm.token, 'POST', `/api/organization/teams/${teamA.body.id}/members`, { userId: partner.id });
  check('a partner can never join a team', addPartner.status === 400, addPartner);
  let partnerRowRefused = false;
  try { await pool.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)', [teamA.body.id, partner.id]); } catch (error) { partnerRowRefused = error.code === 'P0001'; }
  check('...nor directly in the table', partnerRowRefused);
  const addManager = await send(gm.token, 'POST', `/api/organization/teams/${teamA.body.id}/members`, { userId: pmB.id });
  check('a manager is a supervisor, not a team member', addManager.status === 400, addManager);
  const addFarm = await send(gm.token, 'POST', `/api/organization/teams/${teamA.body.id}/members`, { userId: staffFarm.id });
  check('a team member from another operation is refused', addFarm.status === 400, addFarm);
  const otherTeam = await send(pmA.token, 'POST', `/api/organization/teams/${teamB.body.id}/members`, { userId: staffA.id });
  check("a project manager cannot change a colleague's team", otherTeam.status === 403, otherTeam);
  const staffChanges = await send(staffA.token, 'POST', `/api/organization/teams/${teamA.body.id}/members`, { userId: staffB.id });
  check('a team leader cannot put people on teams', staffChanges.status === 403, staffChanges);
  const addB = await send(pmB.token, 'POST', `/api/organization/teams/${teamB.body.id}/members`, { userId: staffB.id });
  check('the other project manager staffs their own team', addB.status === 201, addB);
  const notice = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'team_added'", [staffA.id]);
  check('a team member is told they were put on a team', notice.rowCount === 1);

  const staffSees = await api(staffA.token, '/api/activities?limit=200');
  const staffIds = new Set((staffSees.body || []).map((row) => row.id));
  check("a team member on a team reads their team's project", staffIds.has(workA), staffSees.status);
  check("...and not another team's project in the same operation", !staffIds.has(workB));
  const staffOpens = await api(staffA.token, `/api/activities/${workB}`);
  check("...not even by opening the other project's record directly", staffOpens.status === 404, staffOpens.status);
  const assignedElsewhere = await activity(SECOND_PROJECT, 'mining', { assignedTo: staffA.id, name: 'ZZTEST assigned outside the team' });
  const staffStill = await api(staffA.token, `/api/activities/${assignedElsewhere}`);
  check('...but work assigned to them outside their teams stays theirs to see', staffStill.status === 200, staffStill.status);
  const unteamed = await person('zz-org-staff-free', 'staff', { sector: 'mining' });
  const freeSees = await api(unteamed.token, '/api/activities?limit=200');
  const freeIds = new Set((freeSees.body || []).map((row) => row.id));
  check('a team member on no team keeps the operation-wide view they had', freeIds.has(workA) && freeIds.has(workB));

  const pmChart = await api(pmA.token, '/api/organization');
  check("a project manager's chart holds their teams, not their colleague's", pmChart.status === 200
    && pmChart.body.teams.some((team) => team.id === teamA.body.id)
    && !pmChart.body.teams.some((team) => team.id === teamB.body.id), pmChart.body?.teams?.map((team) => team.name));
  check('...and no partner branch', Array.isArray(pmChart.body.partners) && pmChart.body.partners.length === 0);
  const gmChart = await api(gm.token, '/api/organization');
  check('the General Manager sees the whole chart and the partner branch', gmChart.status === 200
    && gmChart.body.teams.length >= 3 && gmChart.body.partners.some((row) => row.id === partner.id)
    && gmChart.body.people.some((row) => row.id === pmA.id && row.reportsToId === gm.id));
  const staffChart = await api(staffA.token, '/api/organization');
  check('a team member sees their own team and the line above them only', staffChart.status === 200
    && staffChart.body.teams.length === 1 && staffChart.body.people.some((row) => row.id === gm.id)
    && !staffChart.body.people.some((row) => row.id === staffB.id), staffChart.body?.people?.map((row) => row.name));
  const pmHistory = await api(pmA.token, '/api/organization/history');
  check('the organisation trail is for senior management', pmHistory.status === 403, pmHistory.status);
  const gmHistory = await api(gm.token, '/api/organization/history');
  check('...and records who created teams and added people', gmHistory.status === 200
    && gmHistory.body.some((row) => row.action === 'team_created' && row.actorName === 'ZZTEST zz-org-pm-a')
    && gmHistory.body.some((row) => row.action === 'member_added' && row.subjectName === 'ZZTEST zz-org-staff-a'));

  const archive = await send(pmA.token, 'PATCH', `/api/organization/teams/${teamA2.body.id}`, { status: 'archived' });
  check('a project manager archives a team', archive.status === 200 && archive.body.status === 'archived', archive);
  const archivedAdd = await send(pmA.token, 'POST', `/api/organization/teams/${teamA2.body.id}/members`, { userId: unteamed.id });
  check('nobody joins an archived team', archivedAdd.status === 409, archivedAdd);

  // ---- 4. finished work ----------------------------------------------------------
  section("4. a team member's finished work is checked by their project manager first");
  const done = await activity(PROJECT_IDS.mining, 'mining', { assignedTo: staffA.id, name: 'ZZTEST finished by staff' });
  await pool.query("UPDATE activities SET status = 'In Progress', evidence_required = FALSE WHERE id = $1", [done]);
  const handIn = await send(staffA.token, 'POST', `/api/activities/${done}/completion`, {});
  check('the team member hands the work in', handIn.status === 200, handIn);
  check('...and it names their project manager as its checker', handIn.body.completionCheckerId === pmA.id, handIn.body);
  const directorQueue = await api(director.token, '/api/activities?awaiting=final-check&limit=200');
  check("it is not yet in the Director's final check", !(directorQueue.body || []).some((row) => row.id === done));
  const pmQueue = await api(pmA.token, '/api/activities?awaiting=check&limit=200');
  check("it is in the project manager's check queue", (pmQueue.body || []).some((row) => row.id === done));
  const pmSummary = await api(pmA.token, '/api/summary');
  check('...and counted for them', pmSummary.body.summary?.workToCheck >= 1);
  const gmFollows = await api(gm.token, '/api/summary');
  check('the General Manager sees it waiting for a manager', gmFollows.body.summary?.managerChecksWaiting >= 1);
  const toldChecker = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'work_to_check'", [pmA.id]);
  check('the project manager was told', toldChecker.rowCount === 1);
  const otherPm = await send(pmB.token, 'POST', `/api/activities/${done}/check`, { accept: true });
  check('another project manager cannot check it', otherPm.status === 403 || otherPm.status === 404, otherPm);
  const selfCheck = await send(staffA.token, 'POST', `/api/activities/${done}/check`, { accept: true });
  check('the team member cannot check their own work', selfCheck.status === 403, selfCheck);
  const vague = await send(pmA.token, 'POST', `/api/activities/${done}/check`, { accept: false, note: 'redo' });
  check('sending it back needs a real reason', vague.status === 400, vague);
  const back = await send(pmA.token, 'POST', `/api/activities/${done}/check`, { accept: false, note: 'The photos do not show the finished trench.' });
  check('the project manager sends it back with a reason', back.status === 200 && back.body.status === 'Needs Correction'
    && back.body.completionSubmittedAt === null, back.body);
  const toldStaff = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'work_returned'", [staffA.id]);
  check('the team member is told why', toldStaff.rowCount >= 1);
  await send(staffA.token, 'PATCH', `/api/activities/${done}/status`, { status: 'In Progress' });
  const handInAgain = await send(staffA.token, 'POST', `/api/activities/${done}/completion`, {});
  check('the team member hands it in again', handInAgain.status === 200 && handInAgain.body.completionCheckerId === pmA.id, handInAgain);
  const passed = await send(pmA.token, 'POST', `/api/activities/${done}/check`, { accept: true, note: 'Looks right.' });
  check('the project manager passes it on', passed.status === 200 && passed.body.managerCheckedAt, passed.body);
  const twiceChecked = await send(pmA.token, 'POST', `/api/activities/${done}/check`, { accept: true });
  check('it cannot be checked twice', twiceChecked.status === 409, twiceChecked);
  const nowWithDirector = await api(director.token, '/api/activities?awaiting=final-check&limit=200');
  check("now it is in the Director's final check", (nowWithDirector.body || []).some((row) => row.id === done));
  const toldDirector = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'work_submitted' AND activity_id = $2", [director.id, done]);
  check('and the Director was told', toldDirector.rowCount >= 1);
  const pmCompletes = await send(pmA.token, 'PATCH', `/api/activities/${done}/decision`, { status: 'Completed' });
  check('the project manager still cannot mark it done', pmCompletes.status === 403, pmCompletes);
  const finished = await send(director.token, 'PATCH', `/api/activities/${done}/decision`, { status: 'Completed' });
  check('the Director gives the final check', finished.status === 200 && finished.body.status === 'Completed', finished.body);
  const managerWork = await activity(PROJECT_IDS.mining, 'mining', { assignedTo: pmA.id, name: 'ZZTEST finished by manager' });
  await pool.query("UPDATE activities SET status = 'In Progress', evidence_required = FALSE WHERE id = $1", [managerWork]);
  const managerHandIn = await send(pmA.token, 'POST', `/api/activities/${managerWork}/completion`, {});
  check("a manager's own finished work still goes straight to the Director", managerHandIn.status === 200
    && managerHandIn.body.completionCheckerId === null, managerHandIn.body);

  // ---- 5. partners -----------------------------------------------------------------
  section('5. partners stay outside, and see only what was shared');
  for (const path of ['/api/organization', '/api/organization/history']) {
    const attempt = await api(partner.token, path);
    check(`a partner cannot reach ${path}`, attempt.status === 403, attempt.status);
  }
  const partnerNotices = await api(partner.token, '/api/notifications');
  check('a partner reads their own notifications', partnerNotices.status === 200, partnerNotices.status);
  const before = await api(partner.token, '/api/partner/activities');
  const beforeIds = new Set((before.body || []).map((row) => row.id));
  check('with the whole operation shared, the partner sees both Mining projects', beforeIds.has(workA) && beforeIds.has(workB), before.status);
  const shareFarm = await send(director.token, 'PUT', `/api/partners/${partner.id}/projects`, { projectIds: [PROJECT_IDS.farming] });
  check('a project outside their operations cannot be shared', shareFarm.status === 400, shareFarm);
  const gmShares = await send(gm.token, 'PUT', `/api/partners/${partner.id}/projects`, { projectIds: [PROJECT_IDS.mining] });
  check('the General Manager cannot change what a partner sees', gmShares.status === 403, gmShares.status);
  const share = await send(director.token, 'PUT', `/api/partners/${partner.id}/projects`, { projectIds: [PROJECT_IDS.mining] });
  check('the Director shares one Mining project', share.status === 200 && share.body.projects.length === 1 && share.body.visibleActivities >= 1, share.body);
  const after = await api(partner.token, '/api/partner/activities');
  const afterIds = new Set((after.body || []).map((row) => row.id));
  check('the partner now sees that project', afterIds.has(workA));
  check('...and not the rest of the operation', !afterIds.has(workB));
  const overview = await api(partner.token, '/api/partner/overview');
  check('the overview names the shared project', overview.body.sharedProjects?.some((row) => row.id === PROJECT_IDS.mining), overview.body.sharedProjects);
  const commentProbe = await send(partner.token, 'POST', '/api/partner/comments', { operation: 'mining', subjectType: 'activity', subjectId: workB, body: 'probe' });
  check('a partner cannot comment on a record outside the shared project', commentProbe.status === 404 || commentProbe.status === 400, commentProbe);
  const sharedNotice = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'partner_shared'", [partner.id]);
  check('the partner was told a project was shared with them', sharedNotice.rowCount === 1);
  const profile = await send(director.token, 'PATCH', `/api/partners/${partner.id}/profile`, { organization: 'ZZTEST Minerals Ltd', contactId: gm.id });
  check('the Director records the partner organisation and its contact', profile.status === 200
    && profile.body.organization === 'ZZTEST Minerals Ltd' && profile.body.contactId === gm.id, profile.body);
  const badContact = await send(director.token, 'PATCH', `/api/partners/${partner.id}/profile`, { contactId: staffA.id });
  check("a partner's contact is a manager or above, never a team member", badContact.status === 400, badContact);
  const unshare = await send(director.token, 'PUT', `/api/partners/${partner.id}/projects`, { projectIds: [] });
  const restored = await api(partner.token, '/api/partner/activities');
  check('sharing nothing project by project gives the whole operation back', unshare.status === 200
    && (restored.body || []).some((row) => row.id === workB));

  // ---- 6. nothing existing changed ---------------------------------------------
  section('6. existing projects and records are untouched');
  const projectsAfter = await pool.query("SELECT id, name, sector, manager_id FROM projects WHERE id NOT LIKE 'ZZ-%' ORDER BY id");
  check('every existing project is still there, unchanged', JSON.stringify(projectsAfter.rows) === JSON.stringify(projectsBefore.rows));
  const activitiesAfter = await pool.query("SELECT COUNT(*)::int AS total FROM activities WHERE id NOT LIKE 'ZZTEST%'");
  check('no existing activity was added or removed', activitiesAfter.rows[0].total === activitiesBefore.rows[0].total);
  const pmStillWorks = await api(pmA.token, '/api/activities?limit=200');
  check('a project manager still reads their own project as before', (pmStillWorks.body || []).some((row) => row.id === workA)
    && !(pmStillWorks.body || []).some((row) => row.id === workB));
}

try {
  await run();
} catch (error) {
  failed += 1;
  console.error(error);
} finally {
  await cleanup().catch((error) => console.error('cleanup failed:', error.message));
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
