// Temporary deploy diagnostic. Imports nothing from ../server on purpose, so it
// answers even when DATABASE_URL is unset and the Express app cannot boot.
export default function handler(req, res) {
  res.status(200).json({ ok: true, marker: 'api-routing-fix-2', segments: 1, url: req.url });
}
