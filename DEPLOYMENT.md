# Deploying

The whole system is one Node process and one Postgres database. The process
serves the API and the built interface on the same port, and uploaded evidence
is stored on its own disk in `server/uploads` (or wherever `UPLOADS_DIR` points).

## On Render (the recommended host)

`render.yaml` describes everything: the web service, a managed Postgres, and a
5 GB disk for receipts and photos, all in Frankfurt (the closest region to
Rwanda). Nothing needs to change in the code.

1. Create a Render account at https://render.com and connect it to GitHub.
2. **New -> Blueprint**, pick the `project-operations-management` repository.
3. Render asks for **ADMIN_PASSWORD**: type a starting password for the `admin`
   Director account. Everything else is filled in by the Blueprint
   (`JWT_SECRET` is generated for you).
4. **Apply**. The first deploy builds the interface, creates the database
   tables on boot, and gives the service an address like
   `https://gisuma-operations.onrender.com`.
5. Open it, sign in as `admin` with that starting password, and choose your own
   password when asked.

Every push to `master` deploys again automatically. Cost at the time of
writing: the Starter web service (needed for the disk) plus the smallest paid
database, roughly US$13 a month. The free database is deleted after 30 days, so
it is not used.

Backups: Render keeps daily database backups on paid plans; download the disk's
files from the service's Shell if you need a copy of the receipts.

A custom domain (for example `ops.gisuma.rw`) is added under the service's
**Settings -> Custom Domains**; Render issues the HTTPS certificate.

## On your own machine or server

## 1. Postgres

**Windows (what this machine uses):** PostgreSQL 16 installed as the Windows
service `postgresql-x64-16`, listening on port **5433**. It starts with Windows.

```
winget install --id PostgreSQL.PostgreSQL.16 -e --override "--mode unattended --superpassword <choose one> --serverport 5433"
```

Then create the application's own login and database (the `postgres` superuser
is only for administration; the app never uses it):

```
"C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -p 5433 -h localhost
CREATE ROLE ops LOGIN PASSWORD '<app password>';
CREATE DATABASE project_ops OWNER ops;
```

**Anywhere with Docker:** `docker compose up -d` runs the same thing on the same
port, with the credentials in `docker-compose.yml`.

## 2. Configure

Copy `.env.example` to `.env.local` and set at least:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `postgresql://ops:<app password>@localhost:5433/project_ops?sslmode=disable` |
| `JWT_SECRET` | at least 32 random characters (changing it signs everybody out) |
| `ADMIN_PASSWORD` | the starting password for `admin`, used once by the first migration |
| `PORT` | defaults to 5000 |
| `TRUST_PROXY` | only behind a reverse proxy: the number of proxies, usually `1` |

Keep `?sslmode=disable` only for a Postgres on the same machine. `CORS_ORIGIN`
is not needed in production: the page and the API share one origin.

**First sign-in.** Sign in as `admin` with `ADMIN_PASSWORD`; the app asks the
Director to choose their own password straight away. Every account the Director
creates or resets works the same way, so nobody else ever knows a user's
password.

## 3. Build and run

```
npm ci
npm run build        # writes dist/
npm start            # migrates the schema, then serves API + interface on PORT
```

Migrations run on every boot and are idempotent. `npm run migrate` does the same
without starting the server. Keep the process alive with whatever the host uses
(pm2, NSSM or a scheduled task on Windows, a systemd unit on Linux), and put a
reverse proxy with HTTPS in front of it for anything reachable beyond your own
network.

## 4. Back up

Two things hold the data, and they must be backed up together:

- **The database:**
  `"C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" -U ops -h localhost -p 5433 -Fc project_ops -f backup.dump`
  (restore with `pg_restore -U ops -h localhost -p 5433 -d project_ops --clean backup.dump`)
- **`server/uploads`**: the evidence files. The database only records their
  names; losing this folder leaves every evidence link answering 404.

## Running locally

```
npm run dev          # API on :5000 and the Vite client on :5173
```

## What is not solved by this

- **Rate limiting is per process.** `express-rate-limit` keeps its counters in
  memory, so they reset on restart and are not shared between several copies of
  the server.
