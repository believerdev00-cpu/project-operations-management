// The whole Express API as one Vercel function.
//
// The filename is a catch-all, so Vercel routes every /api/... request here
// with the original path left on req.url -- which is what lets the existing
// Express routers match unchanged. A rewrite would have rewritten the path out
// from under them.
export { default } from '../server/index.js';
