// The plans Saydaliti is sold in: what each includes and its limits. The defaults below are a
// starting point; the app owner changes names, prices, features and limits on the admin page
// (stored in app_config.plans) without touching the code. A pharmacy with no plan set gets
// everything, as before plans existed.
export const FEATURES = [
  ['core', 'الأساسي: الكاشير والمخزون والمشتريات والحسابات'],
  ['analytics', 'التحليلات وصحة الصيدلية والاقتراحات'],
  ['ai', 'اسأل صيدليتي وقراية الفواتير بالذكاء الاصطناعي'],
  ['united', 'المزامنة مع المتحدة'],
];
export const DEFAULT_PLANS = {
  starter: { name: 'Starter', price_month: 0, price_year: 0, features: ['core', 'united'], max_branches: 1, max_users: 3 },
  pro: { name: 'Pro', price_month: 0, price_year: 0, features: ['core', 'united', 'analytics', 'ai'], max_branches: 1, max_users: 6 },
  business: { name: 'Business', price_month: 0, price_year: 0, features: ['core', 'united', 'analytics', 'ai'], max_branches: 10, max_users: 30 },
};
const KEYS = new Set(FEATURES.map(([k]) => k));

// Plans as stored (JSON text or object) → a clean, complete set; anything odd falls back to the default.
export function readPlans(raw) {
  let p = raw;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
  const out = {};
  for (const [id, def] of Object.entries(DEFAULT_PLANS)) {
    const x = p && typeof p === 'object' ? p[id] : null;
    const int = (v, d, lo, hi) => (Number.isFinite(+v) && +v >= lo && +v <= hi ? Math.round(+v) : d);
    out[id] = x ? {
      name: typeof x.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 40) : def.name,
      price_month: int(x.price_month, def.price_month, 0, 1e6), price_year: int(x.price_year, def.price_year, 0, 1e7),
      features: Array.isArray(x.features) ? [...new Set(x.features.filter((f) => KEYS.has(f)))] : def.features,
      max_branches: int(x.max_branches, def.max_branches, 1, 1000), max_users: int(x.max_users, def.max_users, 1, 10000),
    } : { ...def };
  }
  return out;
}
// What a pharmacy may use: its plan, or everything when it has none.
export function planOf(sub, rawPlans) {
  const id = sub?.plan;
  if (!id) return { id: null, name: null, features: FEATURES.map(([k]) => k), max_branches: Infinity, max_users: Infinity };
  const p = readPlans(rawPlans)[id];
  return p ? { id, ...p } : { id: null, name: null, features: FEATURES.map(([k]) => k), max_branches: Infinity, max_users: Infinity };
}
export const hasFeature = (plan, f) => plan.features.includes(f);
