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

export function validNumber(value, { minimum = 0, maximum } = {}) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && (maximum === undefined || number <= maximum);
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

// "May this account touch a record in that operation?" -- the single-row form of
// managerScope, for handlers that have already loaded the row.
export function withinScope(user, sector) {
  return hasFullScope(user) || (Boolean(user.sector) && user.sector === sector);
}
