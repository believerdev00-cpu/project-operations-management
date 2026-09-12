import jwt from 'jsonwebtoken';
import { pool } from '../db/database.js';

export const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error('JWT_SECRET is required. Configure it before starting the API.');
}

// The only paths an external business partner may reach. Everything else in the
// API is refused to them here, before any route handler runs.
//
// This is an allowlist rather than a blocklist on purpose: a route added later
// is out of a partner's reach by default, and becomes reachable only when
// somebody deliberately writes it into this list. A blocklist would silently
// expose every new endpoint.
//
// The partner router itself is read-only, so this also means a partner has no
// path to any write anywhere in the system.
const PARTNER_ALLOWED_PATHS = [
  /^\/api\/partner(\/|$)/,
  /^\/api\/auth\/session$/,
  /^\/api\/sectors$/,
  /^\/api\/health$/
];

function partnerMayReach(originalUrl) {
  const path = String(originalUrl || '').split('?')[0];
  return PARTNER_ALLOWED_PATHS.some((allowed) => allowed.test(path));
}

// Evidence files are opened by the browser through a plain URL, which cannot
// carry an Authorization header, so those two read-only routes -- and only
// those -- accept the token as a query parameter. Honouring ?token= everywhere
// turned any copied evidence link, or a URL sitting in a proxy log, into a
// bearer token for every write route in the API.
const QUERY_TOKEN_PATH = /^\/api\/(activities|movements)\/[^/]+\/evidence\/[^/]+\/file$/;

function queryTokenAllowed(req) {
  const path = String(req.originalUrl || '').split('?')[0];
  return req.method === 'GET' && QUERY_TOKEN_PATH.test(path);
}

export async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const queryToken = typeof req.query.token === 'string' && queryTokenAllowed(req) ? req.query.token : null;
  const token = headerToken || queryToken;

  // Every refusal here carries a code as well as a sentence, so the browser can
  // explain it in the reader's own language rather than show the English.
  if (!token) {
    return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Authentication required.' });
  }

  let claims;
  try {
    claims = jwt.verify(token, jwtSecret);
  } catch (error) {
    return res.status(401).json({ code: 'TOKEN_INVALID', message: 'Token is invalid or expired.' });
  }

  // The token carries a snapshot up to 12h old. Role and sector decide what the
  // request may touch, so read them back rather than trusting the claims: a
  // reassigned manager loses the old sector immediately, a deleted one loses access.
  try {
    const result = await pool.query(
      'SELECT id, username, name, role, sector, email, status, access_level, covers_all_sectors, password_changed_at FROM users WHERE id = $1',
      [claims.id]
    );
    if (!result.rowCount) {
      return res.status(401).json({ code: 'ACCOUNT_GONE', message: 'Account no longer exists.' });
    }
    // Suspend and revoke take effect on the very next request rather than when
    // the token happens to expire, because the status is read from the row here
    // rather than trusted from the twelve-hour-old claims.
    const accountStatus = result.rows[0].status || 'active';
    if (accountStatus !== 'active') {
      // Coded, so the browser can tell "this account may no longer sign in" --
      // which ends the session -- from an ordinary 403 on one action.
      return res.status(403).json({
        code: 'ACCOUNT_INACTIVE',
        status: accountStatus,
        message: accountStatus === 'suspended'
          ? 'This account is suspended. Contact the administrator.'
          : 'Access to this account has been revoked.'
      });
    }
    // A token minted before the password was reset must not survive the reset.
    // `iat` is whole seconds while the reset carries milliseconds, so the two
    // are compared at the second the reset falls in, rounded up: flooring it
    // let a token issued earlier in that same second outlive the reset for the
    // next twelve hours. The cost is that a sign-in during the very second of
    // the reset is refused, and the user simply signs in again.
    const changedAt = result.rows[0].password_changed_at;
    if (changedAt && claims.iat && claims.iat < Math.ceil(new Date(changedAt).getTime() / 1000)) {
      return res.status(401).json({ code: 'PASSWORD_CHANGED', message: 'Your password was changed. Sign in again.' });
    }
    const {
      password_changed_at: _ignored,
      access_level: accessLevel,
      covers_all_sectors: coversAllSectors,
      ...rest
    } = result.rows[0];
    // Read back from the row rather than the claims, for the same reason role and
    // sector are: revoking the flag has to bite on the next request, not in
    // twelve hours when the token expires.
    const user = { ...rest, accessLevel: accessLevel || 'internal', coversAllSectors: Boolean(coversAllSectors) };

    // An external partner reaches their own read-only surface and nothing else.
    // Checked here, in front of every authenticated route, so no individual
    // handler has to remember to do it and none can forget.
    if (user.role === 'partner' && !partnerMayReach(req.originalUrl)) {
      return res.status(403).json({
        message: 'External partner access is limited to your assigned business operation.'
      });
    }
    // An account with no operation cannot be scoped to one, so it would read
    // either nothing or everything depending on the query. Refuse instead.
    if (user.role === 'partner' && !user.sector) {
      return res.status(403).json({ message: 'This partner account has no business operation assigned.' });
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}
