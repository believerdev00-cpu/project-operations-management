// A project's discussion and documents, shared with its external partners.
//
//   1. a partner shared two projects reads both -- report, documents and
//      discussion -- and nothing of a project not shared with them;
//   2. a partner comments on the project, on one of its months, and on one of
//      its activities; each comment keeps its author, project, record and time;
//      a record of another project cannot be named;
//   3. every partner of the project reads the discussion and may take part;
//      a partner of another project cannot;
//   4. the project's manager is told, once, and so are the Directors; a manager
//      of another operation is not; an answer tells the partners in the
//      conversation;
//   5. inside: the Director and the project's manager read, answer and mark a
//      question answered; the General Manager reads only; a manager of another
//      operation and a team member read nothing; a partner cannot reach it;
//      a partner writing again re-opens an answered question;
//   6. the private messages to the Director stay apart from the discussions;
//   7. documents: listed and downloaded only through a shared project, never
//      by an id from another project;
//   8. a partner still performs no administrative action; taking the share
//      away closes everything at once.
//
// Drives the live API against a real database and the configured file store.
// Its rows are ZZTEST accounts, projects, a plan for 2099-05, activities and
// two small files -- all removed in `finally`.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../server/db/database.js';
import { deleteFile, saveFile } from '../server/lib/storage.js';
import { directorSession } from './director.mjs';
import { createProject, removeProject } from './fixtures.mjs';

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
const post = (token, path, body) => call(token, 'POST', path, body);

const MONTH = '2099-05';
const SECOND = 'ZZ-PRJ-FARMING-SECOND';
const created = { users: [], activities: [], files: [] };
let planId = null;

async function account(username, name, role, sector) {
  const row = await pool.query(
    'INSERT INTO users (username, password_hash, name, role, sector) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [username, bcrypt.hashSync('zz-discussion-unused-1', 4), name, role, sector]
  );
  created.users.push(row.rows[0].id);
  return { id: row.rows[0].id, token: jwt.sign({ id: row.rows[0].id }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }) };
}
async function partner(username, operations, organization = '') {
  const made = await account(username, `ZZTEST ${username}`, 'partner', operations[0]);
  await pool.query('UPDATE users SET organization = $2 WHERE id = $1', [made.id, organization]);
  for (const sector of operations) await pool.query('INSERT INTO partner_operations (partner_id, sector) VALUES ($1, $2) ON CONFLICT DO NOTHING', [made.id, sector]);
  return made;
}
async function activity(projectId, sector, name) {
  const id = `ZZTEST-DISC-${Math.random().toString(36).slice(2, 10)}`;
  await pool.query(
    `INSERT INTO activities (id, project_id, sector, category, activity, description, status, approval_status,
                             approval_required, externally_visible, approved_budget, cost_usd)
     VALUES ($1, $2, $3, 'ZZTEST', $4, 'Automated test record.', 'Approved', 'approved', FALSE, TRUE, 10, 10)`,
    [id, projectId, sector, name]
  );
  created.activities.push(id);
  return id;
}
async function evidence(activityId, name) {
  const stored = `zztest-${Math.random().toString(36).slice(2, 12)}.txt`;
  await saveFile('activities', stored, Buffer.from(`ZZTEST ${name}`));
  created.files.push(stored);
  const row = await pool.query(
    `INSERT INTO activity_evidence (activity_id, kind, original_name, stored_name, mime_type, size_bytes)
     VALUES ($1, 'Receipt', $2, $3, 'text/plain', 20) RETURNING id`,
    [activityId, name, stored]
  );
  return row.rows[0].id;
}
const notices = async (userId, kind) => (await pool.query(
  'SELECT * FROM notifications WHERE user_id = $1 AND kind = $2 ORDER BY id', [userId, kind]
)).rows;

try {
  section('setup');
  const { id: directorId, token: director } = await directorSession();
  const manager = await account('zz-disc-manager', 'ZZTEST Farm Project Manager', 'manager', 'farming');
  const miner = await account('zz-disc-miner', 'ZZTEST Mining Manager', 'manager', 'mining');
  const general = await account('zz-disc-gm', 'ZZTEST General Manager', 'general-manager', null);
  const staff = await account('zz-disc-staff', 'ZZTEST Farm Hand', 'staff', 'farming');
  // Alice and Bob work for the same buyer (written differently on purpose);
  // Carol is a lender on the same project; Dave has no organisation recorded.
  const alice = await partner('zz-disc-alice', ['farming', 'agriculture'], 'ZZTEST Buyer Ltd');
  const bob = await partner('zz-disc-bob', ['farming'], '  zztest buyer ltd ');
  const carol = await partner('zz-disc-carol', ['farming'], 'ZZTEST Lender Ltd');
  const dave = await partner('zz-disc-dave', ['farming'], '');
  const farm = await createProject('farming', { managerId: manager.id, name: 'ZZTEST Discussion farm' });
  const agri = await createProject('agriculture', { name: 'ZZTEST Discussion agriculture' });
  const mine = await createProject('mining', { managerId: miner.id, name: 'ZZTEST Discussion mine' });
  await pool.query(
    `INSERT INTO projects (id, name, sector, location, owner, status, progress, budget, spent, category)
     VALUES ($1, 'ZZTEST Unshared farm', 'farming', 'ZZTEST', 'ZZTEST', 'On Track', 0, 0, 0, 'ZZTEST') ON CONFLICT (id) DO NOTHING`, [SECOND]
  );
  await pool.query("DELETE FROM monthly_plans WHERE month = $1::date AND sector = 'farming'", [`${MONTH}-01`]);
  const plan = await post(director, '/api/monthly-plans', { operation: 'farming', month: MONTH, projectId: farm, approvedBudget: 100, objectives: [{ title: 'ZZTEST Fence the paddock' }] });
  planId = plan.body.id;
  const farmWork = await activity(farm, 'farming', 'ZZTEST Repair the water tank');
  const otherWork = await activity(SECOND, 'farming', 'ZZTEST Unshared work');
  const farmFile = await evidence(farmWork, 'zztest-tank-receipt.txt');
  const otherFile = await evidence(otherWork, 'zztest-other-receipt.txt');
  await call(director, 'PUT', `/api/partners/${alice.id}/projects`, { projectIds: [farm, agri] });
  await call(director, 'PUT', `/api/partners/${bob.id}/projects`, { projectIds: [farm] });
  await call(director, 'PUT', `/api/partners/${carol.id}/projects`, { projectIds: [farm] });
  await call(director, 'PUT', `/api/partners/${dave.id}/projects`, { projectIds: [farm] });
  check('setup made the plan and shared the projects', plan.status === 201, plan.body);

  section('1. a partner reads the projects shared with them, and only those');
  const listed = await get(alice.token, '/api/partner/projects');
  check('a partner shared two projects lists both', listed.status === 200 && [farm, agri].every((id) => listed.body.some((row) => row.id === id)) && listed.body.length === 2, listed.body);
  for (const id of [farm, agri]) {
    const [discussion, files, report] = await Promise.all([
      get(alice.token, `/api/partner/projects/${id}/discussion`),
      get(alice.token, `/api/partner/projects/${id}/files`),
      get(alice.token, `/api/partner/projects/${id}/report?period=monthly&month=${MONTH}`)
    ]);
    check(`  and reads each in full (${id})`, discussion.status === 200 && files.status === 200 && report.status === 200, `${discussion.status} ${files.status} ${report.status}`);
  }
  for (const [label, id] of [['an unshared project in their operation', SECOND], ['a project in an operation they do not follow', mine]]) {
    const reads = await Promise.all([
      get(alice.token, `/api/partner/projects/${id}/discussion`),
      get(alice.token, `/api/partner/projects/${id}/files`),
      post(alice.token, `/api/partner/projects/${id}/discussion`, { body: 'ZZTEST should not land' })
    ]);
    check(`${label} is not found, read or written`, reads.every((result) => result.status === 404), reads.map((result) => result.status).join(' '));
  }

  section('2. comments keep their author, project, record and time');
  const before = Date.now();
  const onProject = await post(alice.token, `/api/partner/projects/${farm}/discussion`, { subjectType: 'project', body: 'ZZTEST When will the paddock be ready?' });
  check('a partner comments on the whole project', onProject.status === 201 && onProject.body.subjectType === 'project' && onProject.body.needsReply === true, onProject.body);
  const row = (await pool.query('SELECT * FROM partner_comments WHERE id = $1', [onProject.body.id])).rows[0];
  check('  stored with its author, project and time', row.author_id === alice.id && row.author_name === 'ZZTEST zz-disc-alice'
    && row.project_id === farm && row.author_role === 'partner' && new Date(row.created_at).getTime() >= before - 5000, row);
  const onMonth = await post(alice.token, `/api/partner/projects/${farm}/discussion`, { subjectType: 'plan', subjectId: String(planId), body: 'ZZTEST Is the fence in this month’s budget?' });
  check('on one of its months', onMonth.status === 201 && onMonth.body.subjectType === 'plan' && onMonth.body.subjectTitle === MONTH, onMonth.body);
  const onActivity = await post(alice.token, `/api/partner/projects/${farm}/discussion`, { subjectType: 'activity', subjectId: farmWork, body: 'ZZTEST Is the tank leaking still?' });
  check('and on one of its activities', onActivity.status === 201 && onActivity.body.subjectId === farmWork && onActivity.body.subjectTitle === 'ZZTEST Repair the water tank', onActivity.body);
  const foreign = await post(alice.token, `/api/partner/projects/${farm}/discussion`, { subjectType: 'activity', subjectId: otherWork, body: 'ZZTEST another project’s record' });
  check('a record of another project cannot be named', foreign.status === 404, foreign.status);
  const empty = await post(alice.token, `/api/partner/projects/${farm}/discussion`, { body: '   ' });
  const odd = await post(alice.token, `/api/partner/projects/${farm}/discussion`, { subjectType: 'operation', body: 'ZZTEST' });
  check('an empty comment and an unknown subject are refused', empty.status === 400 && odd.status === 400, `${empty.status} ${odd.status}`);

  section('3. colleagues share a conversation; other organisations do not');
  const bobReads = await get(bob.token, `/api/partner/projects/${farm}/discussion`);
  check('a colleague from the same organisation reads it (case and spaces ignored)', bobReads.status === 200 && bobReads.body.threads.some((thread) => thread.id === onProject.body.id), bobReads.body.threads?.length);
  const bobReplies = await post(bob.token, `/api/partner/projects/${farm}/discussion/${onProject.body.id}/replies`, { body: 'ZZTEST We would like to know too.' });
  check('  and takes part', bobReplies.status === 201 && bobReplies.body.messages.length === 2 && bobReplies.body.messages[1].authorName === 'ZZTEST zz-disc-bob', bobReplies.body);
  const carolReads = await get(carol.token, `/api/partner/projects/${farm}/discussion`);
  check('a partner from another organisation on the same project does not see it', carolReads.status === 200 && carolReads.body.threads.length === 0, carolReads.body.threads);
  const carolReplies = await post(carol.token, `/api/partner/projects/${farm}/discussion/${onProject.body.id}/replies`, { body: 'ZZTEST reading over a shoulder' });
  check('  and cannot write into it', carolReplies.status === 404, carolReplies.status);
  const carolOwn = await post(carol.token, `/api/partner/projects/${farm}/discussion`, { body: 'ZZTEST The lender’s own question.' });
  const aliceAfter = await get(alice.token, `/api/partner/projects/${farm}/discussion`);
  check('  and her own question stays hers', carolOwn.status === 201 && !aliceAfter.body.threads.some((thread) => thread.id === carolOwn.body.id), aliceAfter.body.threads.map((thread) => thread.id));
  const daveReads = await get(dave.token, `/api/partner/projects/${farm}/discussion`);
  check('a partner with no organisation recorded shares with nobody', daveReads.status === 200 && daveReads.body.threads.length === 0, daveReads.body.threads);
  const bobAgri = await get(bob.token, `/api/partner/projects/${agri}/discussion`);
  check('a partner of another project does not', bobAgri.status === 404, bobAgri.status);
  const wrongDoor = await post(bob.token, `/api/partner/projects/${farm}/discussion/${onProject.body.id + 999999}/replies`, { body: 'ZZTEST' });
  check('  nor can a thread id be guessed', wrongDoor.status === 404, wrongDoor.status);

  section('4. who is told');
  const managerNotices = await notices(manager.id, 'project_comment');
  check('the project’s manager is told of each comment, once', managerNotices.length === 5, managerNotices.length);
  check('  with the project’s name', managerNotices.every((notice) => notice.params.project === 'ZZTEST Discussion farm'), managerNotices.map((notice) => notice.params));
  const directorNotices = (await notices(directorId, 'partner_comment')).filter((notice) => [alice.id, bob.id, carol.id].includes(notice.actor_id));
  check('the Director is told too', directorNotices.length === 5, directorNotices.length);
  check('a manager of another operation is not', (await notices(miner.id, 'project_comment')).length === 0);

  section('5. inside: who reads, who answers');
  const managerInbox = await get(manager.token, '/api/project-discussions');
  check('the project’s manager reads the discussion and may answer', managerInbox.status === 200 && managerInbox.body.canAnswer === true
    && managerInbox.body.threads.length === 4 && managerInbox.body.waiting === 4, managerInbox.body);
  const answer = await post(manager.token, `/api/project-discussions/${onProject.body.id}/replies`, { body: 'ZZTEST By the end of May.' });
  check('  answers', answer.status === 201 && answer.body.messages.at(-1).authorRole === 'manager' && answer.body.needsReply === false, answer.body);
  check('  and the partners in that conversation are told, once each -- nobody else',
    (await notices(alice.id, 'partner_reply')).length === 1 && (await notices(bob.id, 'partner_reply')).length === 1
    && (await notices(carol.id, 'partner_reply')).length === 0);
  const resolved = await post(manager.token, `/api/project-discussions/${onProject.body.id}/resolve`, { resolved: true });
  check('  and marks it answered, by name', resolved.status === 200 && resolved.body.resolvedAt && resolved.body.resolvedByName === 'ZZTEST Farm Project Manager', resolved.body);
  const again = await post(alice.token, `/api/partner/projects/${farm}/discussion/${onProject.body.id}/replies`, { body: 'ZZTEST And the gate?' });
  check('a partner writing again opens it again', again.status === 201 && again.body.resolvedAt === null && again.body.needsReply === true, again.body);
  const directorInbox = await get(director, `/api/project-discussions?project=${farm}`);
  const directorAnswer = await post(director, `/api/project-discussions/${onMonth.body.id}/replies`, { body: 'ZZTEST Yes, it is.' });
  check('the Director reads and answers', directorInbox.status === 200 && directorAnswer.status === 201 && directorAnswer.body.messages.at(-1).authorRole === 'super-admin', directorAnswer.body);
  const gmInbox = await get(general.token, '/api/project-discussions');
  const gmAnswer = await post(general.token, `/api/project-discussions/${onActivity.body.id}/replies`, { body: 'ZZTEST' });
  check('the General Manager reads but does not answer', gmInbox.status === 200 && gmInbox.body.canAnswer === false && gmAnswer.status === 403, `${gmInbox.status} ${gmAnswer.status}`);
  const minerInbox = await get(miner.token, '/api/project-discussions');
  const minerAnswer = await post(miner.token, `/api/project-discussions/${onActivity.body.id}/replies`, { body: 'ZZTEST' });
  const minerFilter = await get(miner.token, `/api/project-discussions?project=${farm}`);
  check('a manager of another operation reads none of it and answers nothing',
    minerInbox.status === 200 && !minerInbox.body.threads.some((thread) => thread.projectId === farm) && minerAnswer.status === 404 && minerFilter.status === 404,
    `${minerInbox.body.threads?.length} ${minerAnswer.status} ${minerFilter.status}`);
  const staffInbox = await get(staff.token, '/api/project-discussions');
  const partnerInbox = await get(alice.token, '/api/project-discussions');
  check('a team member and a partner cannot reach the inside', staffInbox.status === 403 && partnerInbox.status === 403, `${staffInbox.status} ${partnerInbox.status}`);

  section('6. private messages to the Director stay apart');
  const oldReply = await post(alice.token, `/api/partner/comments/${onProject.body.id}/replies`, { body: 'ZZTEST through the old door' });
  check('a project thread cannot be answered through the old message door', oldReply.status === 404, oldReply.status);
  const directorMessages = await get(director, '/api/partner-comments');
  check('the Director’s private inbox does not list project discussions',
    directorMessages.status === 200 && !directorMessages.body.threads.some((thread) => thread.id === onProject.body.id), directorMessages.status);
  const directorOldReply = await post(director, `/api/partner-comments/${onProject.body.id}/replies`, { body: 'ZZTEST' });
  check('  nor answers them', directorOldReply.status === 404, directorOldReply.status);
  const myMessages = await get(alice.token, '/api/partner/comments');
  check('a partner’s private messages do not list them either', !myMessages.body.some((thread) => thread.id === onProject.body.id), myMessages.body.length);

  section('7. documents');
  const files = await get(alice.token, `/api/partner/projects/${farm}/files`);
  check('the project’s documents are listed', files.body.some((file) => file.id === farmFile && file.source === 'activity' && file.recordTitle === 'ZZTEST Repair the water tank'), files.body);
  check('  and none from another project', !files.body.some((file) => file.id === otherFile), files.body.length);
  const download = await get(alice.token, `/api/partner/projects/${farm}/files/activity/${farmFile}`);
  check('a document downloads', download.status === 200 && download.body.toString() === 'ZZTEST zztest-tank-receipt.txt', `${download.status}`);
  const smuggled = await get(alice.token, `/api/partner/projects/${farm}/files/activity/${otherFile}`);
  const unshared = await get(alice.token, `/api/partner/projects/${SECOND}/files/activity/${otherFile}`);
  const badSource = await get(alice.token, `/api/partner/projects/${farm}/files/nothing/${farmFile}`);
  check('another project’s file cannot be fetched by its id, whatever the address', [smuggled, unshared, badSource].every((result) => result.status === 404),
    [smuggled, unshared, badSource].map((result) => result.status).join(' '));
  const internalFile = await get(alice.token, `/api/activities/${farmWork}/evidence/${farmFile}/file`);
  check('  and the internal file route stays closed to partners', internalFile.status === 403, internalFile.status);

  section('8. no administration, and the share closes everything');
  const attempts = await Promise.all([
    call(alice.token, 'POST', '/api/users', { username: 'zz-disc-x', name: 'X', role: 'manager', sector: 'farming', password: 'abcdefgh1' }),
    call(alice.token, 'PUT', `/api/partners/${alice.id}/projects`, { projectIds: [farm, SECOND] }),
    call(alice.token, 'PATCH', `/api/monthly-plans/${planId}`, { approvedBudget: 999 }),
    call(alice.token, 'DELETE', `/api/activities/${farmWork}`),
    call(alice.token, 'POST', `/api/project-discussions/${onProject.body.id}/resolve`, { resolved: true })
  ]);
  check('a partner changes no account, share, plan or record', attempts.every((result) => result.status === 403), attempts.map((result) => result.status).join(' '));
  const internal = await get(manager.token, `/api/monthly-plans/${planId}`);
  check('internal roles still work: the manager opens their month', internal.status === 200, internal.status);
  await call(director, 'PUT', `/api/partners/${alice.id}/projects`, { projectIds: [agri] });
  const afterRevoke = await Promise.all([
    get(alice.token, `/api/partner/projects/${farm}/discussion`),
    post(alice.token, `/api/partner/projects/${farm}/discussion/${onProject.body.id}/replies`, { body: 'ZZTEST after the share' }),
    get(alice.token, `/api/partner/projects/${farm}/files/activity/${farmFile}`)
  ]);
  check('taking the share away closes the discussion and the documents at once', afterRevoke.every((result) => result.status === 404),
    afterRevoke.map((result) => result.status).join(' '));
} catch (error) {
  failed += 1;
  console.log(`  FAIL  the suite stopped: ${error.stack || error.message}`);
} finally {
  const ids = created.users;
  await pool.query("DELETE FROM partner_comments WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'ZZTEST Discussion%' OR id = $1) OR partner_id = ANY($2::int[])", [SECOND, ids]);
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::int[]) OR actor_id = ANY($1::int[])', [ids]);
  for (const stored of created.files) await deleteFile('activities', stored).catch(() => {});
  await pool.query('DELETE FROM activity_evidence WHERE activity_id = ANY($1::varchar[])', [created.activities]);
  await pool.query('DELETE FROM activities WHERE id = ANY($1::varchar[])', [created.activities]);
  if (planId) await pool.query('DELETE FROM monthly_plans WHERE id = $1', [planId]);
  await pool.query('DELETE FROM partner_projects WHERE partner_id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM partner_operations WHERE partner_id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM organization_history WHERE subject_user_id = ANY($1::int[]) OR actor_id = ANY($1::int[])', [ids]);
  for (const sector of ['farming', 'agriculture', 'mining']) await removeProject(sector);
  await pool.query('UPDATE monthly_plans SET project_id = NULL WHERE project_id = $1', [SECOND]);
  await pool.query('DELETE FROM projects WHERE id = $1', [SECOND]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
