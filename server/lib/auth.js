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
      'SELECT id, username, name, role, sector FROM users WHERE id = $1',
      [claims.id]
    );
    if (!result.rowCount) {
      return res.status(401).json({ message: 'Account no longer exists.' });
    }
    req.user = result.rows[0];
    next();
  } catch (error) {
    next(error);
  }
}
