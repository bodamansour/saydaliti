// GET /api/reminders — sends due patient reminders on WhatsApp (dose times and refills).
// Called about once an hour by .github/workflows/reminders.yml with "Authorization: Bearer <CRON_SECRET>".
import { runReminders } from '../src/reminders-job.js';

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    return res.status(200).json(await runReminders({ env: process.env }));
  } catch (e) {
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
}
