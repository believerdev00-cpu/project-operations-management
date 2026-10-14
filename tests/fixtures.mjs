// A project of their own, for the suites that need one to hang work on.
//
// WHY THIS EXISTS. Four suites posted their activities against the project ids
// 'PRJ-GISUMA' and 'PRJ-MINING'. Nothing creates those: no migration seeds a
// project, seedData.js has none, and the only INSERT INTO projects in the
// codebase is the live API route. They were rows somebody had typed into one
// development database by hand -- so those suites passed on that machine and
// failed everywhere else, including on a fresh `npm run migrate`, on a
// teammate's checkout and in CI. 63 assertions failed for want of two rows, and
// a wall of expected failures is a test suite nobody can read a regression out
// of.
//
// Every other fixture in these suites is created by the suite that needs it and
// removed in `finally`. A project is no different.

import { pool } from '../server/db/database.js';

// Ids carry the same zz marker as the accounts, so a killed run leaves
// something recognisable behind rather than a plausible-looking project.
export const PROJECT_IDS = {
  farming: 'ZZ-PRJ-FARMING',
  agriculture: 'ZZ-PRJ-AGRICULTURE',
  mining: 'ZZ-PRJ-MINING',
  movement: 'ZZ-PRJ-MOVEMENT'
};

// The row is written straight to the table rather than through POST /api/projects
// because it is scaffolding, not the thing under test -- the same reason the
// suites insert their users with bcrypt and a query instead of inviting them.
//
// Idempotent: a previous run that was killed before its cleanup leaves the row
// behind, and a suite that cannot start because of its own leftovers is the
// failure mode this whole file is about.
export async function createProject(sector, { managerId = null, name } = {}) {
  const id = PROJECT_IDS[sector];
  if (!id) throw new Error(`No test project id for the operation "${sector}"`);
  await pool.query(
    `INSERT INTO projects (id, name, sector, manager_id, location, owner, status, progress, budget, spent, category)
     VALUES ($1, $2, $3, $4, 'ZZTEST site', 'ZZTEST owner', 'On Track', 0, 100000, 0, 'ZZTEST')
     ON CONFLICT (id) DO UPDATE SET sector = EXCLUDED.sector, manager_id = EXCLUDED.manager_id`,
    [id, name || `ZZTEST ${sector} project`, sector, managerId]
  );
  return id;
}

// Called from a suite's cleanup, after its activities have gone: an activity
// references its project, so the order matters. Anything still pointing at the
// project is detached rather than deleted, because a row this suite did not
// create is not this suite's to remove.
export async function removeProject(sector) {
  const id = PROJECT_IDS[sector];
  if (!id) return;
  await pool.query('UPDATE activities SET project_id = NULL WHERE project_id = $1', [id]);
  await pool.query('UPDATE monthly_plans SET project_id = NULL WHERE project_id = $1', [id]);
  await pool.query('DELETE FROM projects WHERE id = $1', [id]);
}

// Every test project, for a suite that used more than one.
export async function removeAllProjects() {
  for (const sector of Object.keys(PROJECT_IDS)) await removeProject(sector);
}
