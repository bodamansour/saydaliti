// A pharmacy's subscription: free trial, paid until a date, free (the app owner's own pharmacies),
// or suspended. Pure: what to tell the owner, and whether the dashboard is locked.
// The cashier is never locked: a pharmacy must always be able to sell to a patient.
const DAY = 86400000;
const day = (v) => { const d = new Date(`${String(v).slice(0, 10)}T00:00:00`); return Number.isNaN(d.getTime()) ? null : d; };
const daysBetween = (a, b) => Math.round((b - a) / DAY);

// sub: { status, trial_ends, paid_until } | null; config: { grace_days }; today: Date at 00:00.
// → { level: 'ok' | 'info' | 'warn' | 'expired' | 'locked', days, until, text }
export function subscriptionState(sub, config = {}, today = new Date(new Date().setHours(0, 0, 0, 0))) {
  if (!sub || sub.status === 'free') return { level: 'ok', text: '' };
  if (sub.status === 'suspended') return { level: 'locked', text: 'الاشتراك موقوف. كلّمنا عشان نرجّعه.' };
  const grace = Math.max(0, +config.grace_days || 0);
  const end = day(sub.status === 'trial' ? sub.trial_ends : sub.paid_until);
  if (!end) return { level: 'ok', text: '' };
  const left = daysBetween(today, end); // days until the last day (0 = today is the last day)
  const what = sub.status === 'trial' ? 'التجربة المجانية' : 'الاشتراك';
  if (left >= 0) {
    const text = left === 0 ? `${what} بتخلص النهارده.` : `فاضل ${left} يوم على ${what}.`;
    const level = sub.status === 'trial' ? (left <= 3 ? 'warn' : 'info') : left <= 7 ? 'warn' : 'ok';
    return { level, days: left, until: end, text };
  }
  const late = -left;
  if (late <= grace) return { level: 'expired', days: grace - late, until: end, text: `${what} خلص من ${late} يوم. اللوحة هتتقفل بعد ${grace - late + 1} يوم لو ماتجددش (الكاشير مش هيقف).` };
  return { level: 'locked', until: end, text: `${what} خلص. جدّد عشان اللوحة ترجع تشتغل (الكاشير شغال عادي، وبياناتك محفوظة).` };
}

// Money for a month: the base price plus each extra branch.
export function monthlyPrice(config = {}, branches = 1, own = null) {
  if (own != null && +own > 0) return +own;
  return Math.max(0, +config.price_month || 0) + Math.max(0, branches - 1) * Math.max(0, +config.price_branch || 0);
}

// A payment of n months: added to the end date if it's still ahead, else counted from today.
export function extendPaid(until, months, today = new Date(new Date().setHours(0, 0, 0, 0))) {
  const end = until ? day(until) : null;
  const d = new Date(end && end > today ? end : today);
  d.setMonth(d.getMonth() + months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
