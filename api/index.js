// The whole Express API as one Vercel function.
//
// This was api/[...path].js, a catch-all. On this project that filename
// registered as a single-segment [path].js: /api/rates reached it, /api/auth/login
// returned a platform NOT_FOUND, so signing in was impossible. A real nested
// function (/api/diag/nested) answered fine, so nesting was never the problem --
// only the catch-all was mis-registering.
//
// A plain filename plus a rewrite avoids the bracket entirely. The earlier note
// here warned that a rewrite would rewrite the path out from under the routers.
// That was measured and is not true: a rewrite to /api/index leaves req.url as
// the original /api/auth/login, so the existing routers match unchanged.
export { default } from '../server/index.js';
