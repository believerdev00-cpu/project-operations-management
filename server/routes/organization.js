// The organisation chart and the teams inside each project.
//
//   GET    /api/organization                         the chart, as far as the reader may see it
//   POST   /api/organization/teams                   create a team in a project
//   PATCH  /api/organization/teams/:id               rename, describe, change supervisor, archive/restore
//   GET    /api/organization/teams/:id/candidates    team members who could join
//   POST   /api/organization/teams/:id/members       put somebody on the team
//   PATCH  /api/organization/teams/:id/members/:userId   make or unmake the leader
//   DELETE /api/organization/teams/:id/members/:userId   take somebody off
//   GET    /api/organization/history                 the trail of every change (senior management)
//
// A partner never reaches this file: authMiddleware's allowlist refuses
// /api/organization to them before any handler runs. The chart shows a
// partner branch to senior management only, and then only the partner's name,
// organisation, operations and shared projects -- the same facts the partner
// register already shows the Director.

import express from 'express';
import { pool, safeRollback } from '../db/database.js';
import {
  asyncRoute, hasFullScope, isAdmin, isSeniorManagement, operationsOf, operationsSql, parseId, withinScope
} from '../lib/http.js';
import {
  canChangeSupervisor, canCreateTeam, canManageTeam, loadTeamRow, recordOrganization
} from '../lib/organization.js';
import { notify } from '../lib/notifications.js';

const router = express.Router();

class OrganizationError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Authentication required.' });
  next();
});

router.param('id', (req, res, next, value) => {
  if (!parseId(value)) return res.status(404).json({ message: 'Team not found.' });
  next();
});

const NAME_LIMIT = 120;

function cleanName(value) {
  return typeof value === 'string' ? value.trim().slice(0, NAME_LIMIT) : '';
}

function mapTeam(row, members = []) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    status: row.status,
    projectId: row.project_id,
    projectName: row.project_name || '',
    sector: row.sector,
    supervisorId: row.supervisor_id ?? null,
    leadId: row.lead_id ?? null,
    leadName: row.lead_name || null,
    projectManagerId: row.project_manager_id ?? null,
    createdAt: row.created_at,
    members
  };
}

// ---- reading ----------------------------------------------------------------

// Which teams this account may see on the chart. Senior management and an
// all-operations manager see every team. A project manager sees the teams of
// their projects and any team they supervise -- or, responsible for no project,
// every team in their operations. A team member sees the teams they are on.
function teamScopeSql(user, values) {
  if (hasFullScope(user)) return 'TRUE';
  values.push(user.id);
  const me = `$${values.length}`;
  if (user.role === 'manager') {
    values.push(operationsOf(user));
    const mine = `$${values.length}::text[]`;
    return `(p.manager_id = ${me} OR t.supervisor_id = ${me}
      OR (p.sector = ANY(${mine}) AND NOT EXISTS (SELECT 1 FROM projects own WHERE own.manager_id = ${me})))`;
  }
  return `EXISTS (SELECT 1 FROM team_members own WHERE own.team_id = t.id AND own.user_id = ${me})`;
}

async function loadTeams(user, { includeArchived = false } = {}) {
  const values = [];
  const scope = teamScopeSql(user, values);
  const teams = await pool.query(
    `SELECT t.*, p.sector, p.name AS project_name, p.manager_id AS project_manager_id,
            COALESCE(t.supervisor_id, p.manager_id) AS lead_id, lead.name AS lead_name
       FROM teams t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN users lead ON lead.id = COALESCE(t.supervisor_id, p.manager_id)
      WHERE ${scope}${includeArchived ? '' : " AND t.status = 'active'"}
      ORDER BY p.name, lower(t.name)`,
    values
  );
  if (!teams.rowCount) return [];
  const members = await pool.query(
    `SELECT tm.team_id, tm.is_leader, tm.added_at, u.id, u.name, u.status
       FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ANY($1::int[])
      ORDER BY tm.is_leader DESC, u.name`,
    [teams.rows.map((row) => row.id)]
  );
  const byTeam = new Map();
  for (const row of members.rows) {
    if (!byTeam.has(row.team_id)) byTeam.set(row.team_id, []);
    byTeam.get(row.team_id).push({
      id: row.id, name: row.name, status: row.status, isLeader: row.is_leader, addedAt: row.added_at
    });
  }
  // canManage is worked out here by the same rule every team route enforces,
  // so the browser draws the buttons the server will accept and no others.
  return teams.rows.map((row) => ({ ...mapTeam(row, byTeam.get(row.id) || []), canManage: canManageTeam(user, row) }));
}

// Everybody on the internal side of the chart the reader may see, with their
// line and what they run. Senior management sees the whole line; a manager
// sees themselves, the people on their teams and the line above them; a team
// member sees the line above them. Nobody below senior management sees a
// colleague's projects or a peer manager's people.
async function loadPeople(user, teams) {
  const result = await pool.query(
    `SELECT u.id, u.name, u.role, u.status, u.manager_id, u.covers_all_sectors AS "coversAllSectors",
            ${operationsSql('u')} AS operations,
            COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'sector', p.sector) ORDER BY p.name)
                        FROM projects p WHERE p.manager_id = u.id), '[]'::json) AS projects
       FROM users u
      WHERE u.role IN ('super-admin', 'general-manager', 'manager', 'staff')
      ORDER BY CASE u.role WHEN 'super-admin' THEN 0 WHEN 'general-manager' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, u.name`
  );
  const everybody = result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    status: row.status,
    reportsToId: row.manager_id ?? null,
    operations: row.operations || [],
    coversAllSectors: Boolean(row.coversAllSectors),
    projects: row.projects || []
  }));
  if (isSeniorManagement(user) || hasFullScope(user)) return everybody;

  const byId = new Map(everybody.map((person) => [person.id, person]));
  const visible = new Set([user.id]);
  // The line above the reader, all the way up.
  let cursor = byId.get(user.id)?.reportsToId;
  const guard = new Set();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    visible.add(cursor);
    cursor = byId.get(cursor)?.reportsToId;
  }
  // The leads and members of every team they can see.
  for (const team of teams) {
    if (team.leadId) visible.add(team.leadId);
    for (const member of team.members) visible.add(member.id);
  }
  // A manager also sees the people who report to them.
  if (user.role === 'manager') {
    for (const person of everybody) if (person.reportsToId === user.id) visible.add(person.id);
  }
  // The Director is always on the chart: everybody's line ends there.
  for (const person of everybody) if (person.role === 'super-admin') visible.add(person.id);
  return everybody
    .filter((person) => visible.has(person.id))
    // Somebody else's projects are not this reader's business; their own are.
    .map((person) => (person.id === user.id || person.role === 'super-admin' ? person : { ...person, projects: [] }));
}

// The external branch, for senior management only. Names, organisation,
// operations and shared projects -- nothing the partner register does not
// already show the Director.
async function loadPartners(user) {
  if (!isSeniorManagement(user)) return [];
  const result = await pool.query(
    `SELECT u.id, u.name, u.organization, u.status, contact.name AS contact_name, u.partner_contact_id,
            COALESCE((SELECT array_agg(po.sector::text ORDER BY po.sector) FROM partner_operations po WHERE po.partner_id = u.id),
                     ARRAY[u.sector::text]) AS operations,
            COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'sector', p.sector) ORDER BY p.name)
                        FROM partner_projects pp JOIN projects p ON p.id = pp.project_id WHERE pp.partner_id = u.id), '[]'::json) AS projects
       FROM users u
       LEFT JOIN users contact ON contact.id = u.partner_contact_id
      WHERE u.role = 'partner'
      ORDER BY u.status = 'active' DESC, u.name`
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    organization: row.organization || '',
    status: row.status,
    contactId: row.partner_contact_id ?? null,
    contactName: row.contact_name || null,
    operations: row.operations || [],
    projects: row.projects || []
  }));
}

router.get('/', asyncRoute(async (req, res) => {
  const teams = await loadTeams(req.user, { includeArchived: isSeniorManagement(req.user) && req.query.archived === '1' });
  const [people, partners] = await Promise.all([loadPeople(req.user, teams), loadPartners(req.user)]);
  // Projects with no team yet, for the reader who may create one there.
  const projectValues = [];
  const projectFilters = [];
  if (!hasFullScope(req.user)) {
    if (req.user.role === 'manager') {
      projectValues.push(req.user.id, operationsOf(req.user));
      projectFilters.push(`(p.manager_id = $1 OR (p.sector = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM projects own WHERE own.manager_id = $1)))`);
    } else {
      projectFilters.push('FALSE');
    }
  }
  const projects = await pool.query(
    `SELECT p.id, p.name, p.sector, p.manager_id, m.name AS manager_name
       FROM projects p LEFT JOIN users m ON m.id = p.manager_id
      ${projectFilters.length ? `WHERE ${projectFilters.join(' AND ')}` : ''}
      ORDER BY p.sector, p.name`,
    projectValues
  );
  res.json({
    people,
    teams,
    partners,
    projects: projects.rows.map((row) => ({
      id: row.id, name: row.name, sector: row.sector, managerId: row.manager_id ?? null, managerName: row.manager_name || null
    })),
    // What the reader may do here, worked out by the same rules the routes
    // below enforce. The browser draws buttons from it; the routes decide.
    can: {
      seeWholeOrganization: isSeniorManagement(req.user),
      createTeams: isSeniorManagement(req.user) || req.user.role === 'manager',
      changeSupervisors: canChangeSupervisor(req.user),
      changeReportingLines: isAdmin(req.user),
      managePartners: isAdmin(req.user)
    }
  });
}));

router.get('/history', asyncRoute(async (req, res) => {
  if (!isSeniorManagement(req.user)) {
    return res.status(403).json({ message: 'Only the Director and the General Manager can read the organisation trail.' });
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const result = await pool.query(
    `SELECT h.*, t.name AS team_name FROM organization_history h
       LEFT JOIN teams t ON t.id = h.team_id
      ORDER BY h.created_at DESC, h.id DESC LIMIT $1`,
    [limit]
  );
  res.json(result.rows.map((row) => ({
    id: row.id,
    action: row.action,
    teamId: row.team_id ?? null,
    teamName: row.team_name || row.detail?.teamName || null,
    subjectName: row.subject_name || '',
    actorName: row.actor_name || '',
    detail: row.detail || {},
    createdAt: row.created_at
  })));
}));

// ---- teams --------------------------------------------------------------------

// The manager who will lead a team: an active manager who works in the team's
// operation. Anybody else is refused, so a team can never be led by somebody
// who cannot open its project's records.
async function validSupervisor(db, supervisorId, sector) {
  const result = await db.query(
    `SELECT id, name, role, sector, covers_all_sectors AS "coversAllSectors", ${operationsSql('users')} AS operations
       FROM users WHERE id = $1 AND role = 'manager' AND status = 'active'`,
    [supervisorId]
  );
  const supervisor = result.rows[0];
  if (!supervisor || !withinScope(supervisor, sector)) {
    throw new OrganizationError(400, 'Choose an active manager who works in this project’s operation.');
  }
  return supervisor;
}

function translateTeamError(error) {
  if (error?.code === '23505') return new OrganizationError(409, 'This project already has a team with that name.', 'TEAM_NAME_TAKEN');
  if (error?.code === 'P0001') return new OrganizationError(400, error.message);
  return error;
}

router.post('/teams', asyncRoute(async (req, res) => {
  const payload = req.body || {};
  const name = cleanName(payload.name);
  if (!name) return res.status(400).json({ message: 'Give the team a name.' });
  if (typeof payload.projectId !== 'string' || !payload.projectId) {
    return res.status(400).json({ message: 'Choose the project the team works on.' });
  }
  const project = await pool.query('SELECT id, name, sector, manager_id FROM projects WHERE id = $1', [payload.projectId]);
  if (!project.rowCount) return res.status(404).json({ message: 'Project not found.' });
  if (!(await canCreateTeam(pool, req.user, project.rows[0]))) {
    return res.status(403).json({ message: 'You can create teams only in projects you manage.' });
  }
  let supervisorId = null;
  if (payload.supervisorId !== undefined && payload.supervisorId !== null && payload.supervisorId !== '') {
    if (!canChangeSupervisor(req.user)) {
      return res.status(403).json({ message: 'Only the Director or the General Manager chooses who supervises a team.' });
    }
    supervisorId = parseId(payload.supervisorId);
    if (!supervisorId) return res.status(400).json({ message: 'Choose an active manager who works in this project’s operation.' });
    await validSupervisor(pool, supervisorId, project.rows[0].sector);
  }

  const client = await pool.connect();
  let teamId;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO teams (project_id, name, description, supervisor_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [project.rows[0].id, name, String(payload.description || '').trim().slice(0, 2000), supervisorId, req.user.id]
    );
    teamId = inserted.rows[0].id;
    await recordOrganization(client, req.user, 'team_created', {
      teamId, subjectName: name, detail: { projectId: project.rows[0].id, projectName: project.rows[0].name, teamName: name, supervisorId }
    });
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw translateTeamError(error);
  } finally {
    client.release();
  }
  const teams = await loadTeams(req.user, { includeArchived: true });
  res.status(201).json(teams.find((team) => team.id === teamId) || { id: teamId });
}));

router.patch('/teams/:id', asyncRoute(async (req, res) => {
  const payload = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const team = await loadTeamRow(client, req.params.id, { lock: true });
    if (!team) throw new OrganizationError(404, 'Team not found.');
    if (!canManageTeam(req.user, team)) throw new OrganizationError(403, 'You can change only the teams you lead or whose project you manage.');

    const changes = {};
    if (payload.name !== undefined) {
      const name = cleanName(payload.name);
      if (!name) throw new OrganizationError(400, 'Give the team a name.');
      if (name !== team.name) changes.name = name;
    }
    if (payload.description !== undefined) {
      const description = String(payload.description || '').trim().slice(0, 2000);
      if (description !== team.description) changes.description = description;
    }
    if (payload.supervisorId !== undefined) {
      if (!canChangeSupervisor(req.user)) {
        throw new OrganizationError(403, 'Only the Director or the General Manager chooses who supervises a team.');
      }
      const supervisorId = payload.supervisorId === null || payload.supervisorId === '' ? null : parseId(payload.supervisorId);
      if (payload.supervisorId !== null && payload.supervisorId !== '' && !supervisorId) {
        throw new OrganizationError(400, 'Choose an active manager who works in this project’s operation.');
      }
      if (supervisorId) await validSupervisor(client, supervisorId, team.sector);
      if (Number(supervisorId || 0) !== Number(team.supervisor_id || 0)) changes.supervisor_id = supervisorId;
    }
    let statusAction = null;
    if (payload.status !== undefined) {
      if (!['active', 'archived'].includes(payload.status)) throw new OrganizationError(400, 'A team is active or archived.');
      if (payload.status !== team.status) {
        changes.status = payload.status;
        statusAction = payload.status === 'archived' ? 'team_archived' : 'team_restored';
      }
    }
    if (!Object.keys(changes).length) throw new OrganizationError(400, 'Nothing to change.');

    const columns = Object.keys(changes);
    const values = [team.id, ...columns.map((column) => changes[column])];
    await client.query(
      `UPDATE teams SET ${columns.map((column, index) => `${column} = $${index + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1`,
      values
    );
    const { status: _status, ...edits } = changes;
    if (Object.keys(edits).length) {
      await recordOrganization(client, req.user, 'team_updated', {
        teamId: team.id, subjectName: changes.name || team.name,
        detail: { teamName: changes.name || team.name, ...edits, previous: { name: team.name, supervisorId: team.supervisor_id } }
      });
    }
    if (statusAction) {
      await recordOrganization(client, req.user, statusAction, { teamId: team.id, subjectName: team.name, detail: { teamName: team.name } });
    }
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw translateTeamError(error);
  } finally {
    client.release();
  }
  const teams = await loadTeams(req.user, { includeArchived: true });
  res.json(teams.find((team) => team.id === Number(req.params.id)) || { id: Number(req.params.id) });
}));

// Team members who may join this team: active, in the team's operation, and
// not on it already.
router.get('/teams/:id/candidates', asyncRoute(async (req, res) => {
  const team = await loadTeamRow(pool, req.params.id);
  if (!team) return res.status(404).json({ message: 'Team not found.' });
  if (!canManageTeam(req.user, team)) return res.status(403).json({ message: 'You can change only the teams you lead or whose project you manage.' });
  const result = await pool.query(
    `SELECT u.id, u.name, u.sector FROM users u
      WHERE u.role = 'staff' AND u.status = 'active' AND u.sector = $2
        AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = $1 AND tm.user_id = u.id)
      ORDER BY u.name`,
    [team.id, team.sector]
  );
  res.json(result.rows);
}));

router.post('/teams/:id/members', asyncRoute(async (req, res) => {
  const userId = parseId(req.body?.userId);
  if (!userId) return res.status(400).json({ message: 'Choose a team member.' });
  const isLeader = req.body?.isLeader === true;
  const client = await pool.connect();
  let added;
  try {
    await client.query('BEGIN');
    const team = await loadTeamRow(client, req.params.id, { lock: true });
    if (!team) throw new OrganizationError(404, 'Team not found.');
    if (!canManageTeam(req.user, team)) throw new OrganizationError(403, 'You can change only the teams you lead or whose project you manage.');
    if (team.status !== 'active') throw new OrganizationError(409, 'This team is archived. Restore it before adding people.');
    const person = await client.query(
      `SELECT id, name, role, status, sector, covers_all_sectors AS "coversAllSectors", ${operationsSql('users')} AS operations
         FROM users WHERE id = $1`,
      [userId]
    );
    const member = person.rows[0];
    // Only team members join teams. A partner in particular never does: being
    // on a team is what opens a project's records to its members.
    if (!member || member.role !== 'staff') throw new OrganizationError(400, 'Only team members can be added to a team.');
    if (member.status !== 'active') throw new OrganizationError(400, 'That account is suspended.');
    if (!withinScope(member, team.sector)) {
      throw new OrganizationError(400, 'That person works in a different operation from this project.');
    }
    const inserted = await client.query(
      `INSERT INTO team_members (team_id, user_id, added_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING user_id`,
      [team.id, member.id, req.user.id]
    );
    if (!inserted.rowCount) throw new OrganizationError(409, 'That person is already on this team.', 'ALREADY_MEMBER');
    if (isLeader) {
      await client.query('UPDATE team_members SET is_leader = FALSE WHERE team_id = $1 AND is_leader', [team.id]);
      await client.query('UPDATE team_members SET is_leader = TRUE WHERE team_id = $1 AND user_id = $2', [team.id, member.id]);
    }
    await recordOrganization(client, req.user, 'member_added', {
      teamId: team.id, subjectUserId: member.id, subjectName: member.name,
      detail: { teamName: team.name, projectName: team.project_name, isLeader }
    });
    await notify(client, {
      userId: member.id,
      kind: 'team_added',
      params: { team: team.name, project: team.project_name, name: req.user.name },
      link: '#/dashboard',
      actor: req.user
    });
    await client.query('COMMIT');
    added = member;
  } catch (error) {
    await safeRollback(client);
    throw translateTeamError(error);
  } finally {
    client.release();
  }
  res.status(201).json({ teamId: Number(req.params.id), userId: added.id, name: added.name, isLeader });
}));

router.patch('/teams/:id/members/:userId', asyncRoute(async (req, res) => {
  const userId = parseId(req.params.userId);
  if (!userId) return res.status(404).json({ message: 'That person is not on this team.' });
  if (typeof req.body?.isLeader !== 'boolean') return res.status(400).json({ message: 'Say whether this person leads the team.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const team = await loadTeamRow(client, req.params.id, { lock: true });
    if (!team) throw new OrganizationError(404, 'Team not found.');
    if (!canManageTeam(req.user, team)) throw new OrganizationError(403, 'You can change only the teams you lead or whose project you manage.');
    const current = await client.query(
      `SELECT tm.is_leader, u.name FROM team_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = $1 AND tm.user_id = $2`,
      [team.id, userId]
    );
    if (!current.rowCount) throw new OrganizationError(404, 'That person is not on this team.');
    if (current.rows[0].is_leader !== req.body.isLeader) {
      if (req.body.isLeader) await client.query('UPDATE team_members SET is_leader = FALSE WHERE team_id = $1 AND is_leader', [team.id]);
      await client.query('UPDATE team_members SET is_leader = $3 WHERE team_id = $1 AND user_id = $2', [team.id, userId, req.body.isLeader]);
      await recordOrganization(client, req.user, 'leader_changed', {
        teamId: team.id, subjectUserId: userId, subjectName: current.rows[0].name,
        detail: { teamName: team.name, isLeader: req.body.isLeader }
      });
    }
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw translateTeamError(error);
  } finally {
    client.release();
  }
  res.json({ teamId: Number(req.params.id), userId, isLeader: req.body.isLeader });
}));

router.delete('/teams/:id/members/:userId', asyncRoute(async (req, res) => {
  const userId = parseId(req.params.userId);
  if (!userId) return res.status(404).json({ message: 'That person is not on this team.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const team = await loadTeamRow(client, req.params.id, { lock: true });
    if (!team) throw new OrganizationError(404, 'Team not found.');
    if (!canManageTeam(req.user, team)) throw new OrganizationError(403, 'You can change only the teams you lead or whose project you manage.');
    const removed = await client.query(
      `DELETE FROM team_members tm USING users u
        WHERE tm.team_id = $1 AND tm.user_id = $2 AND u.id = tm.user_id RETURNING u.name`,
      [team.id, userId]
    );
    if (!removed.rowCount) throw new OrganizationError(404, 'That person is not on this team.');
    await recordOrganization(client, req.user, 'member_removed', {
      teamId: team.id, subjectUserId: userId, subjectName: removed.rows[0].name, detail: { teamName: team.name }
    });
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw translateTeamError(error);
  } finally {
    client.release();
  }
  res.json({ teamId: Number(req.params.id), userId, removed: true });
}));

router.use((error, req, res, next) => {
  if (error instanceof OrganizationError) {
    return res.status(error.status).json({ message: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  next(error);
});

export default router;
