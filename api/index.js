// The whole Express API as one Vercel function.
//
// A plain filename plus a rewrite in vercel.json, rather than a catch-all
// [...path].js: on this project that filename registered as a single-segment
// route, so /api/rates worked and /api/auth/login answered a platform 404 and
// signing in was impossible. A rewrite to /api/index leaves req.url as the
// original /api/auth/login, so the routers below match unchanged.
//
// server/index.js only migrates and listens when it is the process entry point,
// so importing it here starts no server and runs no DDL: the schema is brought
// up to date by the build step (see the vercel-build script in package.json).
export { default } from '../server/index.js';
