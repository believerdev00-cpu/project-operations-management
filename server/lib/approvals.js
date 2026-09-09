// Who must approve a record, and whether the caller is that person.
//
// "Pending" on its own says nothing: it leaves a record waiting on somebody,
// somewhere. Every activity and every movement therefore names its approver on
// the row itself -- approval_required_from, backed by approval_required_role --
// and three things are built from that one column:
//
//   * the "What I Need to Approve" queue, filtered by the signed-in user's id;
//   * the authorisation check in front of approve, reject, budget changes and
//     approval notes, so a button drawn in the browser is never the thing that
//     decides who may act;
//   * the detail screen's "Waiting for" line.
//
// approval_status ('pending' | 'approved' | 'rejected') is kept separate from
// the record's workflow status on purpose. The status says where the work is;
// approval_status says whether the decision has been taken. A record can be
// Rejected and later reopened without losing the fact that it was once refused.

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'];

// 'manager' -- a named sector manager must approve, typically because the
// Director handed them the work. 'director' -- the Director/Admin office must
// approve, typically because a manager is asking for money or authority.
export const APPROVER_ROLES = ['manager', 'director'];

export const APPROVER_ROLE_LABELS = {
  manager: 'Manager Approval',
  director: 'Director Approval'
};

export function isDirectorRole(user) {
  return user.role === 'super-admin';
}

// The Director's office, as an account id. Used when a manager raises something
// that the Director has to decide, so the row names a person and not just a
// role. The lowest id is the seeded 'admin' account, which is the one that
// exists on every deployment.
export async function resolveDirector(client) {
  const result = await client.query(
    "SELECT id, name FROM users WHERE role = 'super-admin' ORDER BY id LIMIT 1"
  );
  return result.rowCount ? result.rows[0] : null;
}

// May this user take the decision on this row?
//
// The primary rule is the one the workflow is specified in terms of:
// current_user.id == approval_required_from. The single widening is the
// Director's office -- "Waiting for: Director/Admin" names an office, not a
// person, so any account holding it can answer a director-role request. That
// keeps work from stalling behind one named Director account while still
// refusing every manager: a manager can never approve a director-role row, and
// can never approve a row that names a different manager.
export function canApprove(user, row) {
  if (!row.approval_required) return false;
  if (row.approval_status !== 'pending') return false;
  if (row.approval_required_role === 'director' && isDirectorRole(user)) return true;
  if (row.approval_required_from === null || row.approval_required_from === undefined) return false;
  return Number(row.approval_required_from) === Number(user.id);
}

// canApprove as SQL, for the queue and for read access to a record the caller
// would not otherwise be scoped to see. `values` is the parameter array the
// caller is building; the fragment comes back ready to drop into a WHERE.
export function approverMatchSql(user, values, alias) {
  values.push(user.id);
  const me = `$${values.length}`;
  return isDirectorRole(user)
    ? `(${alias}.approval_required_from = ${me} OR ${alias}.approval_required_role = 'director')`
    : `${alias}.approval_required_from = ${me}`;
}

// A row is *waiting on* someone only once it has actually been submitted, and
// only while it is still live. A Draft is still with its author and a Cancelled
// record is nobody's decision to take, so neither is a queue item even though
// approval_status is still 'pending'.
export function pendingForMeSql(user, values, alias = 'a') {
  return `(${alias}.approval_required = TRUE
    AND ${alias}.approval_status = 'pending'
    AND ${alias}.status NOT IN ('Draft', 'Cancelled')
    AND ${approverMatchSql(user, values, alias)})`;
}
