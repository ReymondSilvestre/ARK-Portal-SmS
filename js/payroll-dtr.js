/* Finance - Payroll: biometric data -> Daily Time Record (DTR).
   Pure functions (no screen, no server): reading a biometric export, finding its columns, and working out for every day
   the hours worked, late, undertime, overtime and present / absent / half-day. All limits come from the DTR settings (D). */

const p2 = (n) => String(n).padStart(2, "0");
export const ymd = (y, m, d) => `${y}-${p2(m)}-${p2(d)}`;
export const hm = (min) => (min === null || min === undefined || min === "" ? "" : `${p2(Math.floor(min / 60))}:${p2(min % 60)}`);
export const toMin = (t) => { if (!t) return null; const m = String(t).match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
export const dowOf = (date) => new Date(date + "T00:00").getDay();
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const datesBetween = (a, b) => { const out = []; for (let d = new Date(a + "T00:00"); d <= new Date(b + "T00:00"); d.setDate(d.getDate() + 1)) out.push(ymd(d.getFullYear(), d.getMonth() + 1, d.getDate())); return out; };

/** One cell of a biometric file -> { date: "YYYY-MM-DD" | null, min: minutes since midnight | null }. Reads Date objects, Excel numbers and text in many layouts. */
export function parseStamp(v, order = "MDY") {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    if (isNaN(v)) return null; const min = v.getHours() * 60 + v.getMinutes() + (v.getSeconds() >= 30 ? 1 : 0);
    return v.getFullYear() < 1950 ? { date: null, min } : { date: ymd(v.getFullYear(), v.getMonth() + 1, v.getDate()), min };
  }
  if (typeof v === "number") {
    const d = new Date(Math.round((v - 25569) * 86400000)); if (isNaN(d)) return null;
    const min = d.getUTCHours() * 60 + d.getUTCMinutes() + (d.getUTCSeconds() >= 30 ? 1 : 0);
    return v < 1 ? { date: null, min } : { date: ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), min: v % 1 === 0 ? null : min };
  }
  const s = String(v).trim(); if (!s) return null;
  let date = null, min = null, m = s.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m) date = ymd(+m[1], +m[2], +m[3]);
  else if ((m = s.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/))) {
    let a = +m[1], b = +m[2], y = +m[3]; if (y < 100) y += 2000;
    let mo = order === "DMY" ? b : a, da = order === "DMY" ? a : b; if (mo > 12 && da <= 12) [mo, da] = [da, mo];
    date = ymd(y, mo, da);
  }
  const t = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (t) { let h = +t[1]; if (t[4]) { const pm = t[4].toUpperCase() === "PM"; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; } min = h * 60 + +t[2] + (+(t[3] || 0) >= 30 ? 1 : 0); }
  return date === null && min === null ? null : { date, min };
}

/** Looks at the first rows of a file and guesses which column is what. cols: { id, name, date, time, out } (-1 = none). */
export function detectColumns(rows, order = "MDY") {
  const first = rows[0] || [], textual = first.filter((c) => /[A-Za-z]/.test(String(c ?? "")) && !parseStamp(c, order)).length;
  const hasHeader = first.length > 0 && textual >= Math.ceil(first.length / 2), body = rows.slice(hasHeader ? 1 : 0, 40), n = Math.max(...rows.slice(0, 40).map((r) => r.length), 0);
  const cols = { id: -1, name: -1, date: -1, time: -1, out: -1 };
  if (hasHeader) first.forEach((h, i) => {
    const s = String(h ?? "").toLowerCase();
    if (cols.name < 0 && /name/.test(s) && !/user\s?id/.test(s)) cols.name = i;
    else if (cols.id < 0 && /(^|[^a-z])(no|id|emp|employee|badge|user|person|enroll|code)/.test(s)) cols.id = i;
    else if (cols.out < 0 && /(time.?out|check.?out|clock.?out|^out|\bout$|departure|pm out)/.test(s)) cols.out = i;
    else if (cols.date < 0 && /(date.?time|punch|timestamp|check.?time|^time$)/.test(s)) cols.date = i;
    else if (cols.date < 0 && /date|day/.test(s)) cols.date = i;
    else if (cols.time < 0 && /(time.?in|check.?in|clock.?in|^in$|\bin$|arrival|time)/.test(s)) cols.time = i;
  });
  const sample = (i) => body.map((r) => r[i]).filter((v) => v !== undefined && v !== "");
  if (cols.date < 0) for (let i = 0; i < n; i++) { const s = sample(i); if (s.length && s.filter((v) => { const p = parseStamp(v, order); return p && p.date; }).length > s.length * 0.7) { cols.date = i; break; } }
  if (cols.id < 0) for (let i = 0; i < n; i++) { if (i === cols.date || i === cols.name) continue; const s = sample(i); if (s.length && s.every((v) => /^\s*\w{1,15}\s*$/.test(String(v)) && !parseStamp(v, order))) { cols.id = i; break; } }
  return { hasHeader, cols };
}

/** The punches of a file -> Map( id -> { name, days: Map(date -> { times:[minutes], in, out }) } ). Two layouts:
 *  (1) one punch per row (date+time in one column, or a date column and a time column);  (2) one row per day with a time-in column and a time-out column. */
export function parsePunches(rows, cols, hasHeader, order = "MDY") {
  const out = new Map(), stat = { rows: 0, bad: 0, min: "", max: "" };
  rows.slice(hasHeader ? 1 : 0).forEach((r) => {
    if (!r || r.every((c) => c === "" || c === undefined || c === null)) return;
    const id = String(r[cols.id] ?? "").trim(); if (!id) { stat.bad++; return; }
    const d1 = parseStamp(r[cols.date], order); if (!d1 || !d1.date) { stat.bad++; return; }
    let times = [];
    if (cols.out >= 0) { const a = parseStamp(r[cols.time], order), b = parseStamp(r[cols.out], order); if (a && a.min !== null) times.push(a.min); if (b && b.min !== null) times.push(b.min); }
    else if (cols.time >= 0 && cols.time !== cols.date) { const t = parseStamp(r[cols.time], order); if (t && t.min !== null) times.push(t.min); }
    else if (d1.min !== null) times.push(d1.min);
    if (!times.length && cols.out < 0) { stat.bad++; return; }
    const e = out.get(id) || { name: cols.name >= 0 ? String(r[cols.name] ?? "").trim() : "", days: new Map() }; if (!e.name && cols.name >= 0) e.name = String(r[cols.name] ?? "").trim();
    const day = e.days.get(d1.date) || { times: [] }; day.times.push(...times); e.days.set(d1.date, day); out.set(id, e);
    stat.rows++; if (!stat.min || d1.date < stat.min) stat.min = d1.date; if (!stat.max || d1.date > stat.max) stat.max = d1.date;
  });
  // first punch = IN, last punch = OUT; scans less than 5 minutes apart are one scan (a double tap)
  out.forEach((e) => e.days.forEach((d) => { d.times.sort((a, b) => a - b); d.in = d.times[0]; d.out = d.times.length > 1 && d.times[d.times.length - 1] - d.times[0] >= 5 ? d.times[d.times.length - 1] : null; }));
  return { people: out, stat };
}

/** One day. day: { date, in: "HH:MM"|"", out: "HH:MM"|"" }; shift: { start, end } ("HH:MM"); D: the DTR settings; ctx: { holiday, leave } (leave = an approved leave covers the day).
 *  Returns { s, h, late, ut, ot, pres, abs, inc } - s: P present, HD half day, A absent, L leave, H holiday, R rest day, RW worked on a rest day / holiday, INC only one punch. Times in minutes, h in hours. */
function calcAuto(day, shift, D, ctx = {}) {
  const z = { s: "", h: 0, late: 0, ut: 0, ot: 0, pres: 0, abs: 0, inc: false }, i = toMin(day.in), o = toMin(day.out), has = i !== null || o !== null, both = i !== null && o !== null && o > i;
  const sM = toMin(shift.start), eM = toMin(shift.end), lunch = +D.lunchMin || 0, work = D.workDays.includes(dowOf(day.date)) && !ctx.holiday;
  const hoursOf = (a, b) => { const span = Math.max(0, b - a); return Math.max(0, span - (span > 240 ? lunch : 0)); };
  if (!work) {
    if (!has) return { ...z, s: ctx.holiday ? "H" : "R" };
    if (!both) return { ...z, s: "RW", inc: true };
    const m = hoursOf(i, o); return { ...z, s: "RW", h: m / 60, ot: D.restDayAsOt ? m : 0 };
  }
  if (!has) return ctx.leave ? { ...z, s: "L" } : { ...z, s: "A", abs: 1 };
  if (!both) return { ...z, s: "INC", pres: 1, inc: true };
  const reg = hoursOf(Math.max(i, sM), Math.min(o, eM)), otRaw = o - eM, block = Math.max(1, +D.otBlockMin || 30);
  const ot = otRaw >= (+D.otStartMin || 0) && otRaw > 0 ? Math.floor(otRaw / block) * block : 0;
  if (reg / 60 < (+D.halfDayHrs || 0)) return { ...z, s: "HD", h: (reg + ot) / 60, ot, pres: 0.5, abs: 0.5 };
  const late = i > sM + (+D.graceMin || 0) ? i - sM : 0, ut = o < eM ? eM - o : 0;
  return { ...z, s: "P", h: (reg + ot) / 60, late, ut, ot, pres: 1 };
}

/** Same as above, then the person's own corrections are applied:
 *  day.ov  = a status chosen by hand: P present (full day), HD half day, A absent, L on leave (paid), H holiday, R rest day (an empty value = automatic).
 *  day.man = { late, ut, ot } minutes typed by hand (each one replaces the computed figure). */
export function calcDay(day, shift, D, ctx = {}) {
  let c = calcAuto(day, shift, D, ctx); const ov = day.ov;
  if (ov) {
    const sM = toMin(shift.start), eM = toMin(shift.end), full = Math.max(0, (eM - sM) - (+D.lunchMin || 0)) / 60, z = { s: ov, h: c.h, late: 0, ut: 0, ot: 0, pres: 0, abs: 0, inc: false };
    if (ov === "P") c = { ...z, pres: 1, h: c.h || full };
    else if (ov === "HD") c = { ...z, pres: 0.5, abs: 0.5, h: c.h || full / 2 };
    else if (ov === "A") c = { ...z, abs: 1, h: 0 };
    else c = { ...z, h: ov === "L" || ov === "H" || ov === "R" ? 0 : c.h };      // leave, holiday, rest day: nobody is absent
  }
  const m = day.man;
  if (m) { if (m.late !== undefined && m.late !== "") c.late = Math.max(0, +m.late || 0); if (m.ut !== undefined && m.ut !== "") c.ut = Math.max(0, +m.ut || 0); if (m.ot !== undefined && m.ot !== "") c.ot = Math.max(0, +m.ot || 0); }
  return { ...c, ov: ov || "", man: m || null };
}

const r2 = (n) => Math.round(n * 100) / 100;
/** Totals of the days of a DTR (optionally only the days between two dates). */
export function totalsOf(days, from = "", to = "~") {
  const t = { present: 0, absent: 0, late: 0, ut: 0, ot: 0, hours: 0, inc: 0, restWork: 0, leave: 0, holiday: 0 };
  days.filter((d) => d.d >= from && d.d <= to).forEach((d) => { t.present += d.pres || 0; t.absent += d.abs || 0; t.late += d.late || 0; t.ut += d.ut || 0; t.ot += d.ot || 0; t.hours += d.h || 0; if (d.inc) t.inc++; if (d.s === "RW") t.restWork++; if (d.s === "L") t.leave++; if (d.s === "H") t.holiday++; });
  t.hours = r2(t.hours); t.present = r2(t.present); t.absent = r2(t.absent); return t;
}

/** Works out every day of a list again with the current settings. raw: [{ d, in, out }]; leaveDates: Set of "YYYY-MM-DD". */
export function buildDays(raw, shift, D, leaveDates = new Set()) {
  const hol = new Set((D.holidays || []).map((h) => h.date));
  return raw.map((r) => { const c = calcDay({ date: r.d, in: r.in, out: r.out, ov: r.ov, man: r.man }, shift, D, { holiday: hol.has(r.d), leave: leaveDates.has(r.d) }); return { d: r.d, in: r.in || "", out: r.out || "", n: r.n || 0, ...c }; });
}
