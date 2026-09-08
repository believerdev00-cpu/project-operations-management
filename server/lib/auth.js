import jwt from 'jsonwebtoken';
import { pool } from '../db/database.js';

export const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error('JWT_SECRET is required. Configure it before starting the API.');
}

export async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  // Evidence files are opened by the browser through a plain URL, which cannot
  // carry an Authorization header, so those routes pass the token as a query
  // parameter instead. Everything else keeps using the header.
  const token = headerToken || (typeof req.query.token === 'string' ? req.query.token : null);

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  let claims;
  try {
    claims = jwt.verify(token, jwtSecret);
  } catch (error) {
    return res.status(401).json({ message: 'Token is invalid or expired.' });
  }

  // The token carries a snapshot up to 12h old. Role and sector decide what the
  // request may touch, so read them back rather than trusting the claims: a
  // reassigned manager loses the old sector immediately, a deleted one loses access.
  try {
    const result = await pool.query(
      'SELECT id, username, name, role, sector, password_changed_at FROM users WHERE id = $1',
      [claims.id]
    );
    if (!result.rowCount) {
      return res.status(401).json({ message: 'Account no longer exists.' });
    }
    // A token minted before the password was reset must not survive the reset.
    // `iat` is whole seconds while the reset carries milliseconds, so the two
    // are compared at the second the reset falls in, rounded up: flooring it
    // let a token issued earlier in that same second outlive the reset for the
    // next twelve hours. The cost is that a sign-in during the very second of
    // the reset is refused, and the user simply signs in again.
    const changedAt = result.rows[0].password_changed_at;
    if (changedAt && claims.iat && claims.iat < Math.ceil(new Date(changedAt).getTime() / 1000)) {
      return res.status(401).json({ message: 'Your password was changed. Sign in again.' });
    }
    const { password_changed_at: _ignored, ...user } = result.rows[0];
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}
