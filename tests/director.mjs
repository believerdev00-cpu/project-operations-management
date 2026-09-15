// A Director session for the end-to-end suites.
//
// The suites used to sign in as `admin` with ADMIN_PASSWORD from the env file.
// That stopped working the moment the Director chose their own password -- which
// the app now insists on at first sign-in -- and it kept the Director's real
// password in a file the tests depended on. Instead a short session token is
// signed here for the Director account, exactly as the API would issue one.
// authMiddleware still reads the account back from the database on every
// request, so the suites exercise the same checks a real session goes through.

import jwt from 'jsonwebtoken';
import { pool } from '../server/db/database.js';

export async function directorSession() {
  const result = await pool.query(
    "SELECT id, must_change_password FROM users WHERE role = 'super-admin' ORDER BY id LIMIT 1"
  );
  if (!result.rowCount) throw new Error('No Director account exists. Run `npm run migrate` first.');
  const director = result.rows[0];
  if (director.must_change_password) {
    throw new Error('The Director still has the starting password. Sign in to the app once as the Director and choose a new password, then run the tests again.');
  }
  const token = jwt.sign({ id: director.id }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  return { id: director.id, token };
}
