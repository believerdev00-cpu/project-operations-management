// End-to-end check of External Business Partner access against the running API.
//
// Creates one partner per business operation through the Director's own
// endpoint, then tries, from each partner's session, to reach the other three
// operations and every internal surface in the system. Everything it creates is
// removed at the end.

import bcrypt from 'bcryptjs';
import { pool } from '../server/db/database.js';
import { BUSINESS_OPERATIONS } from '../shared/businessOperations.js';
import { directorSession } from './director.mjs';
const API = process.env.API || 'http://localhost:5000';
// What each invited partner changes the Director's temporary password to at
// their first sign-in.
const PARTNER_OWN_PASSWORD = 'partner-own-pass-456';

let passed = 0;
let failed = 0;
const created = { users: [], activities: [] };

const check = (label, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`); }
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

async function login(username, password) {
  const { status, body } = await api(null, '/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password })
  });
  if (status !== 200) throw new Error(`login ${username} failed: ${status} ${body.message}`);
  return body.token;
}

async function cleanup() {
  for (const id of created.activities) await pool.query('DELETE FROM activities WHERE id = $1', [id]);
  for (const id of created.users) {
    await pool.query(
      `UPDATE activities SET created_by = NULL, assigned_to = NULL, approval_required_from = NULL,
       approved_by = NULL, reviewed_by = NULL
       WHERE created_by = $1 OR assigned_to = $1 OR approval_required_from = $1 OR approved_by = $1 OR reviewed_by = $1`,
      [id]
    );
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
}

// Every internal surface a partner might try to reach. None may answer.
const INTERNAL_ENDPOINTS = [
  ['GET', '/api/summary'],
  ['GET', '/api/projects'],
  ['GET', '/api/activities?limit=100'],
  ['GET', '/api/approvals'],
  ['GET', '/api/managers'],
  ['GET', '/api/users'],
  ['GET', '/api/approval-queue'],
  ['GET', '/api/partners'],
  ['GET', '/api/movements'],
  ['GET', '/api/movements/summary'],
  ['GET', '/api/rates'],
  ['GET', '/api/reports/activities?period=monthly'],
  ['POST', '/api/activities'],
  ['POST', '/api/projects'],
  ['POST', '/api/users'],
  ['POST', '/api/partners'],
  ['DELETE', '/api/activities/ACT-1']
];

try {
  section('setup');
  const { token: adminToken } = await directorSession();
  const directorId = (await pool.query("SELECT id FROM users WHERE role='super-admin' ORDER BY id LIMIT 1")).rows[0].id;

  // A manager in Mining, so a Mining activity can be raised, approved and then
  // checked for through a Mining partner's eyes.
  const miningManager = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, sector)
     VALUES ('zz-test-mining-mgr', $1, 'Test Mining Manager', 'manager', 'mining') RETURNING id`,
    [bcrypt.hashSync('test-pass-123', 10)]
  );
  created.users.push(miningManager.rows[0].id);
  const miningToken = await login('zz-test-mining-mgr', 'test-pass-123');
  console.log(`  director #${directorId}, mining manager #${miningManager.rows[0].id}`);

  // ---- 1. the four business operations -------------------------------------
  section('The four business operations');
  const sectorList = (await api(adminToken, '/api/sectors')).body;
  const names = sectorList.map((operation) => operation.name);
  check('exactly four business operations exist', sectorList.length === 4, String(sectorList.length));
  check('they are Mining, Agriculture, Farming, Movement & Facilitation',
    ['Mining', 'Agriculture', 'Farming', 'Movement & Facilitation'].every((name) => names.includes(name)),
    names.join(' | '));
  check('no generic placeholder names',
    !names.some((name) => /sector\s*\d|project sector|^sector$/i.test(name)), names.join(' | '));
  check('every operation carries all four translations',
    sectorList.every((operation) => ['en', 'rw', 'fr', 'sw'].every((code) => operation.translations?.[code])),
    JSON.stringify(sectorList.map((o) => Object.keys(o.translations || {}))));
  for (const operation of BUSINESS_OPERATIONS) {
    const served = sectorList.find((item) => item.id === operation.id);
    check(`  ${operation.name}: translations rw/fr/sw differ from the id`,
      served && ['rw', 'fr', 'sw'].every((code) => served.translations[code] && served.translations[code] !== operation.id));
  }

  // ---- 2. the Director invites one partner per operation -------------------
  section('Admin invites an external partner per business operation');
  const partners = {};
  for (const operation of BUSINESS_OPERATIONS) {
    const result = await api(adminToken, '/api/partners', {
      method: 'POST',
      body: JSON.stringify({
        name: `Test Partner ${operation.name}`,
        email: `zz-${operation.id}@example.test`,
        username: `zz-partner-${operation.id}`,
        password: 'test-pass-123',
        operation: operation.id
      })
    });
    check(`invite a ${operation.name} partner`, result.status === 201, JSON.stringify(result.body).slice(0, 160));
    if (result.status === 201) {
      created.users.push(result.body.id);
      // The Director's password is temporary: until the partner chooses their
      // own, their session reaches nothing but the password route.
      const firstToken = await login(`zz-partner-${operation.id}`, 'test-pass-123');
      const blocked = await api(firstToken, '/api/partner/overview');
      check('  blocked until they choose their own password', blocked.status === 403 && blocked.body.code === 'PASSWORD_CHANGE_REQUIRED',
        `${blocked.status} ${blocked.body.code}`);
      const chosen = await api(firstToken, '/api/auth/password', {
        method: 'POST', body: JSON.stringify({ currentPassword: 'test-pass-123', newPassword: PARTNER_OWN_PASSWORD })
      });
      check('  chooses their own password', chosen.status === 200 && Boolean(chosen.body.token), `${chosen.status} ${chosen.body.message}`);
      partners[operation.id] = { ...result.body, token: chosen.body.token };
      check(`  assigned to ${operation.name}`, result.body.operation === operation.id, result.body.operation);
      check('  access level is view-only', result.body.accessLevel === 'view-only', result.body.accessLevel);
      check('  status is active', result.body.status === 'active', result.body.status);
    }
  }

  const rejectedLevel = await api(adminToken, '/api/partners', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Test Escalated', email: 'zz-esc@example.test', username: 'zz-partner-esc',
      password: 'test-pass-123', operation: 'mining', accessLevel: 'internal'
    })
  });
  check('a partner cannot be created with internal access', rejectedLevel.status === 400,
    `${rejectedLevel.status} ${rejectedLevel.body.message}`);

  // ---- 3. a partner sees their own operation -------------------------------
  section('A partner sees their own business operation');
  const mining = partners.mining;
  const overview = await api(mining.token, '/api/partner/overview');
  check('the Mining partner can read their overview', overview.status === 200, JSON.stringify(overview.body).slice(0, 160));
  check('the overview names their operation', overview.body.operation?.id === 'mining', overview.body.operation?.id);
  check('the overview is view-only', overview.body.accessLevel === 'view-only', overview.body.accessLevel);
  for (const path of ['/api/partner/activities', '/api/partner/movements', '/api/partner/updates']) {
    const result = await api(mining.token, path);
    check(`  ${path} answers`, result.status === 200, `${result.status} ${result.body.message}`);
  }
  const report = await api(mining.token, '/api/partner/report');
  check('  /api/partner/report answers', report.status === 200 && report.body.operation === 'mining',
    `${report.status} ${report.body.operation}`);

  // ---- 4. THE TEST: one operation cannot reach the other three -------------
  section('A partner cannot reach the other three business operations');
  for (const [id, partner] of Object.entries(partners)) {
    const others = BUSINESS_OPERATIONS.filter((operation) => operation.id !== id).map((operation) => operation.id);

    // Their own data must only ever be their own operation.
    const activities = await api(partner.token, '/api/partner/activities?limit=200');
    check(`${partner.operationName}: every activity returned is theirs`,
      activities.status === 200 && activities.body.every((item) => item.operation === id),
      [...new Set((activities.body || []).map((item) => item.operation))].join(','));
    const movements = await api(partner.token, '/api/partner/movements?limit=200');
    check(`${partner.operationName}: every movement returned is theirs`,
      movements.status === 200 && movements.body.every((item) => item.operation === id),
      [...new Set((movements.body || []).map((item) => item.operation))].join(','));

    // Asking for another operation by every parameter name that exists in the
    // internal API must not widen anything.
    for (const other of others) {
      for (const param of ['operation', 'sector', 'department', 'relatedArea']) {
        const attempt = await api(partner.token, `/api/partner/activities?${param}=${other}&limit=200`);
        const leaked = attempt.status === 200 && attempt.body.some((item) => item.operation !== id);
        check(`  ${id} asking ?${param}=${other} leaks nothing`, !leaked,
          leaked ? [...new Set(attempt.body.map((i) => i.operation))].join(',') : '');
      }
    }
  }

  // ---- 5. no internal surface at all ---------------------------------------
  section('A partner cannot reach any internal surface');
  for (const [method, path] of INTERNAL_ENDPOINTS) {
    const result = await api(mining.token, path, {
      method, ...(method === 'POST' ? { body: JSON.stringify({}) } : {})
    });
    check(`${method} ${path} is refused`, result.status === 403, `${result.status} ${result.body.message}`);
  }
  // And no approval authority anywhere.
  const approveAttempt = await api(mining.token, '/api/activities/ACT-1/approval', {
    method: 'PATCH', body: JSON.stringify({ action: 'approve' })
  });
  check('a partner cannot approve anything', approveAttempt.status === 403,
    `${approveAttempt.status} ${approveAttempt.body.message}`);

  // ---- 6. only approved, released records reach a partner ------------------
  section('Only approved records the Director has released reach a partner');
  const before = (await api(mining.token, '/api/partner/activities?limit=200')).body.length;

  const raised = await api(miningToken, '/api/activities', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'PRJ-MINING', sector: 'mining', category: 'Extraction',
      activity: 'TEST Mining partner visibility', description: 'Automated test record.',
      quantity: 1, costUsd: 200, costRwf: 290000, costCdf: 570000
    })
  });
  check('a Mining activity was raised', raised.status === 201, JSON.stringify(raised.body).slice(0, 160));
  created.activities.push(raised.body.id);

  const whilePending = (await api(mining.token, '/api/partner/activities?limit=200')).body;
  check('a pending activity is NOT visible to the partner',
    !whilePending.some((item) => item.id === raised.body.id));

  await api(adminToken, `/api/activities/${raised.body.id}/approval`, {
    method: 'PATCH', body: JSON.stringify({ action: 'approve' })
  });
  const afterApproval = (await api(mining.token, '/api/partner/activities?limit=200')).body;
  check('once approved it IS visible to the partner',
    afterApproval.some((item) => item.id === raised.body.id));
  check('the count went up by exactly one', afterApproval.length === before + 1, `${before} -> ${afterApproval.length}`);

  // It is still invisible to the other three operations.
  for (const other of ['farming', 'agriculture', 'movement']) {
    const theirs = (await api(partners[other].token, '/api/partner/activities?limit=200')).body;
    check(`  still invisible to the ${partners[other].operationName} partner`,
      !theirs.some((item) => item.id === raised.body.id));
  }

  // The Director hides it again.
  const hidden = await api(adminToken, `/api/activities/${raised.body.id}/visibility`, {
    method: 'PATCH', body: JSON.stringify({ externallyVisible: false })
  });
  check('the Director can hide an approved record', hidden.status === 200 && hidden.body.externallyVisible === false,
    `${hidden.status} ${hidden.body.externallyVisible}`);
  const afterHide = (await api(mining.token, '/api/partner/activities?limit=200')).body;
  check('a hidden record leaves the partner\'s view',
    !afterHide.some((item) => item.id === raised.body.id));

  // A partner cannot flip that switch back.
  const selfPublish = await api(mining.token, `/api/activities/${raised.body.id}/visibility`, {
    method: 'PATCH', body: JSON.stringify({ externallyVisible: true })
  });
  check('a partner cannot make a record visible to themselves', selfPublish.status === 403,
    `${selfPublish.status} ${selfPublish.body.message}`);

  // ---- 7. no internal detail leaks in what they do see ---------------------
  section('Internal detail never leaves the organisation');
  await api(adminToken, `/api/activities/${raised.body.id}/visibility`, {
    method: 'PATCH', body: JSON.stringify({ externallyVisible: true })
  });
  const visible = (await api(mining.token, '/api/partner/activities?limit=200')).body
    .find((item) => item.id === raised.body.id);
  const forbiddenFields = [
    'adminNote', 'rejectionReason', 'createdBy', 'createdByName', 'approvedBy', 'approvedByName',
    'approvalRequiredFrom', 'approvalRequiredFromName', 'reviewedBy', 'reviewedByName',
    'requestedBudget', 'evidenceCount', 'instructions', 'assignedTo', 'assignedToName'
  ];
  for (const field of forbiddenFields) {
    check(`  '${field}' is not sent to a partner`, visible && !(field in visible));
  }
  check('  the approved budget IS sent (it is approved information)', visible && 'approvedBudget' in visible);

  // ---- 8. the Director changes and revokes access --------------------------
  section('Admin manages partner access');
  const moved = await api(adminToken, `/api/partners/${partners.farming.id}/operation`, {
    method: 'PATCH', body: JSON.stringify({ operation: 'mining' })
  });
  check('the Director can change a partner\'s business operation', moved.status === 200 && moved.body.operation === 'mining',
    `${moved.status} ${moved.body.operation}`);
  const movedOverview = await api(partners.farming.token, '/api/partner/overview');
  check('that partner now reads Mining, on their existing session',
    movedOverview.body.operation?.id === 'mining', movedOverview.body.operation?.id);
  await api(adminToken, `/api/partners/${partners.farming.id}/operation`, {
    method: 'PATCH', body: JSON.stringify({ operation: 'farming' })
  });

  const badOperation = await api(adminToken, `/api/partners/${partners.farming.id}/operation`, {
    method: 'PATCH', body: JSON.stringify({ operation: 'construction' })
  });
  check('an operation outside the four is refused', badOperation.status === 400,
    `${badOperation.status} ${badOperation.body.message}`);

  const suspended = await api(adminToken, `/api/partners/${partners.agriculture.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'suspended' })
  });
  check('the Director can suspend a partner', suspended.status === 200 && suspended.body.status === 'suspended',
    `${suspended.status} ${suspended.body.status}`);
  const suspendedRead = await api(partners.agriculture.token, '/api/partner/overview');
  check('a suspended partner is refused on their existing token', suspendedRead.status === 403,
    `${suspendedRead.status} ${suspendedRead.body.message}`);
  const suspendedLogin = await api(null, '/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'zz-partner-agriculture', password: PARTNER_OWN_PASSWORD })
  });
  check('a suspended partner cannot sign in again', suspendedLogin.status === 403,
    `${suspendedLogin.status} ${suspendedLogin.body.message}`);

  await api(adminToken, `/api/partners/${partners.agriculture.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'active' })
  });
  const restored = await api(partners.agriculture.token, '/api/partner/overview');
  check('restoring brings the access back', restored.status === 200, String(restored.status));

  const revoked = await api(adminToken, `/api/partners/${partners.movement.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'revoked' })
  });
  check('the Director can revoke a partner', revoked.status === 200 && revoked.body.status === 'revoked',
    `${revoked.status} ${revoked.body.status}`);
  const revokedRead = await api(partners.movement.token, '/api/partner/overview');
  check('a revoked partner is refused', revokedRead.status === 403, String(revokedRead.status));

  const partnerList = await api(adminToken, '/api/partners');
  check('the Director can list every partner', partnerList.status === 200 && partnerList.body.total >= 4,
    String(partnerList.body.total));
  check('the list counts them per business operation',
    partnerList.body.byOperation && Object.keys(partnerList.body.byOperation).length >= 1,
    JSON.stringify(partnerList.body.byOperation));

  // A manager must not reach the partner-management surface either.
  const managerAttempt = await api(miningToken, '/api/partners');
  check('a manager cannot manage partner access', managerAttempt.status === 403,
    `${managerAttempt.status} ${managerAttempt.body.message}`);

  // ---- 9. nothing internal broke -------------------------------------------
  section('Internal functionality still works');
  for (const [label, path] of [
    ['summary', '/api/summary'], ['projects', '/api/projects'], ['activities', '/api/activities?limit=50'],
    ['approval queue', '/api/approval-queue'], ['movements', '/api/movements'], ['users', '/api/users'],
    ['sectors', '/api/sectors']
  ]) {
    const result = await api(adminToken, path);
    check(`the Director can still read ${label}`, result.status === 200, String(result.status));
  }
  const managerRegister = await api(miningToken, '/api/activities?limit=100');
  check('a manager still reads only their own operation',
    managerRegister.status === 200 && managerRegister.body.every((item) => item.sector === 'mining'));
} catch (error) {
  failed += 1;
  console.error('\nUNCAUGHT:', error.message, '\n', error.stack);
} finally {
  section('cleanup');
  await cleanup();
  console.log(`  removed ${created.activities.length} activities, ${created.users.length} accounts`);
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
