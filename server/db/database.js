import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { migrateMovementModule } from './movementSchema.js';
import { migrateActivityModule } from './activitySchema.js';
import { migrateMonthlyModule } from './monthlySchema.js';
import { BUSINESS_OPERATIONS } from '../../shared/businessOperations.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required. Configure PostgreSQL before starting the API.');
}
export const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  // Supabase drops idle connections, and a pooled socket that died while idle
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
// listener for 'error' throws. Supabase drops connections routinely, so a
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
    await pool.query("ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended', 'revoked'))");
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
    await pool.query(`
      CREATE OR REPLACE FUNCTION enforce_manager_sector_limit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.role = 'manager' AND NEW.sector IS NOT NULL AND
          (SELECT COUNT(*) FROM users WHERE role = 'manager' AND sector = NEW.sector AND id <> COALESCE(NEW.id, 0)) >= 3 THEN
          RAISE EXCEPTION 'A sector cannot have more than three managers';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query(`DROP TRIGGER IF EXISTS manager_sector_limit ON users`);
    await pool.query(`CREATE TRIGGER manager_sector_limit BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION enforce_manager_sector_limit()`);
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

  const userCheck = await pool.query('SELECT id FROM users WHERE username = $1', ['admin']);
  if (userCheck.rowCount === 0) {
    if (!process.env.ADMIN_PASSWORD) {
      throw new Error('ADMIN_PASSWORD is required to seed the initial admin account.');
    }
    await pool.query(
      'INSERT INTO users (username, password_hash, name, role) VALUES ($1, $2, $3, $4)',
      ['admin', bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10), 'Director Admin', 'super-admin']
    );
  } else {
    // Never re-hash the password here. Overwriting it on every boot reverted any
    // rotation and pinned the account to whatever .env happened to hold.
    // Set ADMIN_PASSWORD_RESET=true for a single deliberate recovery boot.
    await pool.query(
      "UPDATE users SET name = $2, role = 'super-admin' WHERE username = $1",
      ['admin', 'Director Admin']
    );
    if (process.env.ADMIN_PASSWORD_RESET === 'true' && process.env.ADMIN_PASSWORD) {
      await pool.query('UPDATE users SET password_hash = $2 WHERE username = $1', [
        'admin',
        bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10)
      ]);
      console.warn('ADMIN_PASSWORD_RESET is set: the admin password was reset. Unset it and restart.');
    }
  }

}
