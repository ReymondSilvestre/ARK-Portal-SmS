/* Finance - Payroll account.
   Dashboard | Add information (pay information per employee) | Payroll (automatic computation per pay period) | Payslips (ready to print, 2 copies on one landscape page)
   | Reports (register, by department, SSS / PhilHealth / Pag-IBIG / tax) | Settings (rates, tax table, signatories).
   Everything is kept in the school's Google Sheet (tabs payrollInfo, payrollSettings, payrollRuns, payslips); only this account can read it. */
import { requireRole, logout, db, esc, friendlyError, applyBranding } from "./auth.js";
import { collection, query, where, getDocs, getDoc, doc, setDoc, writeBatch, serverTimestamp, liveRefresh } from "./db.js";
import { showPopup } from "./leave.js";
import { mergeSettings, DEFAULT_SETTINGS, computeSlip, periodOf, weekdaysIn, r2 } from "./payroll-calc.js";
import { parsePunches, detectColumns, buildDays, totalsOf, datesBetween, hm, toMin, DOW } from "./payroll-dtr.js";

const $ = (id) => document.getElementById(id);
const { user, profile, school } = await requireRole(["payroll"]);
const SID = profile.schoolId;
$("who").textContent = profile.displayName + " (Finance - Payroll)"; $("out").onclick = logout;
applyBranding(school);
const flash = (t, ok) => { const m = $("msg"); m.textContent = t; m.className = "notice noprint " + (ok ? "ok" : "err"); m.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => (m.hidden = true), 9000); scrollTo({ top: 0, behavior: "smooth" }); };
const net = () => { $("sync").className = "sync" + (navigator.onLine ? "" : " off"); $("sync").lastElementChild.textContent = navigator.onLine ? "Online" : "Offline - changes will not save"; };
addEventListener("online", net); addEventListener("offline", net); net();
const run = async (fn) => { try { await fn(); } catch (e) { console.error(e); flash(friendlyError(e)); } };

const money = (n) => "\u20b1" + (Number(n) || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateText = (s) => (s ? new Date(s + "T00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "-");
const nameOf = (e) => `${e.lastName || ""}, ${e.firstName || ""}${e.middleInitial ? " " + e.middleInitial + "." : ""}`;
const sumBy = (a, f) => r2(a.reduce((n, x) => n + (+f(x) || 0), 0));
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const bySchool = async (c) => (await getDocs(query(collection(db, c), where("schoolId", "==", SID)))).docs.map((d) => ({ id: d.id, ...d.data() }));

const S = { emps: [], info: new Map(), settings: mergeSettings(), runs: [], leave: [], slips: {}, dtr: {}, up: null, dtrMonth: "", dtrView: "", tab: "dash", q: "", editKey: "", form: null, draft: null, slipRun: "", repRun: "" };

async function refresh() {
  await run(async () => {
    const [emps, info, runs, leave, set] = await Promise.all([bySchool("employees"), bySchool("payrollInfo"), bySchool("payrollRuns"), bySchool("leaveRequests").catch(() => []), getDoc(doc(db, "payrollSettings", SID)).catch(() => null)]);
    S.emps = emps.filter((e) => (e.status || "Active") === "Active").sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    S.info = new Map(info.map((i) => [i.id, i])); S.runs = runs.sort((a, b) => String(b.start).localeCompare(String(a.start)) || String(b.createdAt?.seconds || 0).localeCompare(String(a.createdAt?.seconds || 0)));
    S.leave = leave; S.settings = mergeSettings(set && set.exists() ? set.data() : null);
    render();
  });
}
const empOf = (infoDoc) => S.emps.find((e) => e.id === infoDoc.id) || null;

/* ---------- tabs ---------- */
function show(t) { S.tab = t; document.querySelectorAll("[data-s]").forEach((s) => (s.hidden = s.dataset.s !== t)); document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t)); render(); }
$("tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.t); };
function render() {
  ({ dash: rDash, info: rInfo, dtr: rDtr, runs: rRuns, slips: rSlips, reports: rReports, settings: rSettings }[S.tab] || rDash)();
}

/* ---------- dashboard ---------- */
function rDash() {
  const act = [...S.info.values()].filter((i) => i.active !== false), missing = S.emps.filter((e) => !S.info.has(e.id)), noPay = act.filter((i) => !(+i.basicMonthly > 0));
  const monthlyBasic = sumBy(act, (i) => i.basicMonthly), monthlyAllow = sumBy(act, (i) => sumBy(i.allowances || [], (a) => a.amount)), last = S.runs[0];
  const dep = {}; act.forEach((i) => { const d = (empOf(i) || i).department || "No department"; (dep[d] ||= { n: 0, pay: 0 }); dep[d].n++; dep[d].pay += +i.basicMonthly || 0; });
  const maxPay = Math.max(1, ...Object.values(dep).map((x) => x.pay));
  $("pDash").innerHTML = `<div class="cards">
    <div class="stat"><b>${act.length}</b><span>Employees on payroll</span></div><div class="stat"><b>${money(monthlyBasic)}</b><span>Monthly basic pay</span></div>
    <div class="stat"><b>${money(monthlyAllow)}</b><span>Monthly allowances</span></div><div class="stat${missing.length || noPay.length ? " warn" : ""}"><b>${missing.length + noPay.length}</b><span>Need pay information</span></div>
    <div class="stat"><b>${last ? money(last.net) : "-"}</b><span>${last ? "Net pay, " + esc(last.label) : "No payroll yet"}</span></div></div>
  ${missing.length || noPay.length ? `<div class="notice err">${missing.length ? `${missing.length} employee${missing.length === 1 ? " has" : "s have"} no pay record yet. ` : ""}${noPay.length ? `${noPay.length} on payroll ${noPay.length === 1 ? "has" : "have"} no monthly pay set. ` : ""}Open <b>Add information</b>.</div>` : ""}
  <div class="pr-grid"><div class="pr-card"><h3>Monthly basic pay by department</h3><div class="tablewrap"><table><tr><th>Department</th><th>Employees</th><th class="pr-num">Monthly basic</th><th></th></tr>
    ${Object.entries(dep).sort((a, b) => b[1].pay - a[1].pay).map(([d, v]) => `<tr><td>${esc(d)}</td><td>${v.n}</td><td class="pr-num">${money(v.pay)}</td><td style="width:30%"><span class="pr-bar"><i style="width:${Math.round(v.pay / maxPay * 100)}%"></i></span></td></tr>`).join("") || `<tr><td colspan="4">No employee on payroll yet.</td></tr>`}</table></div></div>
  <div class="pr-card"><h3>Recent payroll</h3><div class="tablewrap"><table><tr><th>Period</th><th>Employees</th><th class="pr-num">Gross</th><th class="pr-num">Net</th><th>Status</th></tr>
    ${S.runs.slice(0, 6).map((r) => `<tr><td>${esc(r.label)}</td><td>${r.count}</td><td class="pr-num">${money(r.gross)}</td><td class="pr-num">${money(r.net)}</td><td><span class="badge ${r.status === "Final" ? "active" : "warn"}">${esc(r.status)}</span></td></tr>`).join("") || `<tr><td colspan="5">No payroll run yet.</td></tr>`}</table></div></div></div>
  <p class="muted fine">Contribution rates and the tax table are <b>defaults</b> (SSS 5%, PhilHealth 2.5%, Pag-IBIG 2% employee share, TRAIN tax table). Check them under <b>Settings</b> before the first payroll: the government changes them from time to time.</p>`;
}

/* ---------- add information (pay information per employee) ---------- */
const newInfo = (e) => ({ schoolId: SID, employeeKey: e.id, employeeId: e.employeeId, name: nameOf(e), position: e.position || "", department: e.department || "", basicMonthly: 0, allowances: [], deductions: [], sss: true, philhealth: true, pagibig: true, tax: true, active: true, bank: "", createdBy: user.uid, createdAt: serverTimestamp() });
function rInfo() {
  const q = S.q.toLowerCase(), list = S.emps.filter((e) => !q || [e.employeeId, nameOf(e), e.position, e.department].join(" ").toLowerCase().includes(q));
  const f = S.form;
  $("pInfo").innerHTML = `<div class="panel"><h2>Add information</h2>
    <p class="muted">The pay information of every employee: monthly basic pay, allowances, recurring deductions (loans) and which contributions apply. Employees come from the HR records (HR or the IT Admin registers them).</p>
    <div class="btnbar"><button class="btn primary" id="piAll" type="button"${S.emps.some((e) => !S.info.has(e.id)) ? "" : " disabled"}>Create a pay record for every employee that has none (${S.emps.filter((e) => !S.info.has(e.id)).length})</button></div>
    ${f ? infoForm(f) : ""}
    <div class="row"><label>Search<input id="piQ" value="${esc(S.q)}" placeholder="Employee No., name, position or department" autocomplete="off"></label></div>
    <div class="tablewrap"><table><tr><th>Employee No.</th><th>Name</th><th>Position / department</th><th class="pr-num">Monthly basic pay</th><th class="pr-num">Allowances</th><th>SSS</th><th>PhilHealth</th><th>Pag-IBIG</th><th>Tax</th><th>Status</th><th></th></tr>
    ${list.map((e) => { const i = S.info.get(e.id); const yn = (v) => (v === false ? "No" : "Yes");
      return i ? `<tr><td><b>${esc(e.employeeId)}</b></td><td>${esc(nameOf(e))}</td><td>${esc(e.position || "-")}<small>${esc(e.department || "")}</small></td>
        <td class="pr-num"><input class="pr-in" type="number" min="0" step="0.01" data-quick="${esc(e.id)}" value="${+i.basicMonthly || 0}" aria-label="Monthly basic pay of ${esc(nameOf(e))}"></td><td class="pr-num">${money(sumBy(i.allowances || [], (a) => a.amount))}</td>
        <td>${yn(i.sss)}</td><td>${yn(i.philhealth)}</td><td>${yn(i.pagibig)}</td><td>${yn(i.tax)}</td><td><span class="badge ${i.active === false ? "" : "active"}">${i.active === false ? "Inactive" : "Active"}</span></td>
        <td class="actions"><button class="btn small" data-edit="${esc(e.id)}">Details</button></td></tr>`
        : `<tr><td><b>${esc(e.employeeId)}</b></td><td>${esc(nameOf(e))}</td><td>${esc(e.position || "-")}<small>${esc(e.department || "")}</small></td><td colspan="7" class="muted">No pay record yet</td><td class="actions"><button class="btn small primary" data-new="${esc(e.id)}">Set up pay</button></td></tr>`; }).join("") || `<tr><td colspan="11">No employee found. Employees are registered by HR or the IT Admin.</td></tr>`}</table></div></div>`;
  $("piQ").oninput = (e) => { S.q = e.target.value; const p = e.target.selectionStart; rInfo(); const n = $("piQ"); n.focus(); n.setSelectionRange(p, p); };
}
const rowsHtml = (kind, rows) => `<div class="pr-rows" id="${kind}Rows">${rows.map((r, i) => `<div class="r"><input data-${kind}="label" placeholder="${kind === "al" ? "e.g. Rice allowance" : "e.g. Salary loan"}" value="${esc(r.label)}" maxlength="40"><input class="pr-in" type="number" min="0" step="0.01" data-${kind}="amount" value="${+r.amount || 0}" aria-label="Amount per month"><button class="btn small danger" type="button" data-rm="${kind}:${i}">Remove</button></div>`).join("")}</div><button class="btn small" type="button" data-add="${kind}">Add ${kind === "al" ? "an allowance" : "a deduction"}</button>`;
function infoForm(f) {
  const e = S.emps.find((x) => x.id === f.employeeKey) || f;
  const ck = (id, v, l) => `<label class="sc-chk"><input type="checkbox" id="${id}"${v !== false ? " checked" : ""}> ${l}</label>`;
  return `<div class="pr-card"><h3>${esc(nameOf(e))} <small>Employee No. ${esc(f.employeeId)}</small></h3>
    <div class="row"><label>Monthly basic pay (PHP)<input id="fBasic" type="number" min="0" step="0.01" value="${+f.basicMonthly || 0}"></label><label>Bank / account no. <small>(optional, for the payroll list)</small><input id="fBank" maxlength="60" value="${esc(f.bank || "")}"></label></div>
    <div class="row"><label>Biometric ID <small>(only if it differs from the Employee No.)</small><input id="fBio" maxlength="30" value="${esc(f.bioId || "")}"></label><label>Own work start <small>(blank = school default)</small><input id="fShS" type="time" value="${esc(f.shiftStart || "")}"></label><label>Own work end<input id="fShE" type="time" value="${esc(f.shiftEnd || "")}"></label></div>
    <div class="row"><fieldset class="sc-days"><legend>Deduct</legend>${ck("fSss", f.sss, "SSS")}${ck("fPhic", f.philhealth, "PhilHealth")}${ck("fHdmf", f.pagibig, "Pag-IBIG")}${ck("fTax", f.tax, "Withholding tax")}</fieldset><fieldset class="sc-days"><legend>Status</legend>${ck("fActive", f.active, "On payroll")}</fieldset></div>
    <h3>Allowances (per month)</h3>${rowsHtml("al", f.allowances || [])}<h3>Recurring deductions (per month, e.g. loans)</h3>${rowsHtml("de", f.deductions || [])}
    <div class="btnbar"><button class="btn primary" id="fSave" type="button">Save pay information</button><button class="btn" id="fCancel" type="button">Close</button></div></div>`;
}
const readRows = (kind) => [...document.querySelectorAll(`#${kind}Rows .r`)].map((r) => ({ label: r.querySelector(`[data-${kind}="label"]`).value.trim(), amount: r2(+r.querySelector(`[data-${kind}="amount"]`).value) })).filter((x) => x.label || x.amount);
function pullRows() { if (!S.form) return; S.form.allowances = readRows("al"); S.form.deductions = readRows("de"); }
$("pInfo").addEventListener("click", (ev) => run(async () => {
  const t = ev.target.closest("button"); if (!t) return;
  if (t.id === "piAll") { const b = writeBatch(db); S.emps.filter((e) => !S.info.has(e.id)).forEach((e) => b.set(doc(db, "payrollInfo", e.id), newInfo(e))); await b.commit(); await refresh(); return flash("Pay records created. Now type each employee's monthly basic pay.", true); }
  if (t.dataset.new) { const e = S.emps.find((x) => x.id === t.dataset.new); await setDoc(doc(db, "payrollInfo", e.id), newInfo(e)); await refresh(); S.form = { ...newInfo(e), createdAt: null }; return rInfo(); }
  if (t.dataset.edit) { S.form = JSON.parse(JSON.stringify(S.info.get(t.dataset.edit))); return rInfo(); }
  if (t.dataset.add) { pullRows(); (t.dataset.add === "al" ? S.form.allowances : S.form.deductions).push({ label: "", amount: 0 }); return rInfo(); }
  if (t.dataset.rm) { pullRows(); const [k, i] = t.dataset.rm.split(":"); (k === "al" ? S.form.allowances : S.form.deductions).splice(+i, 1); return rInfo(); }
  if (t.id === "fCancel") { S.form = null; return rInfo(); }
  if (t.id === "fSave") {
    pullRows(); const f = S.form, e = S.emps.find((x) => x.id === f.employeeKey) || {};
    const patch = { basicMonthly: r2(+$("fBasic").value), bank: $("fBank").value.trim(), bioId: $("fBio").value.trim(), shiftStart: $("fShS").value, shiftEnd: $("fShE").value, sss: $("fSss").checked, philhealth: $("fPhic").checked, pagibig: $("fHdmf").checked, tax: $("fTax").checked, active: $("fActive").checked, allowances: f.allowances, deductions: f.deductions, name: nameOf(e), position: e.position || "", department: e.department || "", updatedAt: serverTimestamp() };
    if (!(patch.basicMonthly >= 0)) return flash("Enter the monthly basic pay.");
    await setDoc(doc(db, "payrollInfo", f.employeeKey), patch, { merge: true }); S.form = null; await refresh(); flash("Pay information saved.", true);
  }
}));
$("pInfo").addEventListener("change", (ev) => run(async () => {
  const t = ev.target; if (!t.dataset.quick) return; const v = r2(+t.value); if (!(v >= 0)) return flash("Enter a valid amount.");
  await setDoc(doc(db, "payrollInfo", t.dataset.quick), { basicMonthly: v, updatedAt: serverTimestamp() }, { merge: true }); const i = S.info.get(t.dataset.quick); if (i) i.basicMonthly = v; flash("Saved.", true);
}));

/* ---------- biometric upload -> DTR ---------- */
const D = () => S.settings.dtr;
const norm = (x) => String(x ?? "").trim().replace(/^0+/, "").toLowerCase();
const letters = (x) => String(x ?? "").toLowerCase().replace(/[^a-z]/g, "");
const shiftOf = (i) => ({ start: i.shiftStart || D().start, end: i.shiftEnd || D().end });
function matchEmp(id, name) {           // by Biometric ID, then Employee No., then name
  const n = norm(id), all = [...S.info.values()];
  const hit = all.find((i) => i.bioId && norm(i.bioId) === n) || all.find((i) => norm(i.employeeId) === n);
  if (hit) return hit;
  const nn = letters(name); if (!nn) return null;
  return all.find((i) => { const e = empOf(i) || i; return [letters(nameOf(e)), letters(`${e.firstName || ""}${e.lastName || ""}`), letters(i.name)].includes(nn); }) || null;
}
const leaveSet = (i) => { const e = empOf(i), set = new Set(); S.leave.filter((l) => l.status === "Approved" && e && ((e.accountUid && l.requesterUid === e.accountUid) || (l.employeeId && l.employeeId === e.employeeId))).forEach((l) => datesBetween(l.startDate, l.endDate).forEach((d) => set.add(d))); return set; };
async function loadDtr(month, force) { if (force || !S.dtr[month]) S.dtr[month] = (await getDocs(query(collection(db, "payrollDtr"), where("schoolId", "==", SID), where("month", "==", month)))).docs.map((d) => ({ id: d.id, ...d.data() })); return S.dtr[month]; }
const round2 = (n) => Math.round((+n || 0) * 100) / 100;
const dtrDoc = (i, month, days) => ({ schoolId: SID, employeeKey: i.id, employeeId: i.employeeId, name: (empOf(i) ? nameOf(empOf(i)) : i.name), month, days: days.map((d) => ({ ...d, h: round2(d.h) })), totals: totalsOf(days), updatedBy: user.uid, updatedAt: serverTimestamp() });
async function saveDtrDocs(docs) { for (let k = 0; k < docs.length; k += 200) { const b = writeBatch(db); docs.slice(k, k + 200).forEach((x) => b.set(doc(db, "payrollDtr", x.id), { ...x.data, ...(x.isNew ? { createdBy: user.uid, createdAt: serverTimestamp() } : {}) }, { merge: true })); await b.commit(); } }

/** Reads the chosen file into rows. Excel files with SheetJS; text / CSV / .dat (tab separated) by hand. */
async function readFile(file) {
  if (/\.(xlsx|xls|xlsm|ods)$/i.test(file.name)) {
    if (!window.XLSX) throw new Error("The Excel reader did not load. Check your internet connection.");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true }); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });
  }
  const text = (await file.text()).replace(/^\uFEFF/, ""), lines = text.split(/\r?\n/).filter((l) => l.trim());
  const sep = (lines[0] || "").includes("\t") ? "\t" : ((lines[0] || "").split(";").length > (lines[0] || "").split(",").length ? ";" : ",");
  return lines.map((l) => (sep === "," ? l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')).slice(0, -1) : l.split(sep)).map((c) => String(c).trim()));
}
const colOpts = (up, sel) => `<option value="-1">- none -</option>` + Array.from({ length: Math.max(...up.rows.slice(0, 30).map((r) => r.length), 0) }, (_, i) => { const h = up.hasHeader ? up.rows[0][i] : ""; const ex = String((up.rows[up.hasHeader ? 1 : 0] || [])[i] ?? "").slice(0, 22); return `<option value="${i}"${sel === i ? " selected" : ""}>Column ${i + 1}${h ? ": " + esc(String(h)) : ""} (e.g. ${esc(ex)})</option>`; }).join("");
function uploadCard() {
  const up = S.up; if (!up) return `<div class="pr-card"><h3>1. Upload the biometric file</h3><p class="muted fine">Export the punches from the biometric machine or its software (Excel, CSV or text / .dat). The system finds the columns, creates the Daily Time Record of every employee and computes hours, present, absent, late, undertime and overtime. Uploading a file again for the same dates replaces those days.</p>
    <label>Biometric file<input type="file" id="dtFile" accept=".xlsx,.xls,.xlsm,.ods,.csv,.txt,.dat"></label></div>`;
  const c = up.cols, first = up.rows[up.hasHeader ? 1 : 0] || [], read = (i) => (i >= 0 ? first[i] : undefined), ps = parsePunches(up.rows.slice(0, up.hasHeader ? 6 : 5), c, up.hasHeader, D().dateOrder);
  const sample = ps.stat.rows ? `Employee ${esc(String(read(c.id)))}, date ${esc([...ps.people.values()][0] && [...[...ps.people.values()][0].days.keys()][0] || "?")}, time ${esc(hm([...ps.people.values()][0] && [...[...ps.people.values()][0].days.values()][0].in))}` : "<b class=\"pr-warn\">Could not read a date and time from the first row. Check the columns.</b>";
  return `<div class="pr-card"><h3>1. Check the columns - ${esc(up.name)} (${up.rows.length - (up.hasHeader ? 1 : 0)} rows)</h3>
    <div class="row"><label>Employee No. / biometric ID<select id="mcId">${colOpts(up, c.id)}</select></label><label>Name <small>(helps when the ID does not match)</small><select id="mcName">${colOpts(up, c.name)}</select></label>
      <label>Date (or date and time together)<select id="mcDate">${colOpts(up, c.date)}</select></label><label>Time <small>(one punch per row: time of the punch; one row per day: Time IN)</small><select id="mcTime">${colOpts(up, c.time)}</select></label><label>Time OUT <small>(only when each row has IN and OUT)</small><select id="mcOut">${colOpts(up, c.out)}</select></label></div>
    <p class="muted fine">First row reads as: ${sample}</p>
    <div class="tablewrap"><table>${up.rows.slice(0, 6).map((r, k) => `<tr>${r.map((v) => (k === 0 && up.hasHeader ? `<th>${esc(String(v))}</th>` : `<td>${esc(v instanceof Date ? v.toLocaleString() : String(v))}</td>`)).join("")}</tr>`).join("")}</table></div>
    <div class="btnbar"><button class="btn primary" id="dtGo" type="button">2. Create the DTR</button><button class="btn" id="dtCancel" type="button">Cancel</button></div></div>`;
}
async function createDtr() {
  const up = S.up, v = (id) => +$(id).value, cols = { id: v("mcId"), name: v("mcName"), date: v("mcDate"), time: v("mcTime"), out: v("mcOut") };
  if (cols.id < 0 || cols.date < 0) return flash("Choose the Employee No. column and the Date column.");
  const { people, stat } = parsePunches(up.rows, cols, up.hasHeader, D().dateOrder);
  if (!people.size) return flash("No punch could be read. Check the columns and the date order (Settings).");
  const cover = datesBetween(stat.min, stat.max); if (cover.length > 93) return flash(`The file covers ${cover.length} days (${stat.min} to ${stat.max}). Upload at most 3 months at a time.`);
  const months = [...new Set(cover.map((d) => d.slice(0, 7)))]; await Promise.all(months.map((m) => loadDtr(m, true)));
  const unmatched = [], docs = [], seen = new Set();
  people.forEach((p, id) => {
    const inf = matchEmp(id, p.name); if (!inf) return unmatched.push(id + (p.name ? ` (${p.name})` : "")); seen.add(inf.id);
    months.forEach((m) => {
      const old = (S.dtr[m] || []).find((x) => x.employeeKey === inf.id), map = new Map((old ? old.days : []).map((d) => [d.d, { d: d.d, in: d.in, out: d.out, n: d.n }]));
      cover.filter((d) => d.startsWith(m)).forEach((date) => { const x = p.days.get(date); map.set(date, { d: date, in: x ? hm(x.in) : "", out: x && x.out !== null ? hm(x.out) : "", n: x ? x.times.length : 0 }); });
      docs.push({ id: `${inf.id}_${m}`, isNew: !old, data: dtrDoc(inf, m, buildDays([...map.values()].sort((a, b) => a.d.localeCompare(b.d)), shiftOf(inf), D(), leaveSet(inf))) });
    });
  });
  if (!docs.length) return flash(`None of the ${people.size} people in the file matched an employee with a pay record. First IDs: ${[...people.keys()].slice(0, 5).join(", ")}. Add the employees under Add information, or fill in their Biometric ID.`);
  await saveDtrDocs(docs); S.dtr = {}; S.up = null; S.dtrMonth = months[0]; S.dtrView = "";
  const noData = [...S.info.values()].filter((i) => i.active !== false && !seen.has(i.id)).map((i) => i.name || i.employeeId);
  await rDtr();
  flash(`DTR created for ${seen.size} employee${seen.size === 1 ? "" : "s"}, ${stat.min} to ${stat.max}.` + (unmatched.length ? ` Not matched: ${unmatched.slice(0, 5).join(", ")}${unmatched.length > 5 ? " ..." : ""}.` : "") + (noData.length ? ` No biometric data for: ${noData.slice(0, 5).join(", ")}${noData.length > 5 ? " ..." : ""}.` : "") + (stat.bad ? ` ${stat.bad} unreadable row(s) skipped.` : ""), !unmatched.length && !noData.length);
}
async function rDtr() {
  if (!S.dtrMonth) S.dtrMonth = localDate().slice(0, 7);
  const docs = await loadDtr(S.dtrMonth).catch(() => []), act = [...S.info.values()].filter((i) => i.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const view = S.dtrView && docs.find((x) => x.employeeKey === S.dtrView);
  $("pDtr").innerHTML = `<div class="panel"><h2>Biometric / DTR</h2>${uploadCard()}
    <div class="pr-card"><h3>Daily Time Records</h3><div class="row"><label>Month<input type="month" id="dtMonth" value="${S.dtrMonth}"></label><button class="btn" id="dtRecalc" type="button"${docs.length ? "" : " disabled"} title="Work out every day again with the present Settings (work hours, grace, overtime, holidays, leave)">Recalculate with the present settings</button><button class="btn" id="dtPrintAll" type="button"${docs.length ? "" : " disabled"}>Print all DTRs</button></div>
    <div class="tablewrap"><table><tr><th>Employee No.</th><th>Name</th><th class="pr-num">Days present</th><th class="pr-num">Days absent</th><th class="pr-num">Late (min)</th><th class="pr-num">Undertime (min)</th><th class="pr-num">Overtime (hrs)</th><th class="pr-num">Hours worked</th><th class="pr-num">Missing punch</th><th></th></tr>
    ${act.map((i) => { const x = docs.find((d) => d.employeeKey === i.id), t = x && x.totals; return x ? `<tr><td>${esc(i.employeeId)}</td><td>${esc(x.name)}</td><td class="pr-num">${t.present}</td><td class="pr-num">${t.absent}</td><td class="pr-num">${t.late}</td><td class="pr-num">${t.ut}</td><td class="pr-num">${round2(t.ot / 60)}</td><td class="pr-num">${t.hours}</td><td class="pr-num${t.inc ? " pr-warn" : ""}">${t.inc}</td><td class="actions"><button class="btn small" data-dv="${esc(i.id)}">View / correct</button><button class="btn small" data-dp="${esc(i.id)}">Print</button></td></tr>`
      : `<tr><td>${esc(i.employeeId)}</td><td>${esc(i.name)}</td><td colspan="8" class="muted">No biometric data for this month</td></tr>`; }).join("") || `<tr><td colspan="10">No employee on payroll yet.</td></tr>`}</table></div></div></div>
    ${view ? dayEditor(view) : ""}`;
}
function dayEditor(x) {
  const lab = { P: "Present", HD: "Half day", A: "Absent", L: "On leave", H: "Holiday", R: "Rest day", RW: "Worked on a rest day / holiday", INC: "One punch only" };
  return `<div class="panel" id="dtView"><h2>${esc(x.name)} <small>${esc(x.month)} &middot; Employee No. ${esc(x.employeeId)}</small></h2><p class="muted fine">Correct a time here (for example a forgotten punch) and press Save: hours, late, undertime and overtime are worked out again. Leave both times empty for an absence or a rest day.</p>
    <div class="tablewrap"><table><tr><th>Date</th><th>Day</th><th>Time in</th><th>Time out</th><th class="pr-num">Hours</th><th class="pr-num">Late</th><th class="pr-num">Under</th><th class="pr-num">OT (min)</th><th>Status</th></tr>
    ${x.days.map((d) => `<tr${d.inc ? ' style="background:#fff4e5"' : d.s === "A" ? ' style="background:#fdeced"' : ""}><td>${esc(d.d)}</td><td>${DOW[new Date(d.d + "T00:00").getDay()]}</td><td><input type="time" data-dd="${esc(d.d)}" data-k="in" value="${esc(d.in)}"></td><td><input type="time" data-dd="${esc(d.d)}" data-k="out" value="${esc(d.out)}"></td>
      <td class="pr-num">${round2(d.h)}</td><td class="pr-num">${d.late || ""}</td><td class="pr-num">${d.ut || ""}</td><td class="pr-num">${d.ot || ""}</td><td>${esc(lab[d.s] || d.s)}</td></tr>`).join("")}
    <tr class="pr-tot"><td colspan="4">TOTAL</td><td class="pr-num">${x.totals.hours}</td><td class="pr-num">${x.totals.late}</td><td class="pr-num">${x.totals.ut}</td><td class="pr-num">${x.totals.ot}</td><td>Present ${x.totals.present} &middot; Absent ${x.totals.absent}</td></tr></table></div>
    <div class="btnbar"><button class="btn primary" id="dvSave" type="button">Save corrections</button><button class="btn" id="dvClose" type="button">Close</button></div></div>`;
}
function printDtr(list) {
  if (!list.length) return flash("There is no DTR to print.");
  const st = S.settings, sch = (school && (school.displayName || school.name)) || "", one = (x, copy) => `<div class="ps"><div class="hd"><div><p><b style="font-size:12px">${esc(sch)}</b></p><p>DAILY TIME RECORD &middot; <b>${esc(copy)}</b></p></div></div>
    <table><tr><td colspan="2"><small>Name</small><br><b>${esc(x.name)}</b></td><td colspan="2"><small>Employee No.</small><br><b>${esc(x.employeeId)}</b></td><td colspan="3"><small>Month</small><br><b>${esc(x.month)}</b></td></tr>
    <tr><th>Day</th><th></th><th>In</th><th>Out</th><th>Hours</th><th>Late / UT (min)</th><th>OT (min)</th></tr>
    ${x.days.map((d) => `<tr><td>${d.d.slice(8)}</td><td>${DOW[new Date(d.d + "T00:00").getDay()]}</td><td>${esc(d.in)}</td><td>${esc(d.out)}</td><td class="r">${d.h ? round2(d.h) : ""}</td><td class="r">${(d.late || 0) + (d.ut || 0) || ""}</td><td class="r">${d.ot || ""}</td></tr>`).join("")}
    <tr class="tot"><td colspan="4">TOTAL</td><td class="r">${x.totals.hours}</td><td class="r">${x.totals.late + x.totals.ut}</td><td class="r">${x.totals.ot}</td></tr></table>
    <p><small>Days present ${x.totals.present} &middot; days absent ${x.totals.absent} &middot; made from the biometric record.</small></p><div class="sg"><div>Employee</div><div>Verified by</div><div>${esc(st.approvedBy || "School Head")}</div></div></div>`;
  printWindow(list.map((x) => `<div class="pg"><div class="half">${one(x, "EMPLOYEE COPY")}</div><div class="half">${one(x, "OFFICE COPY")}</div></div>`).join(""), "Daily Time Record");
}
$("pDtr").addEventListener("change", (ev) => run(async () => {
  const t = ev.target;
  if (t.id === "dtFile") { const f = t.files[0]; if (!f) return; const rows = (await readFile(f)).filter((r) => r.some((c) => c !== "" && c !== undefined)); if (rows.length < 2) return flash("The file has no rows."); const det = detectColumns(rows, D().dateOrder); S.up = { name: f.name, rows, ...det }; return rDtr(); }
  if (t.id === "dtMonth") { S.dtrMonth = t.value; S.dtrView = ""; return rDtr(); }
  if (["mcId", "mcName", "mcDate", "mcTime", "mcOut"].includes(t.id)) { S.up.cols = { id: +$("mcId").value, name: +$("mcName").value, date: +$("mcDate").value, time: +$("mcTime").value, out: +$("mcOut").value }; return rDtr(); }
}));
$("pDtr").addEventListener("click", (ev) => run(async () => {
  const t = ev.target.closest("button"); if (!t) return; const docs = S.dtr[S.dtrMonth] || [];
  if (t.id === "dtGo") return createDtr(); if (t.id === "dtCancel") { S.up = null; return rDtr(); }
  if (t.dataset.dv) { S.dtrView = t.dataset.dv; await rDtr(); return $("dtView").scrollIntoView({ behavior: "smooth" }); }
  if (t.dataset.dp) return printDtr(docs.filter((x) => x.employeeKey === t.dataset.dp)); if (t.id === "dtPrintAll") return printDtr(docs);
  if (t.id === "dvClose") { S.dtrView = ""; return rDtr(); }
  if (t.id === "dvSave") {
    const x = docs.find((d) => d.employeeKey === S.dtrView), inf = S.info.get(S.dtrView); if (!x || !inf) return;
    const raw = x.days.map((d) => ({ d: d.d, in: document.querySelector(`[data-dd="${d.d}"][data-k="in"]`).value, out: document.querySelector(`[data-dd="${d.d}"][data-k="out"]`).value, n: d.n }));
    await saveDtrDocs([{ id: x.id, data: dtrDoc(inf, x.month, buildDays(raw, shiftOf(inf), D(), leaveSet(inf))) }]); S.dtr = {}; await rDtr(); return flash("Corrections saved and recalculated.", true);
  }
  if (t.id === "dtRecalc") {
    const a = await showPopup({ title: "Recalculate the whole month?", html: `<p>Every day of ${esc(S.dtrMonth)} is worked out again from the punches with the present Settings (work hours, grace, overtime, half day, holidays and approved leave). Your time corrections stay.</p>`, buttons: [{ label: "Cancel", value: "no" }, { label: "Recalculate", value: "yes", primary: true }] }); if (a.value !== "yes") return;
    const out = docs.map((x) => { const inf = S.info.get(x.employeeKey); return inf ? { id: x.id, data: dtrDoc(inf, x.month, buildDays(x.days.map((d) => ({ d: d.d, in: d.in, out: d.out, n: d.n })), shiftOf(inf), D(), leaveSet(inf))) } : null; }).filter(Boolean);
    await saveDtrDocs(out); S.dtr = {}; await rDtr(); flash(`${out.length} DTR${out.length === 1 ? "" : "s"} recalculated.`, true);
  }
}));

/* ---------- payroll runs ---------- */
const unpaidLeaveDays = (emp, per) => (S.settings.unpaidLeave && emp ? S.leave.filter((l) => l.status === "Approved" && /without pay|no pay|unpaid/i.test(l.leaveType || "") && ((emp.accountUid && l.requesterUid === emp.accountUid) || (l.employeeId && l.employeeId === emp.employeeId)))
  .reduce((n, l) => n + weekdaysIn(l.startDate, l.endDate, per.start, per.end), 0) : 0);
function buildRow(infoDoc, emp, inp, per) { const x = { ...inp }; x.leaveDays = unpaidLeaveDays(emp, per); return { key: infoDoc.id, info: infoDoc, emp, inp: x, slip: computeSlip(infoDoc, x, S.settings, per) }; }
function dtrInputs(i, per) {   // absent days, late + undertime minutes and overtime hours of the period, from the biometric DTR
  const days = []; for (const m of new Set([per.start.slice(0, 7), per.end.slice(0, 7)])) days.push(...((S.dtr[m] || []).find((x) => x.employeeKey === i.id)?.days || []));
  const mine = days.filter((d) => d.d >= per.start && d.d <= per.end); if (!mine.length) return null;
  const t = totalsOf(mine); return { absentDays: t.absent, lateMin: t.late + t.ut, otHours: r2(t.ot / 60), dtr: { present: t.present, absent: t.absent, lateMin: t.late, utMin: t.ut, otHrs: r2(t.ot / 60), hours: t.hours, missing: t.inc } };
}
const ensureDtr = (per) => Promise.all([...new Set([per.start.slice(0, 7), per.end.slice(0, 7)])].map((m) => loadDtr(m)));
function newDraft(month, half, payDate) {
  const per = periodOf(month, half), rows = [...S.info.values()].filter((i) => i.active !== false && empOf(i)).sort((a, b) => nameOf(empOf(a)).localeCompare(nameOf(empOf(b)))).map((i) => buildRow(i, empOf(i), dtrInputs(i, per) || {}, per));
  S.draft = { per, payDate: payDate || per.end, rows, runId: "", status: "Draft" };
}
function rRuns() {
  const st = S.settings, now = new Date(), month = (S.draft && S.draft.per.start.slice(0, 7)) || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const half = S.draft ? S.draft.per.half : st.frequency === "monthly" ? "whole" : now.getDate() <= 15 ? "first" : "second";
  $("pRuns").innerHTML = `<div class="panel"><h2>Payroll</h2><p class="muted">Choose the pay period and press <b>Compute payroll</b>: basic pay, allowances, overtime, absences, SSS, PhilHealth, Pag-IBIG, withholding tax and loans are calculated automatically for every employee on payroll. Approved leave <i>without pay</i> is deducted by itself.</p>
    <div class="row"><label>Month<input type="month" id="rnMonth" value="${month}"></label><label>Pay period<select id="rnHalf"><option value="first"${half === "first" ? " selected" : ""}>1st - 15th</option><option value="second"${half === "second" ? " selected" : ""}>16th - end of month</option><option value="whole"${half === "whole" ? " selected" : ""}>Whole month</option></select></label>
      <label>Pay date<input type="date" id="rnPay" value="${S.draft ? S.draft.payDate : ""}"></label><button class="btn primary" id="rnGo" type="button">Compute payroll</button></div></div>
    ${S.draft ? draftHtml() : ""}
    <div class="panel"><h2>Saved payroll</h2><div class="tablewrap"><table><tr><th>Period</th><th>Pay date</th><th>Employees</th><th class="pr-num">Gross</th><th class="pr-num">Deductions</th><th class="pr-num">Net pay</th><th>Status</th><th></th></tr>
    ${S.runs.map((r) => `<tr><td><b>${esc(r.label)}</b></td><td>${dateText(r.payDate)}</td><td>${r.count}</td><td class="pr-num">${money(r.gross)}</td><td class="pr-num">${money(r.deductions)}</td><td class="pr-num">${money(r.net)}</td><td><span class="badge ${r.status === "Final" ? "active" : "warn"}">${esc(r.status)}</span></td>
      <td class="actions"><button class="btn small" data-open="${esc(r.id)}">${r.status === "Final" ? "View" : "Edit"}</button><button class="btn small" data-print="${esc(r.id)}">Print payslips</button>${r.status === "Final" ? "" : `<button class="btn small primary" data-final="${esc(r.id)}">Finalize</button><button class="btn small danger" data-delrun="${esc(r.id)}">Delete</button>`}</td></tr>`).join("") || `<tr><td colspan="8">No payroll saved yet.</td></tr>`}</table></div></div>`;
}
function draftHtml() {
  const d = S.draft, locked = d.status === "Final";
  const inp = (r, f, cls = "sm") => `<input class="pr-in ${cls}" type="number" min="0" step="${f === "otherEarn" || f === "otherDed" ? "0.01" : "0.5"}" data-r="${esc(r.key)}" data-f="${f}" value="${+r.inp[f] || 0}"${locked ? " disabled" : ""}>`;
  return `<div class="panel"><h2>${esc(d.per.label)} ${d.runId ? `<small>(saved ${locked ? "and final" : "as draft"})</small>` : ""}</h2>
    ${fromDtrBanner(d)}<p class="muted fine">Absences, late / undertime and overtime come from the <b>biometric DTR</b> when one was uploaded; you can still change them. Every figure recalculates at once.${S.settings.unpaidLeave ? " Unpaid leave from the leave requests is already included." : ""}</p>
    <div class="tablewrap"><table id="dTbl"><tr><th>Employee</th><th class="pr-num">Basic pay</th><th>Absent days</th><th>Late (min)</th><th>Overtime (hrs)</th><th>Other earnings</th><th>Other deductions</th><th class="pr-num">Gross</th><th class="pr-num">Deductions</th><th class="pr-num">Net pay</th></tr>
    ${d.rows.map((r) => `<tr data-row="${esc(r.key)}"><td><b>${esc(r.emp ? nameOf(r.emp) : r.info.name)}</b><small>${esc(r.info.employeeId)}${r.inp.dtr ? ` &middot; present ${r.inp.dtr.present} d, hours ${r.inp.dtr.hours}` : ""}${r.inp.leaveDays ? ` &middot; ${r.inp.leaveDays} day(s) unpaid leave` : ""}${+r.info.basicMonthly > 0 ? "" : ' <span class="pr-warn">no pay set</span>'}</small></td><td class="pr-num">${money(r.slip.basic)}</td>
      <td>${inp(r, "absentDays")}</td><td>${inp(r, "lateMin")}</td><td>${inp(r, "otHours")}</td><td>${inp(r, "otherEarn", "")}</td><td>${inp(r, "otherDed", "")}</td><td class="pr-num" data-c="gross">${money(r.slip.gross)}</td><td class="pr-num" data-c="ded">${money(r.slip.totalDed)}</td><td class="pr-num" data-c="net"><b>${money(r.slip.net)}</b></td></tr>`).join("")}
    <tr class="pr-tot" id="dTot">${totalsRow(d)}</tr></table></div>
    <div class="btnbar">${locked ? "" : `<button class="btn primary" id="rnSave" type="button">Save payroll (draft)</button>`}${locked ? "" : `<button class="btn" id="rnReload" type="button" title="Take the absences, late and overtime from the biometric DTR again">Reload from the biometric DTR</button>`}<button class="btn" id="rnClose" type="button">Close</button></div></div>`;
}
const fromDtrBanner = (d) => { const n = d.rows.filter((r) => r.inp.dtr).length, m = d.rows.length - n; return d.status === "Final" ? "" : `<p class="${m ? "pr-warn" : "muted"} fine">${n} employee${n === 1 ? "" : "s"} filled in from the biometric DTR${m ? `; <b>${m} without biometric data</b> (their absences, late and overtime are zero until you type them or upload the file).` : "."}</p>`; };
const totalsRow = (d) => `<td>TOTAL (${d.rows.length})</td><td class="pr-num">${money(sumBy(d.rows, (r) => r.slip.basic))}</td><td colspan="5"></td><td class="pr-num">${money(sumBy(d.rows, (r) => r.slip.gross))}</td><td class="pr-num">${money(sumBy(d.rows, (r) => r.slip.totalDed))}</td><td class="pr-num">${money(sumBy(d.rows, (r) => r.slip.net))}</td>`;
$("pRuns").addEventListener("input", (ev) => {      // recalculates one row while typing (no redraw, so the cursor stays)
  const t = ev.target; if (!t.dataset.r || !S.draft) return; const row = S.draft.rows.find((x) => x.key === t.dataset.r); if (!row) return;
  row.inp[t.dataset.f] = +t.value || 0; row.slip = computeSlip(row.info, row.inp, S.settings, S.draft.per);
  const tr = t.closest("tr"); tr.querySelector('[data-c="gross"]').textContent = money(row.slip.gross); tr.querySelector('[data-c="ded"]').textContent = money(row.slip.totalDed); tr.querySelector('[data-c="net"]').innerHTML = `<b>${money(row.slip.net)}</b>`; $("dTot").innerHTML = totalsRow(S.draft);
});
const slipDoc = (r, d, runId, label, status) => ({ schoolId: SID, runId, runLabel: label, start: d.per.start, end: d.per.end, payDate: d.payDate, employeeKey: r.key, employeeId: r.info.employeeId, name: r.emp ? nameOf(r.emp) : r.info.name, position: (r.emp && r.emp.position) || r.info.position || "", department: (r.emp && r.emp.department) || r.info.department || "",
  ...Object.fromEntries(["basic", "allow", "allowList", "ot", "otherEarn", "gross", "absent", "late", "sssEe", "phicEe", "hdmfEe", "sssEr", "phicEr", "hdmfEr", "tax", "other", "dedList", "totalDed", "net", "absentDays"].map((k) => [k, r.slip[k]])), inputs: { absentDays: +r.inp.absentDays || 0, lateMin: +r.inp.lateMin || 0, otHours: +r.inp.otHours || 0, otherEarn: +r.inp.otherEarn || 0, otherDed: +r.inp.otherDed || 0, leaveDays: r.inp.leaveDays || 0, dtr: r.inp.dtr || null }, status });
async function saveRun() {
  const d = S.draft; if (!d.rows.length) return flash("No employee is on payroll yet. Add the pay information first.");
  if (!d.runId && S.runs.some((r) => r.start === d.per.start && r.end === d.per.end)) { const a = await showPopup({ title: "This period already has a payroll", html: `<p>${esc(d.per.label)} was already saved. Save another one anyway?</p>`, buttons: [{ label: "Cancel", value: "no" }, { label: "Save anyway", value: "yes", primary: true }] }); if (a.value !== "yes") return; }
  const runId = d.runId || doc(collection(db, "payrollRuns")).id, b = writeBatch(db), ex = S.slips[runId] || [];
  b.set(doc(db, "payrollRuns", runId), { schoolId: SID, label: d.per.label, start: d.per.start, end: d.per.end, payDate: $("rnPay") && $("rnPay").value || d.payDate, kind: d.per.half, count: d.rows.length, gross: sumBy(d.rows, (r) => r.slip.gross), deductions: sumBy(d.rows, (r) => r.slip.totalDed), net: sumBy(d.rows, (r) => r.slip.net), status: "Draft", createdBy: user.uid, createdByName: profile.displayName, createdAt: serverTimestamp() }, { merge: true });
  d.rows.forEach((r) => { const old = ex.find((s) => s.employeeKey === r.key); b.set(old ? doc(db, "payslips", old.id) : doc(collection(db, "payslips")), { ...slipDoc(r, d, runId, d.per.label, "Draft"), createdBy: user.uid, createdAt: serverTimestamp() }, { merge: true }); });
  await b.commit(); delete S.slips[runId]; d.runId = runId; await refresh(); S.draft = d; rRuns(); flash("Payroll saved as a draft. Press Finalize when everything is correct.", true);
}
async function slipsOf(runId) { if (!S.slips[runId]) S.slips[runId] = (await bySchool2("payslips", runId)).sort((a, b) => String(a.name).localeCompare(String(b.name))); return S.slips[runId]; }
const bySchool2 = async (c, runId) => (await getDocs(query(collection(db, c), where("schoolId", "==", SID), where("runId", "==", runId)))).docs.map((d) => ({ id: d.id, ...d.data() }));
$("pRuns").addEventListener("click", (ev) => run(async () => {
  const t = ev.target.closest("button"); if (!t) return;
  if (t.id === "rnGo") { const m = $("rnMonth").value; if (!m) return flash("Choose the month."); await ensureDtr(periodOf(m, $("rnHalf").value)); newDraft(m, $("rnHalf").value, $("rnPay").value); return rRuns(); }
  if (t.id === "rnReload") { await ensureDtr(S.draft.per); S.draft.rows = S.draft.rows.map((r) => buildRow(r.info, r.emp, dtrInputs(r.info, S.draft.per) || {}, S.draft.per)); rRuns(); return flash("The absences, late / undertime and overtime were filled in again from the biometric DTR.", true); }
  if (t.id === "rnSave") return saveRun(); if (t.id === "rnClose") { S.draft = null; return rRuns(); }
  const id = t.dataset.open || t.dataset.print || t.dataset.final || t.dataset.delrun, r = S.runs.find((x) => x.id === id);
  if (t.dataset.open) {
    const slips = await slipsOf(id), per = { start: r.start, end: r.end, label: r.label, half: r.kind || "whole" };
    S.draft = { per, payDate: r.payDate, runId: id, status: r.status, rows: slips.map((s) => { const i = S.info.get(s.employeeKey) || { id: s.employeeKey, employeeId: s.employeeId, name: s.name, position: s.position, department: s.department, basicMonthly: 0 }; return r.status === "Final" ? { key: s.employeeKey, info: i, emp: empOf(i), inp: { ...s.inputs }, slip: { ...s, allowList: s.allowList || [], dedList: s.dedList || [] } } : buildRow(i, empOf(i), { ...s.inputs, leaveDays: 0 }, per); }) };
    rRuns(); return scrollTo({ top: 200, behavior: "smooth" });
  }
  if (t.dataset.print) return printSlips(await slipsOf(id));
  if (t.dataset.final) {
    const a = await showPopup({ title: `Finalize ${r.label}?`, html: `<p>The payslips of ${r.count} employees are locked. They can no longer be changed.</p>`, buttons: [{ label: "Cancel", value: "no" }, { label: "Finalize", value: "yes", primary: true }] }); if (a.value !== "yes") return;
    const slips = await slipsOf(id), b = writeBatch(db); b.update(doc(db, "payrollRuns", id), { status: "Final", finalizedAt: serverTimestamp() }); slips.forEach((s) => b.update(doc(db, "payslips", s.id), { status: "Final" })); await b.commit(); delete S.slips[id]; S.draft = null; await refresh(); return flash("Payroll finalized.", true);
  }
  if (t.dataset.delrun) {
    const a = await showPopup({ title: `Delete the draft ${r.label}?`, ok: false, html: `<p>The draft and its payslips are deleted.</p>`, buttons: [{ label: "Keep", value: "no" }, { label: "Delete", value: "yes", primary: true, danger: true }] }); if (a.value !== "yes") return;
    const slips = await slipsOf(id), b = writeBatch(db); slips.forEach((s) => b.delete(doc(db, "payslips", s.id))); b.delete(doc(db, "payrollRuns", id)); await b.commit(); delete S.slips[id]; S.draft = null; await refresh(); flash("Draft deleted.", true);
  }
}));

/* ---------- payslips: ready to print, two copies on one landscape page ---------- */
function slipHtml(s, copy) {
  const st = S.settings, logo = school && school.logo ? `<img src="${esc(school.logo)}" alt="">` : "", sch = (school && (school.displayName || school.name)) || "";
  const earn = [["Basic pay", s.basic], ...(s.allowList || []).map((a) => [a.label || "Allowance", a.amount]), ...(s.ot ? [["Overtime", s.ot]] : []), ...(s.otherEarn ? [["Other earnings", s.otherEarn]] : [])];
  const ded = [...(s.absent ? [[`Absences (${s.absentDays || 0} day${+s.absentDays === 1 ? "" : "s"})`, s.absent]] : []), ...(s.late ? [["Late / undertime", s.late]] : []), ["SSS", s.sssEe], ["PhilHealth", s.phicEe], ["Pag-IBIG", s.hdmfEe], ["Withholding tax", s.tax], ...(s.dedList || []).map((d) => [d.label || "Deduction", d.amount]), ...((+s.other - sumBy(s.dedList || [], (d) => d.amount)) > 0 ? [["Other deductions", r2(s.other - sumBy(s.dedList || [], (d) => d.amount))]] : [])];
  const n = Math.max(earn.length, ded.length, 5), rows = Array.from({ length: n }, (_, i) => `<tr><td>${earn[i] ? esc(earn[i][0]) : "&nbsp;"}</td><td class="r">${earn[i] ? money(earn[i][1]) : ""}</td><td>${ded[i] ? esc(ded[i][0]) : ""}</td><td class="r">${ded[i] ? money(ded[i][1]) : ""}</td></tr>`).join("");
  return `<div class="ps"><div class="hd">${logo}<div><p><b style="font-size:12px">${esc(sch)}</b></p><p>Finance - Payroll &middot; <b>${esc(copy)}</b></p></div></div><h1>PAYSLIP</h1>
  <table><tr><td colspan="2"><small>Employee</small><br><b>${esc(s.name)}</b></td><td><small>Employee No.</small><br><b>${esc(s.employeeId)}</b></td><td><small>Pay period</small><br><b>${esc(s.runLabel)}</b></td></tr>
  <tr><td colspan="2"><small>Position</small><br>${esc(s.position || "-")}</td><td><small>Department</small><br>${esc(s.department || "-")}</td><td><small>Pay date</small><br>${esc(dateText(s.payDate))}</td></tr></table>
  <table style="margin-top:4px"><tr><th>EARNINGS</th><th>Amount</th><th>DEDUCTIONS</th><th>Amount</th></tr>${rows}<tr class="tot"><td>GROSS PAY</td><td class="r">${money(s.gross)}</td><td>TOTAL DEDUCTIONS</td><td class="r">${money(s.totalDed)}</td></tr></table>
  ${s.inputs && s.inputs.dtr ? `<p><small>Attendance: present ${s.inputs.dtr.present} day(s) &middot; absent ${s.inputs.dtr.absent} &middot; late ${s.inputs.dtr.lateMin} min &middot; undertime ${s.inputs.dtr.utMin} min &middot; overtime ${s.inputs.dtr.otHrs} hr(s) &middot; hours worked ${s.inputs.dtr.hours}</small></p>` : ""}
  <div class="net">NET PAY: ${money(s.net)}</div>
  <div class="sg"><div>Received by (employee)</div><div>Prepared by<br><b>${esc(st.preparedBy || profile.displayName)}</b></div><div>${esc(st.approvedTitle || "Approved by")}<br><b>${esc(st.approvedBy || "")}</b></div></div>
  <p><small>${s.status === "Final" ? "" : "DRAFT - not final. "}Generated ${esc(new Date().toLocaleString())}</small></p></div>`;
}
function printWindow(bodyHtml, title, landscape = true) {
  const w = window.open("", "_blank"); if (!w) return flash("Your browser blocked the print window. Allow pop-ups for this site.");
  const base = new URL("css/style.css", location.href).href, css = new URL("css/payroll.css", location.href).href;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="${base}"><link rel="stylesheet" href="${css}"><style>@page{size:A4 ${landscape ? "landscape" : "portrait"};margin:6mm}body{background:#fff;margin:0}
    .pg{display:flex;page-break-after:always;height:${landscape ? "196mm" : "280mm"};overflow:hidden}.pg:last-child{page-break-after:auto}.half{flex:1 1 50%;width:50%;padding:0 5mm;box-sizing:border-box}.half+.half{border-left:1.5px dashed #777}
    .ps th,.ps .tot td,.ps .net{-webkit-print-color-adjust:exact;print-color-adjust:exact}table{font-size:9px}</style></head><body>${bodyHtml}<script>addEventListener("load",function(){setTimeout(function(){focus();print()},300)})<\/script></body></html>`);
  w.document.close();
}
function printSlips(slips) {
  if (!slips.length) return flash("There is no payslip to print.");
  printWindow(slips.map((s) => `<div class="pg"><div class="half">${slipHtml(s, "EMPLOYEE COPY")}</div><div class="half">${slipHtml(s, "PAYROLL OFFICE COPY")}</div></div>`).join(""), "Payslips");
}
const runSelect = (id, val) => `<label>Payroll<select id="${id}"><option value="">- choose -</option>${S.runs.map((r) => `<option value="${esc(r.id)}"${r.id === val ? " selected" : ""}>${esc(r.label)} (${esc(r.status)})</option>`).join("")}</select></label>`;
async function rSlips() {
  if (!S.slipRun && S.runs[0]) S.slipRun = S.runs[0].id;
  const slips = S.slipRun ? await slipsOf(S.slipRun).catch(() => []) : [], q = S.q.toLowerCase(), l = slips.filter((s) => !q || (s.name + s.employeeId).toLowerCase().includes(q));
  $("pSlips").innerHTML = `<div class="panel"><h2>Payslips</h2><p class="muted">Every payslip prints on <b>one landscape page with two copies</b>: the employee copy on the left and the payroll office copy on the right.</p>
    <div class="row">${runSelect("psRun", S.slipRun)}<label>Search<input id="psQ" value="${esc(S.q)}" placeholder="Employee No. or name" autocomplete="off"></label><button class="btn primary" id="psAll" type="button"${l.length ? "" : " disabled"}>Print all (${l.length})</button></div>
    <div class="tablewrap"><table><tr><th>Employee No.</th><th>Name</th><th>Position</th><th class="pr-num">Gross</th><th class="pr-num">Deductions</th><th class="pr-num">Net pay</th><th>Status</th><th></th></tr>
    ${l.map((s) => `<tr><td>${esc(s.employeeId)}</td><td>${esc(s.name)}</td><td>${esc(s.position || "-")}</td><td class="pr-num">${money(s.gross)}</td><td class="pr-num">${money(s.totalDed)}</td><td class="pr-num"><b>${money(s.net)}</b></td><td>${esc(s.status)}</td><td class="actions"><button class="btn small" data-ps="${esc(s.id)}">Print payslip</button></td></tr>`).join("") || `<tr><td colspan="8">${S.runs.length ? "No payslip in this payroll." : "Compute a payroll first (Payroll tab)."}</td></tr>`}</table></div></div>`;
  $("psRun").onchange = (e) => { S.slipRun = e.target.value; rSlips(); };
  $("psQ").oninput = (e) => { S.q = e.target.value; const p = e.target.selectionStart; rSlips().then(() => { const n = $("psQ"); n.focus(); n.setSelectionRange(p, p); }); };
  $("psAll").onclick = () => printSlips(l);
  $("pSlips").onclick = (ev) => { const b = ev.target.closest("[data-ps]"); if (b) printSlips(slips.filter((s) => s.id === b.dataset.ps)); };
}

/* ---------- reports ---------- */
async function rReports() {
  if (!S.repRun && S.runs[0]) S.repRun = S.runs[0].id;
  const slips = S.repRun ? await slipsOf(S.repRun).catch(() => []) : [], run0 = S.runs.find((r) => r.id === S.repRun);
  const T = (k) => sumBy(slips, (s) => s[k]);
  const dep = {}; slips.forEach((s) => { const d = s.department || "No department"; const x = (dep[d] ||= { n: 0, gross: 0, ded: 0, net: 0 }); x.n++; x.gross += s.gross; x.ded += s.totalDed; x.net += s.net; });
  $("pReports").innerHTML = `<div class="panel"><h2>Reports</h2><div class="row">${runSelect("rpRun", S.repRun)}<button class="btn primary" id="rpPrint" type="button"${slips.length ? "" : " disabled"}>Print report</button><button class="btn" id="rpXls" type="button"${slips.length ? "" : " disabled"}>Download Excel</button></div></div>
  <div id="rpBody">${!slips.length ? `<div class="panel"><p class="muted">${S.runs.length ? "Choose a payroll." : "No payroll yet."}</p></div>` : `
  <div class="panel"><h2>Payroll register - ${esc(run0.label)}</h2><div class="tablewrap"><table><tr><th>Employee No.</th><th>Name</th><th>Department</th><th class="pr-num">Basic</th><th class="pr-num">Allow.</th><th class="pr-num">OT / other</th><th class="pr-num">Gross</th><th class="pr-num">Absent / late</th><th class="pr-num">SSS</th><th class="pr-num">PhilHealth</th><th class="pr-num">Pag-IBIG</th><th class="pr-num">Tax</th><th class="pr-num">Loans / other</th><th class="pr-num">Net pay</th></tr>
    ${slips.map((s) => `<tr><td>${esc(s.employeeId)}</td><td>${esc(s.name)}</td><td>${esc(s.department || "")}</td><td class="pr-num">${money(s.basic)}</td><td class="pr-num">${money(s.allow)}</td><td class="pr-num">${money(r2(s.ot + s.otherEarn))}</td><td class="pr-num">${money(s.gross)}</td><td class="pr-num">${money(r2(s.absent + s.late))}</td><td class="pr-num">${money(s.sssEe)}</td><td class="pr-num">${money(s.phicEe)}</td><td class="pr-num">${money(s.hdmfEe)}</td><td class="pr-num">${money(s.tax)}</td><td class="pr-num">${money(s.other)}</td><td class="pr-num"><b>${money(s.net)}</b></td></tr>`).join("")}
    <tr class="pr-tot"><td colspan="3">TOTAL (${slips.length})</td><td class="pr-num">${money(T("basic"))}</td><td class="pr-num">${money(T("allow"))}</td><td class="pr-num">${money(r2(T("ot") + T("otherEarn")))}</td><td class="pr-num">${money(T("gross"))}</td><td class="pr-num">${money(r2(T("absent") + T("late")))}</td><td class="pr-num">${money(T("sssEe"))}</td><td class="pr-num">${money(T("phicEe"))}</td><td class="pr-num">${money(T("hdmfEe"))}</td><td class="pr-num">${money(T("tax"))}</td><td class="pr-num">${money(T("other"))}</td><td class="pr-num">${money(T("net"))}</td></tr></table></div></div>
  <div class="pr-grid"><div class="pr-card"><h3>By department</h3><div class="tablewrap"><table><tr><th>Department</th><th>Employees</th><th class="pr-num">Gross</th><th class="pr-num">Deductions</th><th class="pr-num">Net</th></tr>${Object.entries(dep).map(([d, v]) => `<tr><td>${esc(d)}</td><td>${v.n}</td><td class="pr-num">${money(v.gross)}</td><td class="pr-num">${money(v.ded)}</td><td class="pr-num">${money(v.net)}</td></tr>`).join("")}</table></div></div>
  <div class="pr-card"><h3>Government remittances and tax</h3><div class="tablewrap"><table><tr><th></th><th class="pr-num">Employee share</th><th class="pr-num">Employer share</th><th class="pr-num">Total to remit</th></tr>
    ${[["SSS", "sssEe", "sssEr"], ["PhilHealth", "phicEe", "phicEr"], ["Pag-IBIG", "hdmfEe", "hdmfEr"]].map(([l, a, b]) => `<tr><td>${l}</td><td class="pr-num">${money(T(a))}</td><td class="pr-num">${money(T(b))}</td><td class="pr-num">${money(r2(T(a) + T(b)))}</td></tr>`).join("")}<tr><td>Withholding tax</td><td class="pr-num">${money(T("tax"))}</td><td class="pr-num">-</td><td class="pr-num">${money(T("tax"))}</td></tr></table></div></div></div>`}</div>`;
  $("rpRun").onchange = (e) => { S.repRun = e.target.value; rReports(); };
  if ($("rpPrint")) $("rpPrint").onclick = () => printWindow(`<div style="padding:4mm"><div class="ps"><h1>${esc((school && (school.displayName || school.name)) || "")} - PAYROLL REPORT</h1></div>${$("rpBody").innerHTML}</div>`, "Payroll report");
  if ($("rpXls")) $("rpXls").onclick = () => {
    if (!window.XLSX) return flash("The Excel writer did not load. Check your internet connection.");
    const wb = XLSX.utils.book_new(), reg = slips.map((s) => ({ "Employee No.": s.employeeId, Name: s.name, Position: s.position, Department: s.department, Basic: s.basic, Allowances: s.allow, Overtime: s.ot, "Other earnings": s.otherEarn, Gross: s.gross, Absences: s.absent, Late: s.late, SSS: s.sssEe, PhilHealth: s.phicEe, "Pag-IBIG": s.hdmfEe, Tax: s.tax, "Loans / other": s.other, "Total deductions": s.totalDed, "Net pay": s.net }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reg), "Payroll register");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([["SSS", T("sssEe"), T("sssEr")], ["PhilHealth", T("phicEe"), T("phicEr")], ["Pag-IBIG", T("hdmfEe"), T("hdmfEr")], ["Withholding tax", T("tax"), 0]].map(([k, a, b]) => ({ Item: k, "Employee share": a, "Employer share": b, "Total to remit": r2(a + b) }))), "Remittances");
    XLSX.writeFile(wb, `payroll-${run0.start}.xlsx`);
  };
}

/* ---------- settings ---------- */
const holRow = (d, l) => `<div class="r"><input type="date" value="${esc(d || "")}"><input placeholder="Holiday name" maxlength="40" value="${esc(l || "")}"><button class="btn small danger" type="button" data-holrm="1">Remove</button></div>`;
function rSettings() {
  const s = S.settings, n = (id, v, step = "0.01") => `<input type="number" id="${id}" step="${step}" value="${v}">`, ck = (id, v) => `<label class="sc-chk"><input type="checkbox" id="${id}"${v ? " checked" : ""}> On</label>`;
  $("pSettings").innerHTML = `<div class="panel"><h2>Settings</h2><p class="muted">These are the rates the automatic computation uses. They start with the current Philippine rates (2026) but the government changes them, so <b>check them with the latest circulars</b>. A school under GSIS can change the rates below (or switch SSS off).</p>
  <div class="pr-card"><h3>Pay</h3><div class="row"><label>Pay frequency<select id="sFreq"><option value="semi"${s.frequency === "semi" ? " selected" : ""}>Twice a month (1st-15th and 16th-end)</option><option value="monthly"${s.frequency === "monthly" ? " selected" : ""}>Once a month</option></select></label>
    <label>Working days a month <small>(daily rate = monthly pay / this)</small>${n("sDays", s.workDays, "1")}</label><label>Hours a day${n("sHours", s.hoursPerDay, "0.5")}</label><label>Overtime rate <small>(x hourly rate)</small>${n("sOt", s.otRate)}</label>
    <label>Contributions are taken<select id="sTiming"><option value="split"${s.contribTiming === "split" ? " selected" : ""}>Half in each pay</option><option value="first"${s.contribTiming === "first" ? " selected" : ""}>All in the 1st pay</option><option value="second"${s.contribTiming === "second" ? " selected" : ""}>All in the 2nd pay</option></select></label>
    <label class="sc-chk" style="margin-top:1.6rem"><input type="checkbox" id="sLeave"${s.unpaidLeave ? " checked" : ""}> Deduct approved leave without pay automatically</label></div></div>
  <div class="pr-card"><h3>SSS</h3><div class="row"><label>Deduct${ck("sSssOn", s.sss.on)}</label><label>Employee rate %${n("sSssR", s.sss.rate)}</label><label>Employer rate %${n("sSssE", s.sss.erRate)}</label><label>Employer EC (PHP)${n("sSssEc", s.sss.ec)}</label><label>Lowest salary credit${n("sSssMin", s.sss.min, "1")}</label><label>Highest salary credit${n("sSssMax", s.sss.max, "1")}</label></div></div>
  <div class="pr-card"><h3>PhilHealth</h3><div class="row"><label>Deduct${ck("sPhOn", s.phic.on)}</label><label>Premium rate % (total)${n("sPhR", s.phic.rate)}</label><label>Employee share %${n("sPhS", s.phic.employeeShare, "1")}</label><label>Lowest base pay${n("sPhMin", s.phic.min, "1")}</label><label>Highest base pay${n("sPhMax", s.phic.max, "1")}</label></div></div>
  <div class="pr-card"><h3>Pag-IBIG</h3><div class="row"><label>Deduct${ck("sHdOn", s.hdmf.on)}</label><label>Employee rate %${n("sHdR", s.hdmf.rate)}</label><label>Employer rate %${n("sHdE", s.hdmf.erRate)}</label><label>Monthly fund salary cap${n("sHdCap", s.hdmf.cap, "1")}</label></div></div>
  <div class="pr-card"><h3>Withholding tax (yearly taxable income)</h3><div class="row"><label>Deduct${ck("sTxOn", s.tax.on)}</label></div><div class="tablewrap"><table id="sTax"><tr><th>Over (PHP a year)</th><th>Rate %</th><th>Plus fixed amount (PHP)</th></tr>
    ${s.tax.brackets.map((b) => `<tr><td><input class="pr-in" type="number" step="1" value="${b.over}"></td><td><input class="pr-in sm" type="number" step="0.01" value="${b.rate}"></td><td><input class="pr-in" type="number" step="0.01" value="${b.base}"></td></tr>`).join("")}</table></div>
    <p class="muted fine">Tax is estimated on the regular pay (annualized, after SSS, PhilHealth and Pag-IBIG). 13th month and bonuses are not included.</p></div>
  <div class="pr-card"><h3>Biometric DTR (work schedule and rules)</h3><p class="muted fine">How the biometric punches become hours, late, undertime, overtime and absences. An employee can have an own work start / end under Add information.</p>
    <div class="row"><label>Work starts<input type="time" id="dStart" value="${esc(s.dtr.start)}"></label><label>Work ends<input type="time" id="dEnd" value="${esc(s.dtr.end)}"></label><label>Lunch break to deduct (minutes)${n("dLunch", s.dtr.lunchMin, "5")}</label>
      <label>Grace period for late (minutes)${n("dGrace", s.dtr.graceMin, "1")}</label><label>Overtime starts after (minutes past the end)${n("dOtS", s.dtr.otStartMin, "5")}</label><label>Overtime is counted in blocks of (minutes)${n("dOtB", s.dtr.otBlockMin, "5")}</label>
      <label>Half day when worked less than (hours)${n("dHalf", s.dtr.halfDayHrs, "0.5")}</label><label>Date order in the file<select id="dOrder"><option value="MDY"${s.dtr.dateOrder === "MDY" ? " selected" : ""}>Month / Day / Year</option><option value="DMY"${s.dtr.dateOrder === "DMY" ? " selected" : ""}>Day / Month / Year</option></select></label></div>
    <div class="row"><fieldset class="sc-days"><legend>Working days</legend>${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label class="sc-chk"><input type="checkbox" data-wd="${d}"${s.dtr.workDays.includes(d) ? " checked" : ""}> ${DOW[d]}</label>`).join("")}</fieldset>
      <label class="sc-chk" style="margin-top:1.6rem"><input type="checkbox" id="dRest"${s.dtr.restDayAsOt ? " checked" : ""}> Work on a rest day or holiday counts as overtime</label></div>
    <h3>Holidays (no work, nobody is absent)</h3><div class="pr-rows" id="sHol">${s.dtr.holidays.map((h) => holRow(h.date, h.label)).join("")}</div><button class="btn small" type="button" id="sHolAdd">Add a holiday</button></div>
  <div class="pr-card"><h3>Names printed on the payslip</h3><div class="row"><label>Prepared by<input id="sPrep" maxlength="80" value="${esc(s.preparedBy)}" placeholder="${esc(profile.displayName)}"></label><label>Approved by<input id="sAppr" maxlength="80" value="${esc(s.approvedBy)}"></label><label>Title of the approver<input id="sApprT" maxlength="60" value="${esc(s.approvedTitle)}"></label></div></div>
  <div class="btnbar"><button class="btn primary" id="sSave" type="button">Save settings</button><button class="btn" id="sReset" type="button">Restore the default rates</button></div></div>`;
  $("sHolAdd").onclick = () => $("sHol").insertAdjacentHTML("beforeend", holRow("", ""));
  $("sHol").onclick = (e) => { const b = e.target.closest("[data-holrm]"); if (b) b.closest(".r").remove(); };
  $("sSave").onclick = () => run(async () => {
    const v = (id) => +$(id).value, c = (id) => $(id).checked;
    const brackets = [...document.querySelectorAll("#sTax tr")].slice(1).map((r) => { const i = r.querySelectorAll("input"); return { over: +i[0].value || 0, rate: +i[1].value || 0, base: +i[2].value || 0 }; }).sort((a, b) => a.over - b.over);
    if (!brackets.length || brackets[0].over !== 0) return flash("The first tax row must start at 0.");
    if (!(v("sDays") >= 1 && v("sHours") > 0)) return flash("Check the working days and hours.");
    if (toMin($("dStart").value || "08:00") >= toMin($("dEnd").value || "17:00")) return flash("The work end time must be after the work start time.");
    if (!document.querySelector("[data-wd]:checked")) return flash("Tick at least one working day.");
    const data = { schoolId: SID, frequency: $("sFreq").value, workDays: v("sDays"), hoursPerDay: v("sHours"), otRate: v("sOt"), contribTiming: $("sTiming").value, unpaidLeave: c("sLeave"),
      sss: { on: c("sSssOn"), rate: v("sSssR"), erRate: v("sSssE"), ec: v("sSssEc"), min: v("sSssMin"), max: v("sSssMax"), step: 500 }, phic: { on: c("sPhOn"), rate: v("sPhR"), employeeShare: v("sPhS"), min: v("sPhMin"), max: v("sPhMax") },
      hdmf: { on: c("sHdOn"), rate: v("sHdR"), erRate: v("sHdE"), cap: v("sHdCap") }, tax: { on: c("sTxOn"), brackets }, dtr: { start: $("dStart").value || "08:00", end: $("dEnd").value || "17:00", lunchMin: v("dLunch"), graceMin: v("dGrace"), otStartMin: v("dOtS"), otBlockMin: Math.max(5, v("dOtB")), halfDayHrs: v("dHalf"), dateOrder: $("dOrder").value, restDayAsOt: c("dRest"), workDays: [...document.querySelectorAll("[data-wd]:checked")].map((x) => +x.dataset.wd),
        holidays: [...document.querySelectorAll("#sHol .r")].map((r) => { const i = r.querySelectorAll("input"); return { date: i[0].value, label: i[1].value.trim() }; }).filter((h) => h.date) }, preparedBy: $("sPrep").value.trim(), approvedBy: $("sAppr").value.trim(), approvedTitle: $("sApprT").value.trim(), updatedAt: serverTimestamp() };
    await setDoc(doc(db, "payrollSettings", SID), data); await refresh(); flash("Settings saved. New computations use them; saved payroll is not changed.", true);
  });
  $("sReset").onclick = () => run(async () => { const a = await showPopup({ title: "Restore the default rates?", html: "<p>Your changes to the rates and the tax table are replaced by the defaults.</p>", buttons: [{ label: "Cancel", value: "no" }, { label: "Restore", value: "yes", primary: true }] }); if (a.value !== "yes") return; await setDoc(doc(db, "payrollSettings", SID), { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), schoolId: SID, updatedAt: serverTimestamp() }); await refresh(); flash("Defaults restored.", true); });
}

await refresh(); show("dash");
liveRefresh(["employees", "payrollInfo", "payrollRuns", "payrollSettings", "leaveRequests", "payrollDtr"], () => { S.dtr = {}; return S.draft || S.form || S.up || S.dtrView ? null : refresh(); });   // not while a payroll or a form is open
