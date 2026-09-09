// Temporary diagnostic: does a Vercel rewrite preserve the original request path
// on req.url? That decides whether the API can be served by a plain, non-bracket
// function instead of the catch-all that is currently mis-registering.
export default function handler(req, res) {
  const vercelHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase().startsWith('x-vercel-')) vercelHeaders[k] = v;
  }
  res.status(200).json({ ok: true, marker: 'diag-3', url: req.url, vercelHeaders });
}
