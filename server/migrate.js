// Brings the database schema up to date, then exits. This is a deployment step,
// not something a request should ever trigger: on a serverless host the API is
// evaluated on every cold start, and running DDL from there would race several
// instances against each other.
//
//   npm run migrate
//
// It is safe to run repeatedly -- every statement is CREATE/ALTER ... IF NOT
// EXISTS or an idempotent update.
import { initDatabase, pool } from './db/database.js';

try {
  await initDatabase();
  console.log('Database schema is up to date.');
} catch (error) {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
