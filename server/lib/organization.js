// The organisation's rules, in one place, for the routes that build on them:
// who may run a team, who an issue goes to next, and the trail every change to
// the structure leaves.
//
// Every function here answers from the database rows, never from what the
// browser drew -- the same rule the approval helpers follow.

import { isAdmin, isGeneralManager, isSeniorManagement, withinScope, operationsSql } from './http.js';

// Appends one row to organization_history, in the caller's transaction when it
// has one. The actor's name is copied onto the row so the trail still reads
// after the account is gone.
export async function recordOrganization(db, actor, action, { teamId = null, subjectUserId = null, subjectName = '', detail = {} } = {}) {
  await db.query(
    `INSERT INTO organization_history (action, team_id, subject_user_id, subject_name, actor_id, actor_name, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [action, teamId, subjectUserId, subjectName || '', actor?.id ?? null, actor?.name || '', JSON.stringify(detail || {})]
  );
}

// A team as the routes need it to decide: the team, its project's operation and
// manager, and who leads it day to day (its own supervisor, or else the
// project's manager).
export async function loadTeamRow(db, teamId, { lock = false } = {}) {
  const result = await db.query(
    `SELECT t.*, p.sector, p.name AS project_name, p.manager_id AS project_manager_id,
            COALESCE(t.supervisor_id, p.manager_id) AS lead_id
       FROM teams t JOIN projects p ON p.id = t.project_id
      WHERE t.id = $1${lock ? ' FOR UPDATE OF t' : ''}`,
    [teamId]
  );
  return result.rows[0] || null;
}

// May this account create a team in this project? Senior management may in any
// project; a project manager may in a project they are responsible for. A
// manager covering an operation in general -- responsible for no project --
// may in their operation, the same "operation-wide when not narrowed" rule
// projectScope applies to what they read.
export async function canCreateTeam(db, user, project) {
  if (isSeniorManagement(user)) return true;
  if (user.role !== 'manager' || !withinScope(user, project.sector)) return false;
  if (Number(project.manager_id) === Number(user.id)) return true;
  const owns = await db.query('SELECT 1 FROM projects WHERE manager_id = $1 LIMIT 1', [user.id]);
  return owns.rowCount === 0;
}

// May this account change this team's name, members and leader? Senior
// management, the project's manager, and the team's own supervisor -- the
// people the team reports to. Nobody on the team itself, the leader included:
// a team member cannot put themselves or a friend on another crew.
export function canManageTeam(user, team) {
  if (isSeniorManagement(user)) return true;
  if (user.role !== 'manager' || !withinScope(user, team.sector)) return false;
  return Number(team.project_manager_id) === Number(user.id)
    || Number(team.supervisor_id) === Number(user.id);
}

// Who supervises a team is a decision about the line itself, so it stays with
// senior management: a project manager handing their team to somebody else, or
// taking a colleague's, is a reorganisation.
export function canChangeSupervisor(user) {
  return isSeniorManagement(user);
}

// ---- where an issue goes next ---------------------------------------------
//
// An issue climbs the reporting line. The next desk for any account is:
//
//   1. the person they report to (users.manager_id), when that account is
//      active and is somebody who can hold an issue (a manager, a General
//      Manager, or the Director);
//   2. otherwise, by role --
//        team member      -> the lead of a team they are on in the issue's
//                            project (its supervisor or the project manager),
//                            then the project's manager;
//        project manager  -> an active General Manager;
//        anybody else     -> the Director's office.
//
// The Director's office is the top: an issue there can be settled but never
// passed on. Every step lands on a named person except the office, which any
// active Director may answer -- the same widening approval_required_role gives
// the Director's approvals, so one Director being away does not stall it.

const HOLDER_ROLES = { manager: 'manager', 'general-manager': 'general-manager', 'super-admin': 'director' };

async function activeHolder(db, id) {
  if (!id) return null;
  const result = await db.query(
    "SELECT id, name, role FROM users WHERE id = $1 AND status = 'active' AND role IN ('manager', 'general-manager', 'super-admin')",
    [id]
  );
  const row = result.rows[0];
  return row ? { id: row.id, name: row.name, role: HOLDER_ROLES[row.role] } : null;
}

async function directorOffice(db) {
  const result = await db.query(
    "SELECT id, name FROM users WHERE role = 'super-admin' AND status = 'active' ORDER BY id LIMIT 1"
  );
  const row = result.rows[0];
  return { id: row?.id ?? null, name: row?.name || '', role: 'director' };
}

// The desk above `person` (a users row with id, role, manager_id), for an issue
// about `projectId` (may be null). Never returns `person` themselves, and never
// a desk at or below them: a General Manager's issue goes to the Director even
// if a data error pointed their line elsewhere.
export async function nextDeskFor(db, person, projectId = null) {
  if (person.role === 'super-admin') return null;
  const boss = await activeHolder(db, person.manager_id);
  const above = (desk) => desk && Number(desk.id) !== Number(person.id)
    && !(person.role === 'general-manager' && desk.role !== 'director');
  if (above(boss)) return boss;

  if (person.role === 'staff' && projectId) {
    const lead = await db.query(
      `SELECT COALESCE(t.supervisor_id, p.manager_id) AS lead_id
         FROM team_members tm
         JOIN teams t ON t.id = tm.team_id AND t.status = 'active'
         JOIN projects p ON p.id = t.project_id
        WHERE tm.user_id = $1 AND t.project_id = $2
        ORDER BY t.id LIMIT 1`,
      [person.id, projectId]
    );
    const teamLead = await activeHolder(db, lead.rows[0]?.lead_id);
    if (above(teamLead)) return teamLead;
    const project = await db.query('SELECT manager_id FROM projects WHERE id = $1', [projectId]);
    const projectManager = await activeHolder(db, project.rows[0]?.manager_id);
    if (above(projectManager)) return projectManager;
  }
  if (person.role === 'staff' || person.role === 'manager') {
    const general = await db.query(
      "SELECT id FROM users WHERE role = 'general-manager' AND status = 'active' ORDER BY id LIMIT 1"
    );
    const gm = await activeHolder(db, general.rows[0]?.id);
    if (above(gm)) return gm;
  }
  return directorOffice(db);
}

// The project manager who checks a team member's finished work before the
// Director sees it: the manager they report to, else the lead of their team on
// that project, else the project's own manager. Only an active manager --
// never the General Manager or the Director, who are later in the chain -- and
// null when there is none, in which case the work goes straight to the
// Director as it always did.
export async function checkerFor(db, person, projectId) {
  if (person.role !== 'staff') return null;
  const manager = async (id) => {
    if (!id) return null;
    const found = await db.query("SELECT id, name FROM users WHERE id = $1 AND role = 'manager' AND status = 'active'", [id]);
    return found.rows[0] || null;
  };
  const boss = await manager(person.manager_id);
  if (boss) return boss;
  if (!projectId) return null;
  const lead = await db.query(
    `SELECT COALESCE(t.supervisor_id, p.manager_id) AS lead_id
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id AND t.status = 'active'
       JOIN projects p ON p.id = t.project_id
      WHERE tm.user_id = $1 AND t.project_id = $2
      ORDER BY t.id LIMIT 1`,
    [person.id, projectId]
  );
  const teamLead = await manager(lead.rows[0]?.lead_id);
  if (teamLead) return teamLead;
  const project = await db.query('SELECT manager_id FROM projects WHERE id = $1', [projectId]);
  return manager(project.rows[0]?.manager_id);
}

// The holder's own row, for working out where they would pass an issue next.
export async function personRow(db, id) {
  const result = await db.query(
    `SELECT id, name, role, sector, manager_id, status, covers_all_sectors AS "coversAllSectors",
            ${operationsSql('users')} AS operations
       FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// Is this account the one an open issue is waiting on? The named holder, or
// any Director when it sits with the Director's office.
export function holdsEscalation(user, row) {
  if (row.status !== 'open') return false;
  if (row.holder_role === 'director' && isAdmin(user)) return true;
  return row.holder_id !== null && Number(row.holder_id) === Number(user.id);
}

// The same, as SQL, for the "waiting for me" list and its badge -- kept beside
// holdsEscalation so the two cannot drift apart.
export function escalationsHeldBySql(user, values, alias = 'e') {
  values.push(user.id);
  const me = `$${values.length}`;
  return isAdmin(user)
    ? `(${alias}.status = 'open' AND (${alias}.holder_id = ${me} OR ${alias}.holder_role = 'director'))`
    : `(${alias}.status = 'open' AND ${alias}.holder_id = ${me})`;
}

// Which escalations an account may read: senior management reads them all; a
// manager reads those raised in, held in, or ever passed through their hands,
// plus anything in a project they run; a team member reads what they raised.
export function escalationVisibilitySql(user, values, alias = 'e') {
  if (isAdmin(user) || isGeneralManager(user)) return 'TRUE';
  values.push(user.id);
  const me = `$${values.length}`;
  const touched = `(${alias}.raised_by = ${me} OR ${alias}.holder_id = ${me}
    OR EXISTS (SELECT 1 FROM escalation_events ev WHERE ev.escalation_id = ${alias}.id
                 AND (ev.from_holder_id = ${me} OR ev.to_holder_id = ${me})))`;
  if (user.role !== 'manager') return touched;
  return `(${touched} OR ${alias}.project_id IN (SELECT id FROM projects WHERE manager_id = ${me}))`;
}

// ---- what a partner sees, project by project --------------------------------
//
// partner_operations grants whole operations. Once the Director shares any
// particular project in an operation with a partner (partner_projects), that
// operation narrows for them to the projects shared -- the rest of it goes
// dark. An operation with nothing shared project by project reads exactly as
// it always did, so no existing partner lost or gained anything when this
// arrived.
//
// `partnerExpr` is the SQL holding the partner's id; `sectorExpr` and
// `projectExpr` are the record's operation and project columns. Used by every
// partner query (server/routes/partner.js) and by the register's counts
// (server/routes/partners.js), so the two cannot disagree.
export function partnerProjectSql(partnerExpr, sectorExpr, projectExpr) {
  return `(NOT EXISTS (SELECT 1 FROM partner_projects pp JOIN projects pj ON pj.id = pp.project_id
                        WHERE pp.partner_id = ${partnerExpr} AND pj.sector = ${sectorExpr})
           OR ${projectExpr} IN (SELECT pp.project_id FROM partner_projects pp WHERE pp.partner_id = ${partnerExpr}))`;
}
