import { sectors } from '../data/seedData.js';

export const sectorIds = new Set(sectors.map((sector) => sector.id));

// What the account form sends for a manager who carries every business
// operation rather than one. It is deliberately not a sectors(id) value: the
// column is a foreign key into that table, so this never reaches the database.
// It is translated at the edge into sector NULL + covers_all_sectors.
export const ALL_OPERATIONS = 'all';

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function validateSector(sector, fallback) {
  const value = sector || fallback;
  return sectorIds.has(value) ? value : null;
}

export function requiredText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Money columns are NUMERIC(18,2), which tops out just under 10^16. Anything
// larger overflows in the database and used to come back as a 500, so the
// ceiling is enforced here, where it can be answered with a 400.
const LARGEST_AMOUNT = 1e15;

export function validNumber(value, { minimum = 0, maximum = LARGEST_AMOUNT } = {}) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum;
}

// A serial id from a URL or a body. Anything that is not a positive integer
// Postgres can hold is refused here rather than cast in SQL, where "abc" or
// "1.5" surfaced to the user as "Server or database error".
export function parseId(value) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isInteger(number) && number > 0 && number <= 2147483647 ? number : null;
}

// A calendar date as 'YYYY-MM-DD', and a real one. The shape alone lets
// 2024-02-30 through, which Postgres then refuses; Date.parse quietly rolls it
// over to 1 March instead. Building the date and reading its parts back is the
// only check that catches both.
export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// The Content-Disposition header for a stored file. The original name is
// whatever the uploader's device called it, and Node refuses a header carrying
// characters outside Latin-1 -- a receipt named in Kinyarwanda or with an emoji
// could never be opened. The plain filename is an ASCII fallback; filename*
// carries the real name, percent-encoded as RFC 5987 requires.
export function contentDisposition(originalName, disposition = 'inline') {
  const name = String(originalName || 'file');
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '') || 'file';
  let encoded;
  try {
    encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    // A lone surrogate cannot be encoded; the fallback alone is still a name.
    return `${disposition}; filename="${fallback}"`;
  }
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function isAdmin(user) {
  return user.role === 'super-admin';
}

// A manager carrying every business operation rather than one of them. Set on
// the account row, so it survives a re-read and can be taken away at any time.
export function coversAllSectors(user) {
  return user.role === 'manager' && Boolean(user.coversAllSectors);
}

// Two different questions wear the same shape in this codebase, and conflating
// them is how an all-operations manager would quietly become a second Director.
//
//   isAdmin(user)      -- AUTHORITY. May this account assign work, decide an
//                         approval, delete another user's record? Only the
//                         Director ever may, so these calls stay as they are.
//   hasFullScope(user) -- VISIBILITY. Which operations' rows may this account
//                         read and act within? The Director sees all of them,
//                         and so does a manager marked as covering all.
//
// Every sector filter below asks the second question. Nothing here grants the
// first.
export function hasFullScope(user) {
  return isAdmin(user) || coversAllSectors(user);
}

export function managerScope(user, column, values, filters) {
  if (!hasFullScope(user)) {
    values.push(user.sector);
    filters.push(`${column} = $${values.length}`);
  }
}

// A manager who has been made responsible for particular projects sees those
// projects and nothing else.
//
// Scoping used to be by business operation alone. With one project per operation
// that is the same thing, which is why it was never noticed -- but the moment a
// second project is opened in an operation, every manager in it can read the
// other one's work, budgets and spending. Responsibility is per project, so the
// filter is too.
//
// A manager responsible for NO project keeps the operation-wide view: that is
// the person covering an operation in general, and narrowing them to an empty
// list of projects would show them nothing at all. The Director and an
// all-operations manager are unaffected.
//
// `column` is the project id column of the table being read.
export function projectScope(user, column, values, filters) {
  if (hasFullScope(user)) return;
  if (user.role !== 'manager') return;
  values.push(user.id);
  filters.push(
    `(${column} IN (SELECT id FROM projects WHERE manager_id = $${values.length})
       OR NOT EXISTS (SELECT 1 FROM projects WHERE manager_id = $${values.length}))`
  );
}

// The single-row form of projectScope, for handlers that have already loaded the
// row. Answers "may this account touch a record on that project?".
export async function withinProjectScope(pool, user, projectId) {
  if (hasFullScope(user)) return true;
  if (user.role !== 'manager') return true;
  const mine = await pool.query('SELECT id FROM projects WHERE manager_id = $1', [user.id]);
  if (!mine.rowCount) return true;
  return mine.rows.some((row) => row.id === projectId);
}

// "May this account touch a record in that operation?" -- the single-row form of
// managerScope, for handlers that have already loaded the row.
export function withinScope(user, sector) {
  return hasFullScope(user) || (Boolean(user.sector) && user.sector === sector);
}
