// Attendance storage. Same async interface for the on-device demo store and the future Supabase store,
// so the screens don't change when the database is connected.
//   listEmployees(), addEmployee(e), updateEmployee(id, patch), clock(pin) → { name, action: 'in'|'out', at },
//   records(from, to), fixCheckout(recordId, date)

const KEY = 'saydaliti-attendance-v1';

async function hashPin(pin) {
  const bytes = new TextEncoder().encode(`saydaliti:${pin}`);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createLocalStore({ now = () => new Date(), storage = globalThis.localStorage } = {}) {
  const load = () => {
    try {
      const s = JSON.parse(storage.getItem(KEY) || 'null');
      if (s) { s.records.forEach((r) => { r.check_in = new Date(r.check_in); r.check_out = r.check_out ? new Date(r.check_out) : null; }); return s; }
    } catch { /* storage blocked or corrupt */ }
    return { employees: [], records: [], nextId: 1 };
  };
  let db = load();
  const save = () => { try { storage.setItem(KEY, JSON.stringify(db)); } catch { /* keeps working in memory */ } };

  return {
    kind: 'local',
    async listEmployees() { return db.employees.map(({ pin_hash, ...e }) => ({ ...e })); },
    async addEmployee({ name, pin, ...rest }) {
      if (!String(name || '').trim()) throw new Error('اكتب اسم الموظف.');
      if (!/^\d{4,6}$/.test(String(pin))) throw new Error('الكود لازم يبقى من 4 لـ 6 أرقام.');
      const h = await hashPin(pin);
      if (db.employees.some((e) => e.active && e.pin_hash === h)) throw new Error('الكود ده مستخدم لموظف تاني. اختار كود تاني.');
      const e = { id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: name.trim(), pin_hash: h,
        shift_start: '09:00', shift_end: '17:00', work_days: [6, 0, 1, 2, 3, 4], grace_minutes: 15, active: true, ...rest };
      db.employees.push(e); save();
      return { ...e, pin_hash: undefined };
    },
    async updateEmployee(id, patch) {
      const e = db.employees.find((x) => x.id === id);
      if (!e) throw new Error('الموظف مش موجود.');
      const { pin, ...rest } = patch;
      if (pin !== undefined) {
        if (!/^\d{4,6}$/.test(String(pin))) throw new Error('الكود لازم يبقى من 4 لـ 6 أرقام.');
        const h = await hashPin(pin);
        if (db.employees.some((x) => x.id !== id && x.active && x.pin_hash === h)) throw new Error('الكود ده مستخدم لموظف تاني.');
        e.pin_hash = h;
      }
      Object.assign(e, rest); save();
    },
    async clock(pin) {
      const h = await hashPin(pin);
      const e = db.employees.find((x) => x.active && x.pin_hash === h);
      if (!e) throw new Error('الكود غلط.');
      const at = now();
      const open = db.records.find((r) => r.employee_id === e.id && !r.check_out);
      if (open) { open.check_out = at; save(); return { name: e.name, action: 'out', at }; }
      db.records.push({ id: db.nextId++, employee_id: e.id, check_in: at, check_out: null }); save();
      return { name: e.name, action: 'in', at };
    },
    async records(from, to) {
      return db.records.filter((r) => r.check_in >= from && r.check_in < to).map((r) => ({ ...r }));
    },
    async fixCheckout(recordId, date) {
      const r = db.records.find((x) => x.id === recordId);
      if (!r) throw new Error('السجل مش موجود.');
      if (!(date > r.check_in)) throw new Error('وقت الانصراف لازم يبقى بعد الحضور.');
      r.check_out = date; save();
    },
    // Demo only: example employees with this month's history so the report isn't empty.
    async seedExample(today = now()) {
      if (db.employees.length) return false;
      const a = await this.addEmployee({ name: 'سارة (مثال)', pin: '1111' });
      const b = await this.addEmployee({ name: 'محمد (مثال)', pin: '2222', shift_start: '14:00', shift_end: '22:00' });
      let seed = 7;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      for (let d = new Date(start); d < new Date(today.getFullYear(), today.getMonth(), today.getDate()); d.setDate(d.getDate() + 1)) {
        for (const [e, h] of [[a, 9], [b, 14]]) {
          if (!e.work_days.includes(d.getDay()) || rnd() < 0.08) continue; // occasional absence
          const late = rnd() < 0.2 ? 20 + Math.floor(rnd() * 40) : Math.floor(rnd() * 10);
          const inAt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, late);
          const outAt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h + 8, Math.floor(rnd() * 15));
          db.records.push({ id: db.nextId++, employee_id: e.id, check_in: inAt, check_out: rnd() < 0.05 ? null : outAt });
        }
      }
      save();
      return true;
    },
    async reset() { db = { employees: [], records: [], nextId: 1 }; save(); },
  };
}
