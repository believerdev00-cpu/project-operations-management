// An invitation: a one-time link that lets a new account choose its own
// password, so no password the Director typed ever travels by email.
//
// The link carries 32 random bytes; only their SHA-256 is stored, so a copy of
// the database (or a backup) cannot be turned into a working link. A new
// invitation replaces any unused one for the same account, a used one never
// works twice, and every link stops working after INVITATION_DAYS. Accepting
// is in server/index.js (/api/auth/invitation/:token), outside authMiddleware
// because the invited person has no session yet.

import crypto from 'node:crypto';
import { fill, knownLanguage, translate } from '../../shared/strings.js';
import { escapeHtml, sendEmail } from './email.js';

export const INVITATION_DAYS = 7;

export const invitationHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// A token is 43 base64url characters; anything else is not worth a query.
export const looksLikeToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

// Run inside the caller's transaction (or on the pool): drops the account's
// unused invitations and writes a new one. Answers the token, which exists only
// in this response and the email -- never in the database.
export async function createInvitation(db, userId, createdBy) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query('DELETE FROM account_invitations WHERE user_id = $1 AND used_at IS NULL', [userId]);
  const row = await db.query(
    `INSERT INTO account_invitations (user_id, token_hash, expires_at, created_by)
     VALUES ($1, $2, NOW() + make_interval(days => $3), $4) RETURNING expires_at`,
    [userId, invitationHash(token), INVITATION_DAYS, createdBy]
  );
  return { token, expiresAt: row.rows[0].expires_at };
}

// Where the link points: APP_URL when it is set (the address people know),
// else the address the Director's own request came in on.
export function invitationLink(req, token) {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/#/invite/${token}`;
}

// The invitation email, in the Director's language, sent once the account is
// committed. Answers { emailed, link }: the link goes back to the Director's
// screen only when the email did not go, so they can pass it on themselves.
export async function sendInvitation(db, req, partner, language) {
  const lang = knownLanguage(language);
  const { token, expiresAt } = await createInvitation(db, partner.id, req.user.id);
  const link = invitationLink(req, token);
  const values = { name: partner.name, director: req.user.name, username: partner.username, link, days: INVITATION_DAYS };
  const subject = fill(translate(lang, 'email.invite.subject'), values);
  const text = fill(translate(lang, 'email.invite.body'), values);
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d2b3a;max-width:560px">
<p>${escapeHtml(text.split(link)[0]).replace(/\n/g, '<br>')}</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#1565c0;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escapeHtml(translate(lang, 'email.invite.button'))}</a></p>
<p>${escapeHtml(text.split(link)[1] || '').replace(/\n/g, '<br>')}</p>
</div>`;
  const result = await sendEmail({ to: partner.email, subject, text, html });
  if (result.sent) await db.query('UPDATE account_invitations SET emailed_at = NOW() WHERE token_hash = $1', [invitationHash(token)]);
  return { emailed: result.sent, email: partner.email, expiresAt, link: result.sent ? null : link };
}
