// Pure helpers for shortages, market prices and patient reminders — no DOM, no network.
import { addDays, startOfDay } from './core.js';

const DAY = 86400000;
const toDay = (v) => startOfDay(typeof v === 'string' ? new Date(`${v.slice(0, 10)}T00:00:00`) : v);

// ---------- Market shortages ----------
// For each active shortage, how much is on the shelf, how long it lasts, and how much to stock up
// (enough for `cover` days, longer than a normal order because the item is hard to get).
export function shortagePlan(shortages, rows, { cover = 60 } = {}) {
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const byName = new Map(rows.map((r) => [r.name.trim(), r]));
  return shortages.filter((s) => s.status !== 'resolved').map((s) => {
    const r = (s.code && byCode.get(s.code)) || byName.get(String(s.name).trim()) || null;
    if (!r) return { ...s, found: false };
    const stockUp = r.rate > 0 ? Math.max(0, Math.ceil(r.rate * cover - r.qty)) : 0;
    return { ...s, found: true, row: r, qty: r.qty, daysCover: r.daysCover, stockUp, cost: stockUp * r.cost };
  }).sort((a, b) => (a.found === b.found ? (a.daysCover ?? Infinity) - (b.daysCover ?? Infinity) : a.found ? -1 : 1));
}

// ---------- Market prices ----------
// Cheapest price seen per item in the last `days` days (older sightings are ignored, prices move).
export function cheapestSeen(prices, today = startOfDay(), days = 45) {
  const from = addDays(today, -days);
  const out = new Map();
  for (const p of prices) {
    if (p.deleted || !(+p.price > 0)) continue;
    if (toDay(p.seen_on) < from) continue;
    const cur = out.get(p.code);
    if (!cur || +p.price < +cur.price || (+p.price === +cur.price && p.seen_on > cur.seen_on)) out.set(p.code, p);
  }
  return out;
}

// My price vs the market, for items that have a sighting.
export function priceCompare(rows, cheapest) {
  return rows.filter((r) => cheapest.has(r.code)).map((r) => {
    const m = cheapest.get(r.code);
    const diff = r.price - +m.price;
    return { ...r, market: +m.price, source: m.source, seenOn: m.seen_on, diff, pct: r.price > 0 ? (diff / r.price) * 100 : 0 };
  }).sort((a, b) => b.pct - a.pct);
}

// ---------- Patient reminders ----------
// Cairo local clock for a moment in time: { date: 'yyyy-mm-dd', minutes: minutes since midnight }.
export function cairoClock(now, tz = 'Africa/Cairo') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: +parts.hour * 60 + +parts.minute };
}

export function parseTimes(text) {
  const out = [];
  const ar = '٠١٢٣٤٥٦٧٨٩';
  const t = String(text ?? '').replace(/[٠-٩]/g, (c) => ar.indexOf(c));
  for (const m of t.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(ص|م|am|pm)?/gi)) {
    let h = +m[1]; const min = +(m[2] || 0); const ap = (m[3] || '').toLowerCase();
    if (ap === 'م' || ap === 'pm') { if (h < 12) h += 12; } else if ((ap === 'ص' || ap === 'am') && h === 12) h = 0;
    if (h > 23 || min > 59) continue;
    out.push(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
  }
  return [...new Set(out)].sort();
}
export const DOSE_WINDOW_MIN = 90;
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Which reminders should go out now. The job runs about once an hour but GitHub can start it late,
// so a dose is due when its time passed within the last 90 minutes and nothing was sent since.
// (A late run still sends; a dose is never sent twice.) A refill reminder goes out the day before
// the refill date (or any later day if it was missed), once per refill.
export function dueReminders(reminders, now = new Date(), tz = 'Africa/Cairo') {
  const { date, minutes } = cairoClock(now, tz);
  const due = [];
  for (const r of reminders) {
    if (r.active === false) continue;
    const last = r.last_sent_at ? new Date(r.last_sent_at) : null;
    if (r.kind === 'dose') {
      for (const t of r.dose_times || []) {
        const diff = minutes - toMin(t);
        if (diff < 0 || diff >= DOSE_WINDOW_MIN) continue;
        const doseAt = new Date(now.getTime() - diff * 60000);
        if (!last || last < new Date(doseAt.getTime() - 60000)) { due.push({ ...r, dueTime: t }); break; }
      }
    } else if (r.kind === 'refill' && r.next_refill) {
      const remindOn = addDays(toDay(r.next_refill), -1);
      const today = toDay(date);
      if (today < remindOn) continue;
      const lastDay = last ? toDay(cairoClock(last, tz).date) : null;
      if (!lastDay || lastDay < remindOn) due.push(r);
    }
  }
  return due;
}

// Next refill date after a reminder went out: one interval later, and in the future.
export function advanceRefill(nextRefill, everyDays, today) {
  const step = Math.max(1, +everyDays || 30);
  let d = addDays(toDay(nextRefill), step);
  while (d <= toDay(today)) d = addDays(d, step);
  return d;
}

export const daysBetween = (a, b) => Math.round((toDay(b) - toDay(a)) / DAY);
