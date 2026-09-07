import { sectors } from '../data/seedData.js';

export const sectorIds = new Set(sectors.map((sector) => sector.id));

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

export function managerScope(user, column, values, filters) {
  if (!isAdmin(user)) {
    values.push(user.sector);
    filters.push(`${column} = $${values.length}`);
  }
}
