// Temporary diagnostic: reports only WHETHER each variable is set. It never
// reads, returns, logs or otherwise exposes a value.
const KEYS = [
  'DATABASE_URL', 'JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_STORAGE_BUCKET', 'CORS_ORIGIN', 'ADMIN_PASSWORD', 'ADMIN_PASSWORD_RESET'
];
export default function handler(req, res) {
  const present = {};
  for (const key of KEYS) present[key] = Boolean(process.env[key]);
  res.status(200).json({
    ok: true,
    marker: 'diag-3',
    vercelEnv: process.env.VERCEL_ENV || null,
    present
  });
}
