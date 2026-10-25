import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { migrateMovementModule } from './movementSchema.js';
import { migrateActivityModule } from './activitySchema.js';
import { migrateMonthlyModule } from './monthlySchema.js';
import { migrateOrganizationModule } from './organizationSchema.js';
import { migrateBoutiqueModule } from './boutiqueSchema.js';
import { migrateFarmingModule } from './farmingSchema.js';
import { BUSINESS_OPERATIONS } from '../../shared/businessOperations.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required. Configure PostgreSQL before starting the API.');
}
// TLS is on unless the URL opts out. A Postgres on this machine has no
// certificate and says so with sslmode=disable (or
// DATABASE_SSL=false); a database reached over a network should keep TLS.
const sslDisabled = /[?&]sslmode=disable\b/.test(connectionString) || process.env.DATABASE_SSL === 'false';

export const pool = new Pool({
  connectionString,
  ssl: sslDisabled ? false : {
    rejectUnauthorized: false
  },
  // Idle connections get dropped (by the network, a firewall, a restarted
  // database), and a pooled socket that died while idle
  // surfaces as ECONNRESET on the next query -- which looked to users like
  // "Server or database error" on the login screen. Keepalives hold the socket
  // open, and a short idle timeout retires it before the far end does.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  // A serverless instance handles one request at a time, so it needs one
  // connection. Ten per instance would exhaust Postgres the moment a handful of
  // instances went warm at once; a long-running server still wants the pool.
  max: process.env.VERCEL ? 1 : 10
});

// Without a listener, an error raised on an *idle* client is an unhandled
// 'error' event on the pool, which takes the whole API process down.
pool.on('error', (error) => {
  console.error('Idle database client error (connection discarded):', error.message);
});

// The pool's own 'error' event only covers clients sitting idle in the pool. A
// client checked out with pool.connect() -- which every transaction in this API
// uses -- emits 'error' on the client itself, and an EventEmitter with no
// listener for 'error' throws. Connections do get dropped, so a
// dropped socket mid-transaction was taking the whole process down with an
// unhandled 'error' event rather than failing the one request.
//
// Attaching a listener at connect time covers the client for its whole life, in
// the pool and out of it. pg still discards the broken connection and still
// rejects the in-flight query, so the route's catch/ROLLBACK path runs as usual
// and the caller gets a 500 instead of the server dying.
pool.on('connect', (client) => {
  client.on('error', (error) => {
    console.error('Database client error (connection discarded):', error.message);
  });
});

// A connection that died while parked in the pool fails before the statement is
// ever sent, so one retry on a fresh connection is safe and invisible to the
// caller. Anything the database itself rejected is rethrown untouched.
const runQuery = pool.query.bind(pool);
const staleConnectionCodes = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND']);

function isStaleConnection(error) {
  return staleConnectionCodes.has(error?.code)
    || /Connection terminated|connection is closed|server closed the connection/i.test(error?.message || '');
}

pool.query = async (...args) => {
  try {
    return await runQuery(...args);
  } catch (error) {
    if (!isStaleConnection(error)) throw error;
    console.warn('Retrying query on a fresh connection after:', error.message);
    return runQuery(...args);
  }
};
// Rolling back on a connection that has already died throws again, and that
// second error replaces the real one in the catch block that called it -- so the
// caller is told "Connection terminated" when the actual failure was a
// constraint violation. The transaction is dead either way: a broken connection
// never committed anything.
export async function safeRollback(client) {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    console.warn('Rollback skipped on a dead connection:', error.message);
  }
}

export async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sectors (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      short_name VARCHAR(50) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // The four business operations, named from shared/businessOperations.js so
  // the table, the API and the browser cannot drift apart. The ids are the ones
  // already referenced by every foreign key, so only the names are refreshed.
  await pool.query(
    `INSERT INTO sectors (id, name, short_name)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[])
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name`,
    [
      BUSINESS_OPERATIONS.map((operation) => operation.id),
      BUSINESS_OPERATIONS.map((operation) => operation.name),
      BUSINESS_OPERATIONS.map((operation) => operation.shortName)
    ]
  );

  await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name VARCHAR(150) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'manager',
        sector VARCHAR(50) REFERENCES sectors(id),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        sector VARCHAR(50) NOT NULL DEFAULT 'agriculture',
        manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        location VARCHAR(200) NOT NULL,
        owner VARCHAR(200) NOT NULL,
        status VARCHAR(50) NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        budget NUMERIC(18,2) NOT NULL,
        spent NUMERIC(18,2) NOT NULL,
        category VARCHAR(100) NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS approvals (
        id VARCHAR(50) PRIMARY KEY,
          project_id VARCHAR(50) REFERENCES projects(id) ON DELETE SET NULL,
          title VARCHAR(200) NOT NULL,
        sector VARCHAR(50) NOT NULL DEFAULT 'agriculture',
        amount NUMERIC(18,2) NOT NULL,
        owner VARCHAR(150) NOT NULL,
        priority VARCHAR(50) NOT NULL,
        status VARCHAR(50) NOT NULL,
        requested_by VARCHAR(150) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS movements (
        id VARCHAR(50) PRIMARY KEY,
          project_id VARCHAR(50) REFERENCES projects(id) ON DELETE SET NULL,
          ref VARCHAR(100) NOT NULL,
        sector VARCHAR(50) NOT NULL DEFAULT 'movement',
        purpose VARCHAR(200) NOT NULL,
        destination VARCHAR(200) NOT NULL,
        status VARCHAR(50) NOT NULL,
        cost NUMERIC(18,2) NOT NULL,
          category VARCHAR(100) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS activities (
        id VARCHAR(50) PRIMARY KEY,
        project_id VARCHAR(50) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        sector VARCHAR(50) NOT NULL,
        category VARCHAR(100) NOT NULL,
        activity VARCHAR(200) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        quantity NUMERIC(18,2) NOT NULL DEFAULT 0,
        cost_usd NUMERIC(18,2) NOT NULL DEFAULT 0,
        cost_rwf NUMERIC(18,2) NOT NULL DEFAULT 0,
        cost_cdf NUMERIC(18,2) NOT NULL DEFAULT 0,
        signed BOOLEAN NOT NULL DEFAULT FALSE,
        approved BOOLEAN NOT NULL DEFAULT FALSE,
        status VARCHAR(50) NOT NULL DEFAULT 'Pending',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS sector VARCHAR(50) NOT NULL DEFAULT 'agriculture'");
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS sector VARCHAR(50) REFERENCES sectors(id)');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()');
    // Stamped when the Director resets a password, so tokens minted before the
    // reset stop working instead of outliving it for up to 12 hours. It must be
    // TIMESTAMPTZ: as a bare TIMESTAMP the driver reads the stored UTC value as
    // local time, which pushes it into the future and rejects valid new tokens.
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE users ALTER COLUMN password_changed_at TYPE TIMESTAMPTZ');
    // Set whenever a password was chosen by somebody other than its owner: the
    // seeded Director, and every account the Director creates or resets. Until
    // the owner picks their own, authMiddleware lets the account reach nothing
    // but the password route -- otherwise the Director knew every password, and
    // could sign in as a manager to approve their own request.
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE');
    // Who a user reports to. A sector manager reports to nobody; a team member
    // reports to one of the managers working the same sector. Pointing an
    // account at itself is refused here; longer loops are refused by the API.
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL');

    // ---- external business partner accounts ---------------------------------
    //
    // An external partner is an ordinary row in `users` with role 'partner' and
    // exactly one business operation in `sector`. Reusing the account table
    // means one authentication path, one password policy and one place a
    // Director looks -- rather than a parallel identity system.
    //
    // `status` gates sign-in for every account, not only partners, so suspend
    // and revoke are real rather than a hidden menu item: authMiddleware turns
    // anything other than 'active' into a refusal on the very next request.
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'");
    await pool.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check');
    await pool.query("ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended', 'revoked', 'deleted'))");
    // A DELETED account (DELETE /api/users/:id) that still has history behind it:
    // it can never sign in again, it is gone from every list, and its name stays
    // on the records it made so they still say who did the work. When and by
    // whom it was deleted is kept on the row itself.
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)');
    // View-only is the only level an external partner is ever given; the
    // partner routes set it explicitly. The default is 'internal' because every
    // other way an account is created -- the account register, the seeded
    // Director -- makes an internal user, and a default of 'view-only' would
    // quietly label new managers as external.
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS access_level VARCHAR(20) NOT NULL DEFAULT 'internal'");
    await pool.query("ALTER TABLE users ALTER COLUMN access_level SET DEFAULT 'internal'");
    await pool.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_access_level_check');
    await pool.query("ALTER TABLE users ADD CONSTRAINT users_access_level_check CHECK (access_level IN ('view-only', 'internal'))");
    // A partner must always have exactly one operation to be scoped to. An
    // account with none would fall through every sector filter.
    await pool.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_partner_needs_operation');
    await pool.query(`ALTER TABLE users ADD CONSTRAINT users_partner_needs_operation
      CHECK (role <> 'partner' OR sector IS NOT NULL)`);
    await pool.query("CREATE INDEX IF NOT EXISTS users_partner_idx ON users(role, sector) WHERE role = 'partner'");
    // Internal staff keep the internal access level; only partners are view-only.
    await pool.query("UPDATE users SET access_level = 'internal' WHERE role <> 'partner' AND access_level <> 'internal'");
    await pool.query("UPDATE users SET access_level = 'view-only' WHERE role = 'partner' AND access_level <> 'view-only'");
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_manager_not_self') THEN
          ALTER TABLE users ADD CONSTRAINT users_manager_not_self CHECK (manager_id IS DISTINCT FROM id);
        END IF;
      END $$;
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS users_manager_idx ON users(manager_id)');
    // A manager normally covers exactly one business operation, named in `sector`.
    // This flag lifts that to all of them, which is what a single-manager setup
    // needs: one account carries every operation instead of one account per
    // operation. It widens what the account can SEE and be handed, and nothing
    // else -- assigning work and deciding approvals stay with the Director.
    //
    // `sector` is left NULL on such an account. It is a foreign key into
    // sectors(id), so there is no in-band value like 'all' to put there, and a
    // NULL plus this flag says "every operation" without inventing a fake row.
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS covers_all_sectors BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_covers_all_is_manager');
    await pool.query(`ALTER TABLE users ADD CONSTRAINT users_covers_all_is_manager
      CHECK (covers_all_sectors = FALSE OR (role = 'manager' AND sector IS NULL))`);
    // The first-boot form of the limit. It is replaced further down, once
    // manager_operations exists, by the version that counts a manager's every
    // operation; it stays here because the trigger needs a function to exist.
    await pool.query(`
      CREATE OR REPLACE FUNCTION enforce_manager_sector_limit()
      RETURNS trigger AS $$
      BEGIN
        -- Closing an account (status deleted) never adds a manager, so it is
        -- never refused here -- in an operation already holding three, the
        -- rule used to block the very delete that would bring it down to two.
        IF NEW.role = 'manager' AND NEW.status <> 'deleted' AND NEW.sector IS NOT NULL AND
          (SELECT COUNT(*) FROM users WHERE role = 'manager' AND status <> 'deleted' AND sector = NEW.sector AND id <> COALESCE(NEW.id, 0)) >= 3 THEN
          RAISE EXCEPTION 'A sector cannot have more than three managers';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query(`DROP TRIGGER IF EXISTS manager_sector_limit ON users`);
    // Only when a manager can actually be ADDED to an operation: a new account,
    // or a change of role or operation. It used to fire on every update of the
    // row, so in an operation already holding more managers than the limit
    // (data from before the rule) none of them could be suspended, given a new
    // password, moved off a team or deleted -- the update was refused by a
    // rule it had nothing to do with.
    await pool.query(`CREATE TRIGGER manager_sector_limit BEFORE INSERT OR UPDATE OF role, sector ON users FOR EACH ROW EXECUTE FUNCTION enforce_manager_sector_limit()`);
    await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()');
    await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()');
    await pool.query("ALTER TABLE approvals ADD COLUMN IF NOT EXISTS sector VARCHAR(50) NOT NULL DEFAULT 'agriculture'");
    await pool.query('ALTER TABLE approvals ADD COLUMN IF NOT EXISTS project_id VARCHAR(50) REFERENCES projects(id) ON DELETE SET NULL');
    await pool.query('ALTER TABLE approvals ADD COLUMN IF NOT EXISTS requested_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
      await pool.query('ALTER TABLE approvals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()');
    // A manager raises a need ("the site needs a perimeter fence") and the
    // Director decides it. These columns carry the case for the request and the
    // record of who decided, so the outcome is auditable rather than a bare status.
    await pool.query("ALTER TABLE approvals ADD COLUMN IF NOT EXISTS justification TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decision_note TEXT NOT NULL DEFAULT ''");
    await pool.query('ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decided_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    await pool.query('ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decided_at TIMESTAMP');
    await pool.query("ALTER TABLE movements ADD COLUMN IF NOT EXISTS sector VARCHAR(50) NOT NULL DEFAULT 'movement'");
    await pool.query('ALTER TABLE movements ADD COLUMN IF NOT EXISTS project_id VARCHAR(50) REFERENCES projects(id) ON DELETE SET NULL');
      await pool.query('ALTER TABLE movements ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()');
      await pool.query('ALTER TABLE movements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()');
    await pool.query("ALTER TABLE activities ADD COLUMN IF NOT EXISTS cost_cdf NUMERIC(18,2) NOT NULL DEFAULT 0");
    await pool.query('CREATE INDEX IF NOT EXISTS activities_project_created_idx ON activities(project_id, created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS projects_manager_idx ON projects(manager_id)');

    await migrateMovementModule(pool);
    await migrateActivityModule(pool);
    // Monthly planning sits on top of the activity register, so it migrates last.
    await migrateMonthlyModule(pool);

    // ---- what an external partner may follow ---------------------------------
    //
    // A partner may follow more than one business operation. Each operation
    // they may read is one row here, granted by the Director; nothing else
    // widens what a partner sees. users.sector stays as the partner's first
    // operation -- so users_partner_needs_operation still guarantees at least
    // one -- and the partner routes always keep it among the grants.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS partner_operations (
        partner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sector VARCHAR(50) NOT NULL REFERENCES sectors(id) ON DELETE CASCADE,
        granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (partner_id, sector)
      )
    `);
    // Every partner that predates the table keeps exactly the operation it had.
    // Safe to run again: an existing grant is left alone.
    await pool.query(`
      INSERT INTO partner_operations (partner_id, sector)
      SELECT id, sector FROM users WHERE role = 'partner' AND sector IS NOT NULL
      ON CONFLICT DO NOTHING
    `);

    // ---- invitations ---------------------------------------------------------
    //
    // The one-time link an invited partner opens to choose their own password
    // (server/lib/invitations.js). Only the token's SHA-256 is kept, so this
    // table cannot be read back into working links.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS account_invitations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        emailed_at TIMESTAMPTZ,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS account_invitations_user ON account_invitations (user_id)');

    // ---- the operations a manager runs ------------------------------------------
    //
    // One person can manage Mining and Agriculture at the same time. Before this
    // a manager had exactly one operation (users.sector) or every one of them
    // (covers_all_sectors), so the only way to give someone two was to give them
    // all four. Each operation a manager runs is one row here, set by the
    // Director; users.sector stays as the first of them, exactly as it does for
    // a partner, so every query that still reads the single column keeps a real
    // operation the manager holds. An all-operations manager has no rows: the
    // flag already says "every one".
    await pool.query(`
      CREATE TABLE IF NOT EXISTS manager_operations (
        manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sector VARCHAR(50) NOT NULL REFERENCES sectors(id) ON DELETE CASCADE,
        granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (manager_id, sector)
      )
    `);
    // The three-managers-per-operation limit counted users.sector alone, so a
    // fourth manager could join Mining as somebody's second operation. It now
    // counts every manager holding the operation by either route.
    //
    // Each table has its OWN function. They used to share
    // enforce_manager_sector_limit, but the first-boot block above rewrites that
    // function in its users-only form on every migration, so on any database
    // migrated before, the backfill below fired the manager_operations trigger
    // with a body that reads NEW.role -- "record "new" has no field "role"" --
    // and the Vercel build failed on the live data while an empty test
    // database passed. Nothing earlier in this file touches the function below.
    const countHolders = (idExpr, sectorExpr) => `
      (SELECT COUNT(*) FROM users u
        WHERE u.role = 'manager' AND u.status <> 'deleted' AND u.id <> ${idExpr}
          AND (u.sector = ${sectorExpr}
               OR EXISTS (SELECT 1 FROM manager_operations mo
                           WHERE mo.manager_id = u.id AND mo.sector = ${sectorExpr}))) >= 3`;
    await pool.query(`
      CREATE OR REPLACE FUNCTION enforce_manager_operations_limit()
      RETURNS trigger AS $$
      BEGIN
        IF ${countHolders('NEW.manager_id', 'NEW.sector')} THEN
          RAISE EXCEPTION 'A sector cannot have more than three managers';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query('DROP TRIGGER IF EXISTS manager_operations_limit ON manager_operations');
    await pool.query(`CREATE TRIGGER manager_operations_limit BEFORE INSERT OR UPDATE ON manager_operations
      FOR EACH ROW EXECUTE FUNCTION enforce_manager_operations_limit()`);
    // Every manager that predates the table keeps exactly the operation it had.
    // After the trigger, so a backfill row is checked like any other.
    await pool.query(`
      INSERT INTO manager_operations (manager_id, sector)
      SELECT id, sector FROM users WHERE role = 'manager' AND sector IS NOT NULL AND covers_all_sectors = FALSE
      ON CONFLICT DO NOTHING
    `);
    // The users trigger keeps its own function, now counting both routes.
    // This is the definition in force (it replaces the first-boot one above
    // on every migration). Closing an account (status deleted) never adds a
    // manager, so it is never refused: in an operation already over the
    // limit -- data from before the rule -- this blocked the very delete that
    // brings the count down.
    await pool.query(`
      CREATE OR REPLACE FUNCTION enforce_manager_sector_limit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.role = 'manager' AND NEW.status <> 'deleted' AND NEW.sector IS NOT NULL AND ${countHolders('COALESCE(NEW.id, 0)', 'NEW.sector')} THEN
          RAISE EXCEPTION 'A sector cannot have more than three managers';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ---- a partner's comments to the Director ---------------------------------
    //
    // A partner's question or remark about an operation they follow, addressed
    // to the Director and nobody else, and the Director's answers. Its own
    // table on purpose: nothing internal -- admin notes, rejection reasons, the
    // audit trail -- lives here, so no query on it can carry an internal note
    // out to a partner, and no manager route reads it.
    //
    // A thread is the row with parent_id NULL, opened by the partner; replies
    // hang off it. partner_id names the thread's partner on every row, so
    // "this partner's threads" is one indexed predicate.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS partner_comments (
        id SERIAL PRIMARY KEY,
        partner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sector VARCHAR(50) NOT NULL REFERENCES sectors(id),
        subject_type VARCHAR(20) NOT NULL DEFAULT 'operation',
        subject_id VARCHAR(50),
        parent_id INTEGER REFERENCES partner_comments(id) ON DELETE CASCADE,
        author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        author_name VARCHAR(150) NOT NULL DEFAULT '',
        author_role VARCHAR(20) NOT NULL,
        body TEXT NOT NULL,
        read_by_director_at TIMESTAMPTZ,
        read_by_partner_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT partner_comments_subject_check CHECK (subject_type IN ('operation', 'activity', 'movement')),
        CONSTRAINT partner_comments_subject_id_check CHECK ((subject_type = 'operation') = (subject_id IS NULL)),
        CONSTRAINT partner_comments_author_check CHECK (author_role IN ('partner', 'super-admin')),
        CONSTRAINT partner_comments_body_check CHECK (char_length(body) BETWEEN 1 AND 2000)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS partner_comments_partner_idx ON partner_comments(partner_id, created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS partner_comments_parent_idx ON partner_comments(parent_id)');
    await pool.query(`CREATE INDEX IF NOT EXISTS partner_comments_unread_idx ON partner_comments(read_by_director_at)
      WHERE author_role = 'partner' AND read_by_director_at IS NULL`);

    // ---- a project's discussion ----------------------------------------------
    //
    // The same table, extended rather than doubled: a thread may now belong to
    // a PROJECT shared with the partner (project_id), about the project as a
    // whole, one of its monthly plans, or one of its activities. Those threads
    // are the project's discussion: every partner the project is shared with
    // and the internal people responsible for it read them, and the project's
    // manager answers as well as the Director (author_role 'manager'). A
    // thread is open until somebody internal marks it answered (resolved_*).
    // Older threads -- project_id NULL -- stay exactly what they were: a
    // partner's message to the Director about an operation.
    //
    // Additive only: three columns and wider CHECKs. No existing row changes.
    await pool.query('ALTER TABLE partner_comments ADD COLUMN IF NOT EXISTS project_id VARCHAR(50) REFERENCES projects(id) ON DELETE SET NULL');
    await pool.query('ALTER TABLE partner_comments ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE partner_comments ADD COLUMN IF NOT EXISTS resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
    await pool.query("ALTER TABLE partner_comments ADD COLUMN IF NOT EXISTS resolved_by_name VARCHAR(150) NOT NULL DEFAULT ''");
    await pool.query('ALTER TABLE partner_comments DROP CONSTRAINT IF EXISTS partner_comments_subject_check');
    await pool.query(`ALTER TABLE partner_comments ADD CONSTRAINT partner_comments_subject_check
      CHECK (subject_type IN ('operation', 'activity', 'movement', 'project', 'plan'))`);
    await pool.query('ALTER TABLE partner_comments DROP CONSTRAINT IF EXISTS partner_comments_subject_id_check');
    await pool.query(`ALTER TABLE partner_comments ADD CONSTRAINT partner_comments_subject_id_check
      CHECK ((subject_type IN ('operation', 'project')) = (subject_id IS NULL))`);
    await pool.query('ALTER TABLE partner_comments DROP CONSTRAINT IF EXISTS partner_comments_author_check');
    await pool.query(`ALTER TABLE partner_comments ADD CONSTRAINT partner_comments_author_check
      CHECK (author_role IN ('partner', 'super-admin', 'manager'))`);
    await pool.query('CREATE INDEX IF NOT EXISTS partner_comments_project_idx ON partner_comments(project_id, created_at DESC) WHERE project_id IS NOT NULL');

    // The organisation -- reporting lines, teams, the work check and what each
    // partner is shown project by project -- hangs off users, projects,
    // activities and the partner grants above, so it migrates after all of them.
    await migrateOrganizationModule(pool);

    // The Boutique Management System (Project 5): the shop's own tables and
    // the PRJ-BOUTIQUE project row. After the organisation, because the
    // project row it seeds is what the Projects page and the teams refer to.
    await migrateBoutiqueModule(pool);

    // Farming Management: the farm's animal types, production, herd, sales,
    // expenses, issues, budget and history. Its own tables only -- the
    // farming monthly plan and its activities are left exactly as they are.
    await migrateFarmingModule(pool);

  // The Director is identified by the role, not by a fixed username. Keyed on
  // username = 'admin', renaming that account -- which its owner is free to do
  // from User management -- made the next boot conclude no Director existed and
  // seed a second one alongside it.
  //
  // The display name is not written back either, for the same reason: it is the
  // owner's to set, and forcing 'Director Admin' on every boot silently undid
  // any rename.
  const director = await pool.query(
    "SELECT id, password_hash, password_changed_at FROM users WHERE role = 'super-admin' ORDER BY id LIMIT 1"
  );
  if (director.rowCount === 0) {
    if (!process.env.ADMIN_PASSWORD) {
      throw new Error('ADMIN_PASSWORD is required to seed the initial admin account.');
    }
    // The seed password sits in a file on disk, so it is only good for the first
    // sign-in: the Director is sent straight to choosing their own.
    await pool.query(
      'INSERT INTO users (username, password_hash, name, role, must_change_password) VALUES ($1, $2, $3, $4, TRUE)',
      ['admin', bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10), 'Director Admin', 'super-admin']
    );
  } else if (process.env.ADMIN_PASSWORD_RESET === 'true' && process.env.ADMIN_PASSWORD) {
    // Never re-hash the password on an ordinary boot. Overwriting it every time
    // reverted any rotation and pinned the account to whatever .env happened to
    // hold. Set ADMIN_PASSWORD_RESET=true for a single deliberate recovery boot,
    // which acts on whichever account currently holds the role.
    //
    // A recovery reset is usually done because the account may be in the wrong
    // hands, so it also ends every session issued before it and asks for a new
    // password at the next sign-in.
    await pool.query('UPDATE users SET password_hash = $2, password_changed_at = $3, must_change_password = TRUE WHERE id = $1', [
      director.rows[0].id,
      bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10),
      new Date()
    ]);
    console.warn('ADMIN_PASSWORD_RESET is set: the Director password was reset. Unset it and restart.');
  } else if (process.env.ADMIN_PASSWORD && !director.rows[0].password_changed_at
    && await bcrypt.compare(process.env.ADMIN_PASSWORD, director.rows[0].password_hash)) {
    // A Director seeded before the rule above existed, still on the password
    // from the env file (admin123 in the example), is asked to change it too.
    await pool.query('UPDATE users SET must_change_password = TRUE WHERE id = $1', [director.rows[0].id]);
  }

}
