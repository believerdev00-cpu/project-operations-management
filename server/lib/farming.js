// Farming Management: who may do what, the history every write leaves, and the
// pieces of reading every farm route shares.
//
// WHO. Four kinds of people reach the farm, decided from the account row
// authMiddleware re-reads on every request (never from the browser):
//
//   director  the Director (super-admin). Everything, including the farm's
//             monthly budget, which is theirs alone to set.
//   reader    the General Manager. Reads everything, writes nothing -- exactly
//             as hasFullScope gives them every other operation to read.
//   manager   the Farming Manager: a `manager` whose operations include
//             Farming (or who covers every operation). Records, approves the
//             team's expenses, corrects and voids, keeps the animal types and
//             the alert thresholds.
//   staff     a team member placed in Farming. Records production, herd
//             changes and sales, submits expenses, raises problems, corrects
//             what they recorded themselves (with a reason). Does not see the
//             farm's money -- revenue, costs, budget, results -- or other
//             people's expenses: the figures are the manager's tools, and a
//             team member's screen is kept to their own work.
//
// Everybody else -- a Mining manager, a boutique cashier -- is refused by
// farmAccess before any handler runs; partners never get here (the allowlist
// in auth.js).

import { isAdmin, isGeneralManager, parseId } from './http.js';
import { worksOnFarm } from '../../shared/businessOperations.js';

export class FarmError extends Error {
  constructor(status, message, code = null, extra = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function farmRole(user) {
  if (!user) return null;
  if (isAdmin(user)) return 'director';
  if (isGeneralManager(user)) return 'reader';
  if (!worksOnFarm(user)) return null;
  return user.role === 'manager' ? 'manager' : 'staff';
}

export function farmAccess(req, res, next) {
  const role = farmRole(req.user);
  if (!role) {
    return res.status(403).json({ code: 'FARM_ACCESS', message: 'Only the farm’s own people and senior management can open the farm.' });
  }
  req.farm = role;
  // A reader writes nothing, whatever the route: one wall in front of every
  // write, so no handler has to remember it.
  if (role === 'reader' && req.method !== 'GET') {
    return res.status(403).json({ code: 'NOT_ALLOWED', message: 'The General Manager reads the farm; the Farming Manager and the Director change it.' });
  }
  next();
}

export const canRecord = (role) => ['director', 'manager', 'staff'].includes(role);
export const canManage = (role) => ['director', 'manager'].includes(role);
// Revenue, costs, results and the budget: everybody but a team member.
export const seesMoney = (role) => role !== 'staff';

export function requireManage(req) {
  if (!canManage(req.farm)) throw new FarmError(403, 'Only the Farming Manager or the Director can do this.', 'NOT_ALLOWED');
}
export function requireDirector(req) {
  if (req.farm !== 'director') throw new FarmError(403, 'Only the Director sets the farm’s budget.', 'NOT_ALLOWED');
}
export function requireMoney(req) {
  if (!seesMoney(req.farm)) throw new FarmError(403, 'The farm’s figures are the Farming Manager’s and senior management’s.', 'NOT_ALLOWED');
}

// A validator's codes, answered as one refusal. The first code is the one the
// screen translates; all of them travel, so a form can mark every field.
export function refuse(errors, message = 'Please check the form and try again.') {
  throw new FarmError(400, message, errors[0], { errors });
}

export function recordId(value) {
  const parsed = parseId(value);
  if (!parsed) throw new FarmError(404, 'Record not found.', 'NOT_FOUND');
  return parsed;
}

// The day on the farm. A milking recorded at 00:30 in Kigali belongs to that
// day, not to the UTC day; the farm's timezone decides, like the shop's.
const FARM_TIMEZONE = process.env.FARM_TIMEZONE || process.env.BOUTIQUE_TIMEZONE || 'Africa/Kigali';
export function farmToday() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: FARM_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// ---- the history -----------------------------------------------------------

export async function farmAudit(db, { entityType, entityId = null, action, reason = '', details = {}, actor }) {
  await db.query(
    `INSERT INTO farm_audit (entity_type, entity_id, action, reason, details, actor_id, actor_name)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [entityType, entityId, action, reason || '', JSON.stringify(details || {}), actor?.id ?? null, actor?.name ?? '']
  );
}

// ---- rows as the API answers them -------------------------------------------

const day = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const date = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${date}`;
};
const number = (value) => (value === null || value === undefined ? null : Number(value));

export function mapType(row) {
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    expenseCategories: Array.isArray(row.expense_categories) ? row.expense_categories : [],
    sortOrder: row.sort_order,
    seedKey: row.seed_key || null
  };
}

export function mapMeasure(row) {
  return {
    id: row.id,
    animalTypeId: row.animal_type_id,
    name: row.name,
    kind: row.kind,
    unit: row.unit,
    sellable: row.sellable,
    perishable: row.perishable,
    dailyExpected: row.daily_expected,
    active: row.active,
    sortOrder: row.sort_order,
    // The starting measures' key ('cows.milk'), so the screen can show their
    // name in the reader's language until somebody renames them.
    seedKey: row.seed_key || null
  };
}

const recorded = (row) => ({
  status: row.status,
  voidReason: row.void_reason || '',
  voidedAt: row.voided_at,
  recordedBy: row.recorded_by,
  recordedByName: row.recorded_by_name || '',
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export function mapProduction(row) {
  return {
    id: row.id,
    measureId: row.measure_id,
    animalTypeId: row.animal_type_id,
    date: day(row.produced_on),
    produced: number(row.produced),
    lost: number(row.lost),
    notes: row.notes || '',
    ...recorded(row)
  };
}

export function mapSale(row) {
  return {
    id: row.id,
    measureId: row.measure_id,
    animalTypeId: row.animal_type_id,
    date: day(row.sold_on),
    quantity: number(row.quantity),
    amount: number(row.amount),
    currency: row.currency,
    amountUsd: number(row.amount_usd),
    buyer: row.buyer || '',
    notes: row.notes || '',
    ...recorded(row)
  };
}

export function mapHerdEvent(row) {
  return {
    id: row.id,
    measureId: row.measure_id,
    animalTypeId: row.animal_type_id,
    date: day(row.event_on),
    kind: row.kind,
    count: row.count,
    delta: row.delta,
    reason: row.reason || '',
    saleId: row.sale_id,
    ...recorded(row)
  };
}

export function mapExpense(row) {
  return {
    id: row.id,
    date: day(row.spent_on),
    amount: number(row.amount),
    currency: row.currency,
    amountUsd: number(row.amount_usd),
    animalTypeId: row.animal_type_id,
    shared: row.animal_type_id === null,
    category: row.category,
    description: row.description,
    payee: row.payee || '',
    receiptRef: row.receipt_ref || '',
    status: row.status,
    submittedBy: row.submitted_by,
    submittedByName: row.submitted_by_name || '',
    decidedByName: row.decided_by_name || '',
    decidedAt: row.decided_at,
    decisionNote: row.decision_note || '',
    voidReason: row.void_reason || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapIssue(row) {
  return {
    id: row.id,
    kind: row.kind,
    urgent: row.urgent,
    animalTypeId: row.animal_type_id,
    description: row.description,
    status: row.status,
    raisedBy: row.raised_by,
    raisedByName: row.raised_by_name || '',
    resolvedByName: row.resolved_by_name || '',
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note || '',
    createdAt: row.created_at
  };
}

export function mapAudit(row) {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    reason: row.reason || '',
    details: row.details || {},
    actorName: row.actor_name || '',
    createdAt: row.created_at
  };
}
