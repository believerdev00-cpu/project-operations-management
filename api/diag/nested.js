// Temporary deploy diagnostic. A real two-segment function: if this answers but
// /api/auth/login does not, nested routing works and the catch-all is at fault.
export default function handler(req, res) {
  res.status(200).json({ ok: true, marker: 'api-routing-fix-2', segments: 2, url: req.url });
}
