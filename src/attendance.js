// Monthly attendance report — pure functions, no DOM, no database.
// employee: { id, name, shift_start 'HH:MM', shift_end 'HH:MM', work_days [0..6], grace_minutes }
// record:   { employee_id, check_in: Date, check_out: Date|null }

const MIN = 60000;
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
const minutesOfDay = (d) => d.getHours() * 60 + d.getMinutes();
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

// from: first day (local midnight), to: day after the last day. `now` caps absences and open shifts.
export function attendanceReport(employees, records, from, to, now = new Date()) {
  const end = to < now ? to : now;
  return employees.map((e) => {
    const shiftStart = toMin(e.shift_start ?? '09:00');
    const shiftEnd = toMin(e.shift_end ?? '17:00');
    const grace = e.grace_minutes ?? 15;
    const workDays = e.work_days ?? [6, 0, 1, 2, 3, 4];
    const mine = records.filter((r) => r.employee_id === e.id && r.check_in >= from && r.check_in < to);

    let workedMin = 0, lateDays = 0, lateMin = 0, earlyDays = 0, openShifts = 0;
    const present = new Set();
    const firstIn = new Map(); // earliest check-in per day decides lateness
    for (const r of mine) {
      present.add(dayKey(r.check_in));
      const k = dayKey(r.check_in);
      if (!firstIn.has(k) || r.check_in < firstIn.get(k)) firstIn.set(k, r.check_in);
      if (r.check_out) {
        workedMin += Math.max(0, (r.check_out - r.check_in) / MIN);
        if (minutesOfDay(r.check_out) < shiftEnd - grace && r.check_out.toDateString() === r.check_in.toDateString()) earlyDays += 1;
      } else {
        openShifts += 1; // forgot to clock out — not counted in hours until the owner fixes it
      }
    }
    for (const t of firstIn.values()) {
      const late = minutesOfDay(t) - shiftStart;
      if (late > grace) { lateDays += 1; lateMin += late; }
    }

    // Count scheduled days only from the day the employee was added
    let start = new Date(from);
    if (e.created_at) {
      const c = new Date(e.created_at);
      const cDay = new Date(c.getFullYear(), c.getMonth(), c.getDate());
      if (cDay > start) start = cDay;
    }
    let scheduled = 0, absent = 0;
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      if (!workDays.includes(d.getDay())) continue;
      // today only counts as absent once the shift has started + grace
      const isToday = d.toDateString() === now.toDateString();
      if (isToday && minutesOfDay(now) < shiftStart + grace) continue;
      scheduled += 1;
      if (!present.has(dayKey(d))) absent += 1;
    }

    return {
      id: e.id,
      name: e.name,
      hours: workedMin / 60,
      daysPresent: present.size,
      scheduledDays: scheduled,
      absent,
      lateDays,
      lateMinutes: Math.round(lateMin),
      earlyLeaves: earlyDays,
      openShifts,
      expectedHours: scheduled * Math.max(0, shiftEnd - shiftStart) / 60,
    };
  });
}
