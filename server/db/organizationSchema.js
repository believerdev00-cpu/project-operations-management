// The organisation: who reports to whom, the teams inside each project, and
// what an external partner is shown.
//
// THE SHAPE, as the Director drew it:
//
//   Director (super-admin)                       -- the "Super Manager"
//     ├── General Manager(s)                     -- users.role 'general-manager'
//     │     └── Project managers                 -- users.role 'manager'
//     │           └── Teams (one or more per project)          teams
//     │                 └── Team members (staff)               team_members
//     └── External partners                      -- users.role 'partner'
//           └── the operations and projects shared with them
//                                                partner_operations, partner_projects
//
// WHAT IS REUSED. "Reports to" is the existing users.manager_id -- it already
// carried a team member's manager and a manager's senior manager, with a loop
// check in the API. A project's manager is the existing projects.manager_id. A
// partner is the existing partner account with its operation grants. Nothing
// here renames or replaces a role: the Director stays 'super-admin', a project
// manager stays 'manager', a team member stays 'staff'. The General Manager is
// the one new role, because nothing that exists sees every operation without
// also being able to decide approvals.
//
// WHAT THIS IS NOT. Teams do not own activities and do not change who approves
// what: an activity is still approved through approval_required_from exactly as
// before. A team is who works on a project, which narrows what its members can
// read (see projectScope in server/lib/http.js) and who checks their finished
// work first (checkerFor in server/lib/organization.js).

// Who an account may report to, by its own role. Anything not listed is
// refused, both by the API and by the trigger below -- so an external partner
// can never be placed under the General Manager or anybody else inside, and a
// project manager can never be put under one of their own team members.
//
// A manager reporting to a manager is the "senior manager" line that existed
// before the General Manager did; it is kept so no existing assignment becomes
// invalid.
export const REPORTS_TO = {
  staff: ['manager'],
  manager: ['manager', 'general-manager'],
  'general-manager': ['super-admin'],
  'super-admin': [],
  partner: []
};

// THE BOUTIQUE MANAGER REPORTS DIRECTLY TO THE DIRECTOR. Project 5's manager
// (a `manager` whose operation is the boutique) has nobody between them and
// the Super Admin: not the General Manager, not another project manager. Their
// line is the Director's account itself, set by the API whenever such an
// account is created or moved into the boutique, and refused by the trigger
// below if anything else is written. A cashier still reports to the Boutique
// Manager, as every team member reports to a manager.
export const BOUTIQUE_MANAGER_REPORTS_TO = ['super-admin'];

export const TEAM_STATUSES = ['active', 'archived'];

// What the organisation trail records. Translated in the browser as
// org.action.* -- the server writes the word, never a sentence.
export const ORGANIZATION_ACTIONS = [
  'team_created', 'team_updated', 'team_archived', 'team_restored',
  'member_added', 'member_removed', 'leader_changed',
  'reporting_changed', 'partner_profile_changed', 'partner_projects_changed'
];

import { RETAIL_OPERATION } from '../../shared/businessOperations.js';

const inList = (values) => values.map((value) => `'${value}'`).join(', ');

const statements = [
  // ---- the partner as an organisation ---------------------------------------
  //
  // A partner account is a person; the organisation they speak for, and the
  // member of staff who looks after the relationship, are what the Director
  // needs to know who is on the other end. Both are optional and only ever set
  // on partner accounts.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS organization VARCHAR(200) NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_contact_id INTEGER REFERENCES users(id) ON DELETE SET NULL`,

  // ---- reporting lines ---------------------------------------------------------
  //
  // The API has always refused a loop and a cross-operation manager, but only
  // the API did -- a direct UPDATE could put a partner under a manager or close
  // a loop. The rule now lives in the table as well, so no path can break it.
  // It fires only when manager_id or role is written, so a row that was valid
  // before stays untouched until somebody changes its line.
  `CREATE OR REPLACE FUNCTION enforce_reporting_line()
   RETURNS trigger AS $$
   DECLARE
     boss_role TEXT;
     allowed TEXT[];
     loops BOOLEAN;
   BEGIN
     IF NEW.manager_id IS NULL THEN
       RETURN NEW;
     END IF;
     SELECT role INTO boss_role FROM users WHERE id = NEW.manager_id;
     allowed := CASE NEW.role
       WHEN 'staff' THEN ARRAY[${inList(REPORTS_TO.staff)}]
       -- The Boutique Manager (Project 5) reports to the Director and nobody
       -- else; every other project manager to a manager or the General Manager.
       WHEN 'manager' THEN CASE
         WHEN NEW.covers_all_sectors = FALSE AND (NEW.sector = '${RETAIL_OPERATION}'
              OR EXISTS (SELECT 1 FROM manager_operations mo WHERE mo.manager_id = NEW.id AND mo.sector = '${RETAIL_OPERATION}'))
           THEN ARRAY[${inList(BOUTIQUE_MANAGER_REPORTS_TO)}]
         ELSE ARRAY[${inList(REPORTS_TO.manager)}]
       END
       WHEN 'general-manager' THEN ARRAY[${inList(REPORTS_TO['general-manager'])}]
       ELSE ARRAY[]::text[]
     END;
     IF boss_role IS NULL OR NOT (boss_role = ANY(allowed)) THEN
       RAISE EXCEPTION 'A % cannot report to a %', NEW.role, COALESCE(boss_role, 'missing account')
         USING ERRCODE = 'P0001';
     END IF;
     -- Walk up from the new boss; meeting this account on the way is a loop.
     WITH RECURSIVE chain(id, depth) AS (
       SELECT NEW.manager_id, 1
       UNION ALL
       SELECT u.manager_id, chain.depth + 1 FROM users u JOIN chain ON u.id = chain.id
        WHERE u.manager_id IS NOT NULL AND chain.depth < 50
     )
     SELECT EXISTS (SELECT 1 FROM chain WHERE id = NEW.id) INTO loops;
     IF loops THEN
       RAISE EXCEPTION 'That assignment would create a reporting loop' USING ERRCODE = 'P0001';
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS users_reporting_line ON users`,
  `CREATE TRIGGER users_reporting_line BEFORE INSERT OR UPDATE OF manager_id, role ON users
     FOR EACH ROW EXECUTE FUNCTION enforce_reporting_line()`,

  // ---- teams --------------------------------------------------------------------
  //
  // A team belongs to one project. supervisor_id is the manager who leads it day
  // to day; NULL means the project's own manager does, which is the normal case
  // and follows the project when its manager changes.
  `CREATE TABLE IF NOT EXISTS teams (
     id SERIAL PRIMARY KEY,
     project_id VARCHAR(50) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     name VARCHAR(120) NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     supervisor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     status VARCHAR(20) NOT NULL DEFAULT 'active',
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT teams_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 120)
   )`,
  `ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_status_check`,
  `ALTER TABLE teams ADD CONSTRAINT teams_status_check CHECK (status IN (${inList(TEAM_STATUSES)}))`,
  // Two live teams in one project with the same name are the same team typed
  // twice. An archived team gives its name back.
  `CREATE UNIQUE INDEX IF NOT EXISTS teams_project_name_idx ON teams(project_id, lower(btrim(name))) WHERE status = 'active'`,
  `CREATE INDEX IF NOT EXISTS teams_supervisor_idx ON teams(supervisor_id)`,

  // One row per person per team. A person may sit on several teams -- in
  // different projects, or two crews in one project -- but only once on each.
  `CREATE TABLE IF NOT EXISTS team_members (
     team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     is_leader BOOLEAN NOT NULL DEFAULT FALSE,
     added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (team_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members(user_id)`,
  // A team has at most one leader. The leader is a member with a flag, not a
  // role: "team leader" is a job inside one team, not a kind of account.
  `CREATE UNIQUE INDEX IF NOT EXISTS team_members_one_leader_idx ON team_members(team_id) WHERE is_leader`,
  // Only team members (staff) sit on a team. A partner on a team would read the
  // team's project through the team-member scope, which is exactly the leak the
  // partner allowlist exists to prevent -- so the table refuses it too.
  `CREATE OR REPLACE FUNCTION enforce_team_member_role()
   RETURNS trigger AS $$
   BEGIN
     IF (SELECT role FROM users WHERE id = NEW.user_id) IS DISTINCT FROM 'staff' THEN
       RAISE EXCEPTION 'Only team members can be added to a team' USING ERRCODE = 'P0001';
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS team_members_role ON team_members`,
  `CREATE TRIGGER team_members_role BEFORE INSERT OR UPDATE ON team_members
     FOR EACH ROW EXECUTE FUNCTION enforce_team_member_role()`,

  // ---- the organisation's own trail ----------------------------------------
  //
  // Who created a team, put somebody on it or took them off, moved a reporting
  // line, or changed what a partner is shown. Names are copied onto the row so
  // the trail still reads after an account is deleted.
  `CREATE TABLE IF NOT EXISTS organization_history (
     id SERIAL PRIMARY KEY,
     action VARCHAR(40) NOT NULL,
     team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
     subject_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     subject_name VARCHAR(200) NOT NULL DEFAULT '',
     actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     actor_name VARCHAR(150) NOT NULL DEFAULT '',
     detail JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE organization_history DROP CONSTRAINT IF EXISTS organization_history_action_check`,
  `ALTER TABLE organization_history ADD CONSTRAINT organization_history_action_check
     CHECK (action IN (${inList(ORGANIZATION_ACTIONS)}))`,
  `CREATE INDEX IF NOT EXISTS organization_history_idx ON organization_history(created_at DESC)`,

  // ---- what a partner may see, project by project ---------------------------
  //
  // partner_operations grants a whole operation. A row here narrows it: once a
  // partner has any project shared in an operation, they see THAT operation's
  // records only for the projects shared, and the rest of the operation goes
  // dark to them. An operation with no row here reads exactly as before, so
  // every existing partner keeps what they had until the Director narrows it.
  `CREATE TABLE IF NOT EXISTS partner_projects (
     partner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     project_id VARCHAR(50) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (partner_id, project_id)
   )`,
  `CREATE INDEX IF NOT EXISTS partner_projects_project_idx ON partner_projects(project_id)`,

  // ---- a team member's finished work is checked by their project manager ----
  //
  // When a team member hands work back, it goes to the project manager above
  // them before the Director's final check: completion_checker_id names that
  // manager, manager_checked_at/by record that they passed it on. Work handed
  // back by a manager (or with nobody to check it) has no checker and goes
  // straight to the Director, exactly as before. Every existing row has none,
  // so nothing already waiting for the Director moves.
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS completion_checker_id INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS manager_checked_at TIMESTAMPTZ`,
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS manager_checked_by INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS activities_checker_idx ON activities(completion_checker_id)
     WHERE completion_submitted_at IS NOT NULL AND manager_checked_at IS NULL`
];

export async function migrateOrganizationModule(pool) {
  for (const statement of statements) {
    await pool.query(statement);
  }
}
