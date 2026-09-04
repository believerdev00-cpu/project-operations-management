import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import pg from 'pg';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required. Configure PostgreSQL before starting the API.');
}

export const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

export async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sectors (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      short_name VARCHAR(50) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    INSERT INTO sectors (id, name, short_name) VALUES
      ('farming', 'Farming Activity', 'Farming'),
      ('mining', 'Mining Activity', 'Mining'),
      ('agriculture', 'Agriculture Activity', 'Agriculture'),
      ('movement', 'Movement & Facilitation', 'Movement')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name;
  `);

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
      await pool.query('ALTER TABLE approvals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()');
    await pool.query("ALTER TABLE movements ADD COLUMN IF NOT EXISTS sector VARCHAR(50) NOT NULL DEFAULT 'movement'");
    await pool.query('ALTER TABLE movements ADD COLUMN IF NOT EXISTS project_id VARCHAR(50) REFERENCES projects(id) ON DELETE SET NULL');
      await pool.query('ALTER TABLE movements ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()');
      await pool.query('ALTER TABLE movements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()');
    await pool.query("ALTER TABLE activities ADD COLUMN IF NOT EXISTS cost_cdf NUMERIC(18,2) NOT NULL DEFAULT 0");
    await pool.query('CREATE INDEX IF NOT EXISTS activities_project_created_idx ON activities(project_id, created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS projects_manager_idx ON projects(manager_id)');

  const userCheck = await pool.query('SELECT id FROM users WHERE username = $1', ['admin']);
  if (userCheck.rowCount === 0) {
    await pool.query(
      'INSERT INTO users (username, password_hash, name, role) VALUES ($1, $2, $3, $4)',
      ['admin', bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10), 'Director Admin', 'super-admin']
    );
  } else {
    await pool.query(
      'UPDATE users SET password_hash = $2, name = $3, role = $4 WHERE username = $1',
      ['admin', bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10), 'Director Admin', 'super-admin']
    );
  }

}
