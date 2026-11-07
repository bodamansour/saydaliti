// Comparing the stock the server keeps (stock_levels, Phase 2 M1) with the stock the app computes
// from the uploaded file and everything entered since (src/inventory.js liveData). No DOM, no network.
// A difference means one of them is missing a movement: the owner opens the levels again from the
// app's numbers (open_stock), after checking why.
const round = (n) => Math.round((+n || 0) * 1000) / 1000;

export function reconcile(levels = [], items = [], tolerance = 0.001) {
  const server = new Map(levels.map((l) => [String(l.code), round(l.qty)]));
  const app = new Map(items.map((i) => [String(i.code), { qty: round(i.qty), name: i.name || String(i.code) }]));
  const diffs = [];
  for (const code of new Set([...server.keys(), ...app.keys()])) {
    const s = server.get(code) ?? 0, a = app.get(code)?.qty ?? 0;
    if (Math.abs(s - a) > tolerance) diffs.push({ code, name: app.get(code)?.name ?? code, server: s, app: a, diff: round(s - a) });
  }
  diffs.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff) || x.code.localeCompare(y.code));
  return { diffs, checked: new Set([...server.keys(), ...app.keys()]).size };
}

// The app's numbers for an opening: every item of the branch with its boxes on the shelf.
export function openingItems(items = []) {
  const out = new Map();
  for (const i of items) out.set(String(i.code), round((out.get(String(i.code)) ?? 0) + (+i.qty || 0)));
  return [...out].map(([code, qty]) => ({ code, qty }));
}
