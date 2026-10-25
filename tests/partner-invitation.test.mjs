// An external partner is invited by email and chooses their own password.
//
//   1. the Director adds a partner with no password; the answer says whether
//      the invitation was emailed and, when it was not (no mail service here),
//      hands back the link to pass on by hand;
//   2. the account cannot be signed into before the invitation is accepted;
//   3. the link names the partner, takes a password that meets the policy,
//      signs them straight in, and never works twice;
//   4. only the token's hash is stored;
//   5. a new invitation kills the old link; an expired link, a suspended
//      account's link and a malformed one all read as the same 410;
//   6. only the Director invites, and never a revoked partner;
//   7. the older path -- a password typed by the Director -- still works.
//
// Drives the live API against a real database. Its rows are zz-inv-* partner
// accounts and one zz-inv manager, removed in `finally`.

import crypto from 'node:crypto';
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

async function call(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const tokenOf = (link) => String(link || '').split('#/invite/')[1] || '';
const PASSWORD = 'zz-invite-chosen-1';

try {
  const director = await directorSession();

  section('1. the Director invites a partner with no password');
  const created = await call(director.token, 'POST', '/api/partners', {
    name: 'ZZTEST Invited Partner', email: 'zz-inv-one@example.com', username: 'zz-inv-one', operations: ['farming'], language: 'en'
  });
  check('the partner is created', created.status === 201, created.body);
  const sent = created.body.invitationResult || {};
  check('the answer says the email was not sent here (no mail service)', sent.emailed === false, sent);
  check('and hands back the link to pass on', /#\/invite\/[A-Za-z0-9_-]{43}$/.test(sent.link || ''), sent.link);
  check('the register shows the invitation waiting', created.body.invitation && !created.body.invitation.accepted && !created.body.invitation.expired, created.body.invitation);
  const first = tokenOf(sent.link);

  section('2. no sign-in before the invitation is accepted');
  const early = await call(null, 'POST', '/api/auth/login', { username: 'zz-inv-one', password: PASSWORD });
  check('the account refuses every password until then', early.status === 401, early.body);

  section('3. the link');
  const read = await call(null, 'GET', `/api/auth/invitation/${first}`);
  check('names the partner and their username', read.status === 200 && read.body.name === 'ZZTEST Invited Partner' && read.body.username === 'zz-inv-one', read.body);
  const weak = await call(null, 'POST', `/api/auth/invitation/${first}`, { password: 'short' });
  check('refuses a password below the policy', weak.status === 400 && weak.body.code === 'PASSWORD_WEAK', weak.body);
  const same = await call(null, 'POST', `/api/auth/invitation/${first}`, { password: 'zz-inv-one' });
  check('refuses the username as the password', same.status === 400, same.body);
  const accepted = await call(null, 'POST', `/api/auth/invitation/${first}`, { password: PASSWORD });
  check('takes a good password and signs them in', accepted.status === 200 && accepted.body.token && accepted.body.user?.role === 'partner', accepted.body);
  check('with nothing left to change', accepted.body.user?.mustChangePassword === false, accepted.body.user);
  const session = await call(accepted.body.token, 'GET', '/api/auth/session');
  check('the session it gives works', session.status === 200 && session.body.user?.username === 'zz-inv-one', session.body);
  const login = await call(null, 'POST', '/api/auth/login', { username: 'zz-inv-one', password: PASSWORD });
  check('and they can sign in with it afterwards', login.status === 200, login.body);
  const again = await call(null, 'POST', `/api/auth/invitation/${first}`, { password: 'zz-someone-else-2' });
  check('the link never works twice', again.status === 410 && again.body.code === 'INVITATION_INVALID', again.body);
  const reread = await call(null, 'GET', `/api/auth/invitation/${first}`);
  check('and no longer even names the partner', reread.status === 410, reread.body);
  const listed = await call(director.token, 'GET', '/api/partners');
  const one = (listed.body.partners || []).find((p) => p.username === 'zz-inv-one');
  check('the register shows the partner joined', one?.invitation?.accepted === true, one?.invitation);

  section('4. only the hash is stored');
  const stored = await pool.query(
    "SELECT token_hash FROM account_invitations ai JOIN users u ON u.id = ai.user_id WHERE u.username = 'zz-inv-one'");
  check('one invitation row', stored.rowCount === 1, stored.rowCount);
  check('holding the SHA-256, not the token', stored.rows[0]?.token_hash === crypto.createHash('sha256').update(first).digest('hex') && stored.rows[0]?.token_hash !== first);

  section('5. a new invitation, expiry, suspension, garbage');
  const two = await call(director.token, 'POST', '/api/partners', {
    name: 'ZZTEST Second Partner', email: 'zz-inv-two@example.com', username: 'zz-inv-two', operations: ['mining']
  });
  check('a second partner is created', two.status === 201, two.body);
  const oldLink = tokenOf(two.body.invitationResult?.link);
  const resent = await call(director.token, 'POST', `/api/partners/${two.body.id}/invite`, { language: 'fr' });
  check('the Director sends the invitation again', resent.status === 200 && resent.body.invitationResult?.link, resent.body);
  const newLink = tokenOf(resent.body.invitationResult?.link);
  check('it is a different link', newLink && newLink !== oldLink);
  check('the old link is dead', (await call(null, 'GET', `/api/auth/invitation/${oldLink}`)).status === 410);
  check('the new one works', (await call(null, 'GET', `/api/auth/invitation/${newLink}`)).status === 200);
  await pool.query("UPDATE account_invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1", [two.body.id]);
  check('an expired link reads as gone', (await call(null, 'GET', `/api/auth/invitation/${newLink}`)).status === 410);
  const expiredUse = await call(null, 'POST', `/api/auth/invitation/${newLink}`, { password: PASSWORD });
  check('and cannot set a password', expiredUse.status === 410, expiredUse.body);
  const listedTwo = (await call(director.token, 'GET', '/api/partners')).body.partners.find((p) => p.id === two.body.id);
  check('the register says it expired', listedTwo?.invitation?.expired === true, listedTwo?.invitation);
  const fresh = tokenOf((await call(director.token, 'POST', `/api/partners/${two.body.id}/invite`, {})).body.invitationResult?.link);
  await call(director.token, 'PATCH', `/api/partners/${two.body.id}/status`, { status: 'suspended' });
  check('a suspended partner\'s link reads as gone', (await call(null, 'GET', `/api/auth/invitation/${fresh}`)).status === 410);
  check('a malformed link reads as gone', (await call(null, 'GET', '/api/auth/invitation/not-a-token')).status === 410);
  check('an unknown well-formed link reads as gone', (await call(null, 'GET', `/api/auth/invitation/${crypto.randomBytes(32).toString('base64url')}`)).status === 410);

  section('6. who may invite');
  const manager = await pool.query(
    "INSERT INTO users (username, password_hash, name, role, sector) VALUES ('zz-inv-manager', $1, 'ZZTEST Inv Manager', 'manager', 'mining') RETURNING id",
    [bcrypt.hashSync('zz-inv-unused-1', 4)]);
  const managerToken = jwt.sign({ id: manager.rows[0].id }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  const byManager = await call(managerToken, 'POST', `/api/partners/${two.body.id}/invite`, {});
  check('a manager cannot send an invitation', byManager.status === 403, byManager.body);
  await call(director.token, 'PATCH', `/api/partners/${two.body.id}/status`, { status: 'revoked' });
  const toRevoked = await call(director.token, 'POST', `/api/partners/${two.body.id}/invite`, {});
  check('a revoked partner is not invited again', toRevoked.status === 409 && toRevoked.body.code === 'PARTNER_REVOKED', toRevoked.body);

  section('7. the older path still works');
  const typed = await call(director.token, 'POST', '/api/partners', {
    name: 'ZZTEST Typed Partner', email: 'zz-inv-three@example.com', username: 'zz-inv-three', password: 'zz-typed-pass-1', operations: ['agriculture']
  });
  check('a partner with a password typed by the Director is created', typed.status === 201, typed.body);
  const typedLogin = await call(null, 'POST', '/api/auth/login', { username: 'zz-inv-three', password: 'zz-typed-pass-1' });
  check('signs in with it, and must change it', typedLogin.status === 200 && typedLogin.body.user?.mustChangePassword === true, typedLogin.body);
  const tooShort = await call(director.token, 'POST', '/api/partners', {
    name: 'ZZTEST Short', email: 'zz-inv-four@example.com', username: 'zz-inv-four', password: 'short', operations: ['farming']
  });
  check('a typed password still meets the policy', tooShort.status === 400, tooShort.body);
} catch (error) {
  failed += 1;
  console.log(`  FAIL  the suite stopped: ${error.stack || error.message}`);
} finally {
  await pool.query("DELETE FROM users WHERE username LIKE 'zz-inv-%'");
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
