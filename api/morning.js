// Vercel Cron: GET /api/morning — sends the WhatsApp morning summary (see vercel.json for the schedule).
// Vercel adds "Authorization: Bearer <CRON_SECRET>" to cron calls when CRON_SECRET is set; anything else is refused.
import { runMorning } from '../src/morning-job.js';

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const out = await runMorning({ env: process.env });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
}
