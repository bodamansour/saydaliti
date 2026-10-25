// Vercel Function: GET /api/config → public Supabase settings from environment variables.
// Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in Vercel (Project → Settings → Environment Variables).
// The publishable key is meant for browsers; access is enforced by row-level security in the database.
export default function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  res.setHeader('Cache-Control', 'no-store');
  if (!url || !key) return res.status(200).json({ configured: false });
  return res.status(200).json({ configured: true, url, key });
}
