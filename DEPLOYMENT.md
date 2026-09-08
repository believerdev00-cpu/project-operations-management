# Deploying to Vercel

The frontend and the API deploy together as one Vercel project. The Vite build
is served as static files; the whole Express app runs as a single serverless
function at `api/[...path].js`, so the browser keeps calling `/api/...` on the
same origin and there is no CORS to configure.

## 1. Create a Supabase Storage bucket

Uploaded evidence used to be written to `server/uploads` on local disk. Vercel
has no disk that survives a request, so on Vercel those files go to Supabase
Storage instead.

1. Supabase dashboard -> **Storage** -> **New bucket**
2. Name it `evidence`
3. Leave it **private**. Files are served through the API, which already checks
   that the caller may see the record they belong to.

## 2. Set the environment variables

In Vercel: **Project -> Settings -> Environment Variables**. Add these for
Production (and Preview, if you use preview deployments):

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase **transaction pooler** string, port **6543** |
| `JWT_SECRET` | a long random string |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase -> Settings -> API |
| `SUPABASE_STORAGE_BUCKET` | `evidence` |
| `ADMIN_PASSWORD` | only needed for the very first migration |

Two things that will bite if you skip them:

- **Use the pooler, not port 5432.** Every warm function instance holds its own
  connection, and direct Postgres connections run out fast. Copy the string from
  Supabase -> Project Settings -> Database -> Connection pooling.
- **`SUPABASE_SERVICE_ROLE_KEY` must not have a `VITE_` prefix.** Anything
  prefixed `VITE_` is compiled into the browser bundle. This key bypasses row
  level security and is read only by server code.

`CORS_ORIGIN` is not needed: the API is served from the same origin as the page.

## 3. Run the migrations once

The API does **not** migrate on boot when running on Vercel. A serverless module
is evaluated again on every cold start, and several instances racing each other
through `ALTER TABLE` is a good way to corrupt a schema.

Run it once from your machine, against the same database:

```
npm run migrate
```

Repeat this after any deploy that adds a migration. It is safe to run again --
every statement is `IF NOT EXISTS` or an idempotent update.

## 4. Deploy

Push the branch and import the repository in Vercel, or run `vercel --prod`.
`vercel.json` already sets the build command, the output directory, the function
limits and the SPA fallback, so no build settings need to be filled in by hand.

## 5. Attach a custom domain

**This step is not optional for everyone.** Some ISPs blackhole `*.vercel.app`
because it is heavily abused for phishing, and from such a connection the
deployment simply times out (`ERR_CONNECTION_TIMED_OUT`) no matter how healthy
it is. Vercel-hosted sites on custom domains are reached normally.

Vercel -> **Project -> Settings -> Domains** -> add your domain and follow the
DNS instructions. To check whether you are affected, open any
`https://<anything>.vercel.app` URL: if a name that certainly does not exist
times out instead of returning a 404 page, `*.vercel.app` is blocked for you.

## Running locally

Unchanged. Without `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` the storage
adapter writes to `server/uploads` exactly as before, and `npm run dev:server`
still migrates on boot and listens on port 5000.

```
npm run dev          # API on :5000 and the Vite client on :5173
```

## What is not solved by this

- **Rate limiting is per instance.** `express-rate-limit` keeps its counters in
  memory, so on serverless each instance counts separately and the limit is
  effectively looser than it looks. A shared store is needed for it to mean
  anything under load.
- **Cold starts.** The first request after an idle period pays for the function
  booting and opening a database connection.
- **Existing local uploads are not migrated.** Any evidence already sitting in
  `server/uploads` stays on your machine; it is not copied into the bucket.
