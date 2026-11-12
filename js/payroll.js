/* Finance - Payroll account.
   Dashboard | Add information (pay information per employee) | Payroll (automatic computation per pay period) | Payslips (ready to print, 2 copies on one landscape page)
   | Reports (register, by department, SSS / PhilHealth / Pag-IBIG / tax) | Settings (rates, tax table, signatories).
   Everything is kept in the school's Google Sheet (tabs payrollInfo, payrollSettings, payrollRuns, payslips); only this account can read it. */
import { requireRole, logout, db, esc, friendlyError, applyBranding } from "./auth.js";
import { collection, query, where, getDocs, getDoc, doc, setDoc, writeBatch, serverTimestamp, liveRefresh } from "./db.js";
import { showPopup } from "./leave.js";
import { mergeSettings, DEFAULT_SETTINGS, computeSlip, periodOf, customPeriod, payDateOf, weekdaysIn, r2, CUTOFFS, cutoffPeriod, cutOfDates, isHourly } from "./payroll-calc.js";
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

const openWork = () => !!(S.draft || S.form || S.up || S.dtrView || Object.keys(S.pendingPay || {}).length);
async function refresh(quiet) {
  await run(async () => {
    const [emps, info, runs, leave, set] = await Promise.all([bySchool("employees"), bySchool("payrollInfo"), bySchool("payrollRuns"), bySchool("leaveRequests").catch(() => []), getDoc(doc(db, "payrollSettings", SID)).catch(() => null)]);
    S.emps = emps.filter((e) => (e.status || "Active") === "Active").sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    S.info = new Map(info.map((i) => [i.id, i])); S.runs = runs.sort((a, b) => String(b.start).localeCompare(String(a.start)) || String(b.createdAt?.seconds || 0).localeCompare(String(a.createdAt?.seconds || 0)));
    S.leave = leave; S.settings = mergeSettings(set && set.exists() ? set.data() : null);
    if (quiet && openWork()) return flash("Updated. What you have open (payroll, form or DTR) was left as it is.", true);   // pressing Update never wipes your work
    render();
  });
}
const empOf = (infoDoc) => S.emps.find((e) => e.id === infoDoc.id) || null;

/* ---------- tabs ---------- */
function show(t) { S.tab = t; document.querySelectorAll("[data-s]").forEach((s) => (s.hidden = s.dataset.s !== t)); document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t)); render(); }
$("tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.t); };
function render() {
  Promise.resolve(({ dash: rDash, info: rInfo, dtr: rDtr, runs: rRuns, slips: rSlips, reports: rReports, settings: rSettings }[S.tab] || rDash)()).catch((e) => { console.error(e); flash(friendlyError(e)); });
}

/* ---------- dashboard ---------- */
const LOAN_TYPES = ["SSS salary loan", "SSS calamity loan", "Pag-IBIG loan", "GSIS loan", "Bank / other loan", "Other deduction"];
const tracked = (d) => d.balance !== undefined && d.balance !== null && d.balance !== "" && !isNaN(+d.balance);
const lastPay = (i) => { const h = ((i.ca && i.ca.history) || []).filter((x) => x.type === "payment"); return h.length ? h[h.length - 1].date : ""; };
/** Who has a cash advance (with the balance) and who has a loan or other deduction: used on the Dashboard and in Reports. */
function balancesHtml() {
  const act = [...S.info.values()].filter((i) => i.active !== false), nm = (i) => (empOf(i) ? nameOf(empOf(i)) : i.name), dp = (i) => (empOf(i) || i).department || "";
  const ca = act.filter((i) => +(i.ca && i.ca.balance) > 0).sort((a, b) => b.ca.balance - a.ca.balance);
  const loans = act.flatMap((i) => (i.deductions || []).filter((d) => +d.amount > 0 || (tracked(d) && +d.balance > 0)).map((d) => ({ i, d }))).sort((a, b) => nm(a.i).localeCompare(nm(b.i)));
  return `<div class="pr-grid"><div class="pr-card"><h3>Cash advance balances <small>(${ca.length} employee${ca.length === 1 ? "" : "s"}, total ${money(sumBy(ca, (i) => i.ca.balance))})</small></h3><div class="tablewrap"><table><tr><th>Employee No.</th><th>Name</th><th>Department</th><th class="pr-num">Deducted every pay</th><th>Last deduction</th><th class="pr-num">Balance</th></tr>
    ${ca.map((i) => `<tr><td>${esc(i.employeeId)}</td><td>${esc(nm(i))}</td><td>${esc(dp(i))}</td><td class="pr-num">${money(i.ca.perPay)}</td><td>${lastPay(i) ? dateText(lastPay(i)) : "-"}</td><td class="pr-num"><b>${money(i.ca.balance)}</b></td></tr>`).join("") || `<tr><td colspan="6">Nobody has a cash advance balance.</td></tr>`}
    ${ca.length ? `<tr class="pr-tot"><td colspan="5">TOTAL CASH ADVANCE BALANCE</td><td class="pr-num">${money(sumBy(ca, (i) => i.ca.balance))}</td></tr>` : ""}</table></div></div>
  <div class="pr-card"><h3>Loans and other deductions <small>(${loans.length})</small></h3><div class="tablewrap"><table><tr><th>Employee</th><th>Loan / deduction</th><th class="pr-num">Per month</th><th class="pr-num">Balance</th></tr>
    ${loans.map(({ i, d }) => `<tr><td>${esc(nm(i))}<small>${esc(i.employeeId)}</small></td><td>${esc(d.type || "")}${d.label && d.label !== d.type ? `<small>${esc(d.label)}</small>` : ""}</td><td class="pr-num">${money(d.amount)}</td><td class="pr-num">${tracked(d) ? `<b>${money(d.balance)}</b>` : '<span class="muted">not tracked</span>'}</td></tr>`).join("") || `<tr><td colspan="4">No loan or other deduction set up.</td></tr>`}</table></div></div></div>`;
}
async function rDash() {
  const act = [...S.info.values()].filter((i) => i.active !== false), missing = S.emps.filter((e) => !S.info.has(e.id)), noPay = act.filter((i) => !(+i.basicMonthly > 0));
  const monthlyBasic = sumBy(act, (i) => i.basicMonthly), monthlyAllow = sumBy(act, (i) => sumBy(i.allowances || [], (a) => a.amount)), last = S.runs[0];
  const caList = act.filter((i) => +(i.ca && i.ca.balance) > 0), caTotal = sumBy(caList, (i) => i.ca.balance);
  const dep = {}; act.forEach((i) => { const d = (empOf(i) || i).department || "No department"; (dep[d] ||= { n: 0, pay: 0 }); dep[d].n++; dep[d].pay += +i.basicMonthly || 0; });
  const maxPay = Math.max(1, ...Object.values(dep).map((x) => x.pay));
  const slips = last ? await slipsOf(last.id).catch(() => []) : [], T = (k) => sumBy(slips, (x) => x[k]);
  const month = localDate().slice(0, 7), dtr = await loadDtr(month).catch(() => []), dt = (k) => r2(dtr.reduce((n, x) => n + (+(x.totals || {})[k] || 0), 0));
  $("pDash").innerHTML = `<div class="cards">
    <div class="stat"><b>${act.length}</b><span>Employees on payroll</span></div><div class="stat"><b>${money(monthlyBasic)}</b><span>Monthly basic pay</span></div>
    <div class="stat"><b>${money(monthlyAllow)}</b><span>Monthly allowances</span></div><div class="stat${missing.length || noPay.length ? " warn" : ""}"><b>${missing.length + noPay.length}</b><span>Need pay information</span></div>
    <div class="stat${caList.length ? " warn" : ""}"><b>${money(caTotal)}</b><span>Cash advance balance (${caList.length} employee${caList.length === 1 ? "" : "s"})</span></div>
    <div class="stat"><b>${last ? money(last.net) : "-"}</b><span>${last ? "Net pay, " + esc(last.label) : "No payroll yet"}</span></div></div>
  ${missing.length || noPay.length ? `<div class="notice err">${missing.length ? `${missing.length} employee${missing.length === 1 ? " has" : "s have"} no pay record yet. ` : ""}${noPay.length ? `${noPay.length} on payroll ${noPay.length === 1 ? "has" : "have"} no monthly pay set. ` : ""}Open <b>Add information</b>.</div>` : ""}
  ${last && slips.length ? `<div class="pr-card"><h3>Latest payroll: ${esc(last.label)} <small>(${esc(last.status)}, pay date ${dateText(last.payDate)})</small></h3><div class="tablewrap"><table><tr><th>Gross pay</th><th>Absences / late</th><th>SSS</th><th>PhilHealth</th><th>Pag-IBIG</th><th>Tax</th><th>Cash advance</th><th>Loans / other</th><th>Total deductions</th><th>Net pay</th></tr>
    <tr><td class="pr-num">${money(T("gross"))}</td><td class="pr-num">${money(r2(T("absent") + T("late")))}</td><td class="pr-num">${money(T("sssEe"))}</td><td class="pr-num">${money(T("phicEe"))}</td><td class="pr-num">${money(T("hdmfEe"))}</td><td class="pr-num">${money(T("tax"))}</td><td class="pr-num">${money(T("caDed"))}</td><td class="pr-num">${money(T("other"))}</td><td class="pr-num">${money(T("totalDed"))}</td><td class="pr-num"><b>${money(T("net"))}</b></td></tr></table></div>
    <p class="muted fine">To remit: SSS ${money(r2(T("sssEe") + T("sssEr")))} &middot; PhilHealth ${money(r2(T("phicEe") + T("phicEr")))} &middot; Pag-IBIG ${money(r2(T("hdmfEe") + T("hdmfEr")))} &middot; Withholding tax ${money(T("tax"))}</p></div>` : ""}
  ${balancesHtml()}
  <div class="pr-card"><h3>Attendance this month <small>(${esc(month)}, from the biometric DTR)</small></h3>${dtr.length ? `<p>${dtr.length} employee${dtr.length === 1 ? "" : "s"} with a DTR &middot; days absent <b>${dt("absent")}</b> &middot; late <b>${dt("late")}</b> min &middot; undertime <b>${dt("ut")}</b> min &middot; overtime <b>${r2(dt("ot") / 60)}</b> hr(s) &middot; <span class="${dt("inc") ? "pr-warn" : ""}">days with a missing punch: <b>${dt("inc")}</b></span></p>` : `<p class="muted">No biometric DTR for this month yet.</p>`}</div>
  <div class="pr-grid"><div class="pr-card"><h3>Monthly basic pay by department</h3><div class="tablewrap"><table><tr><th>Department</th><th>Employees</th><th class="pr-num">Monthly basic</th><th></th></tr>
    ${Object.entries(dep).sort((a, b) => b[1].pay - a[1].pay).map(([d, v]) => `<tr><td>${esc(d)}</td><td>${v.n}</td><td class="pr-num">${money(v.pay)}</td><td style="width:30%"><span class="pr-bar"><i style="width:${Math.round(v.pay / maxPay * 100)}%"></i></span></td></tr>`).join("") || `<tr><td colspan="4">No employee on payroll yet.</td></tr>`}</table></div></div>
  <div class="pr-card"><h3>Recent payroll</h3><div class="tablewrap"><table><tr><th>Period</th><th>Employees</th><th class="pr-num">Gross</th><th class="pr-num">Net</th><th>Status</th></tr>
    ${S.runs.slice(0, 6).map((r) => `<tr><td>${esc(r.label)}</td><td>${r.count}</td><td class="pr-num">${money(r.gross)}</td><td class="pr-num">${money(r.net)}</td><td><span class="badge ${r.status === "Final" ? "active" : "warn"}">${esc(r.status)}</span></td></tr>`).join("") || `<tr><td colspan="5">No payroll run yet.</td></tr>`}</table></div></div></div>
  <div class="btnbar"><button class="btn" id="dBalXls" type="button">Download cash advance and loan balances (Excel)</button></div>
  <p class="muted fine">Contribution rates and the tax table are <b>defaults</b>. Check them under <b>Settings</b> before the first payroll: the government changes them from time to time.</p>`;
  $("dBalXls").onclick = () => balancesXls();
}
function balancesXls() {
  if (!window.XLSX) return flash("The Excel writer did not load. Check your internet connection.");
  const act = [...S.info.values()].filter((i) => i.active !== false), nm = (i) => (empOf(i) ? nameOf(empOf(i)) : i.name), wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(act.filter((i) => +(i.ca && i.ca.balance) > 0).map((i) => ({ "Employee No.": i.employeeId, Name: nm(i), Department: (empOf(i) || i).department || "", "Deducted every pay": +i.ca.perPay || 0, "Last deduction": lastPay(i), "Cash advance balance": +i.ca.balance }))), "Cash advance");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(act.flatMap((i) => (i.deductions || []).map((d) => ({ "Employee No.": i.employeeId, Name: nm(i), Type: d.type || "", Name2: d.label, "Per month": +d.amount || 0, Balance: tracked(d) ? +d.balance : "" })))), "Loans and deductions");
  XLSX.writeFile(wb, `cash-advance-loans-${localDate()}.xlsx`);
}

/* ---------- add information (pay information per employee) ---------- */
const newInfo = (e) => ({ schoolId: SID, employeeKey: e.id, employeeId: e.employeeId, name: nameOf(e), position: e.position || "", department: e.department || "", basicMonthly: 0, payType: isHourly({ position: e.position }) ? "hourly" : "monthly", hourlyRate: 0, allowances: [], deductions: [], sss: true, philhealth: true, pagibig: true, tax: true, fixed: {}, ca: { balance: 0, perPay: 0, history: [] }, active: true, bank: "", createdBy: user.uid, createdAt: serverTimestamp() });
function rInfo() {
  const q = S.q.toLowerCase(), list = S.emps.filter((e) => !q || [e.employeeId, nameOf(e), e.position, e.department].join(" ").toLowerCase().includes(q));
  const f = S.form;
  $("pInfo").innerHTML = `<div class="panel"><h2>Add information</h2>
    <p class="muted">The pay information of every employee: monthly basic pay, allowances, recurring deductions (loans) and which contributions apply. Employees come from the HR records (HR or the IT Admin registers them).</p>
    <div class="btnbar"><button class="btn primary" id="piAll" type="button"${S.emps.some((e) => !S.info.has(e.id)) ? "" : " disabled"}>Create a pay record for every employee that has none (${S.emps.filter((e) => !S.info.has(e.id)).length})</button></div>
    ${f ? infoForm(f) : ""}
    <div class="row"><label>Search<input id="piQ" value="${esc(S.q)}" placeholder="Employee No., name, position or department" autocomplete="off"></label></div>
    <div class="tablewrap"><table><tr><th>Employee No.</th><th>Name</th><th>Position / department</th><th class="pr-num">Pay (monthly / per hour)</th><th class="pr-num">Allowances</th><th class="pr-num">Cash advance balance</th><th>SSS</th><th>PhilHealth</th><th>Pag-IBIG</th><th>Tax</th><th>Status</th><th></th></tr>
    ${list.map((e) => { const i = S.info.get(e.id); const yn = (v) => (v === false ? "No" : "Yes");
      return i ? `<tr><td><b>${esc(e.employeeId)}</b></td><td>${esc(nameOf(e))}</td><td>${esc(e.position || "-")}<small>${esc(e.department || "")}</small></td>
        ${isHourly(i) ? `<td class="pr-num"><b>${money(i.hourlyRate)}</b> / hour<small>Per hour (teacher)</small></td>` : `<td class="pr-num"><input class="pr-in" type="number" min="0" step="0.01" data-quick="${esc(e.id)}" value="${+i.basicMonthly || 0}" aria-label="Monthly basic pay of ${esc(nameOf(e))}"></td>`}<td class="pr-num">${money(sumBy(i.allowances || [], (a) => a.amount))}</td><td class="pr-num">${+(i.ca && i.ca.balance) > 0 ? `<b>${money(i.ca.balance)}</b>` : "-"}</td>
        <td>${yn(i.sss)}</td><td>${yn(i.philhealth)}</td><td>${yn(i.pagibig)}</td><td>${yn(i.tax)}</td><td><span class="badge ${i.active === false ? "" : "active"}">${i.active === false ? "Inactive" : "Active"}</span></td>
        <td class="actions"><button class="btn small" data-edit="${esc(e.id)}">Details</button></td></tr>`
        : `<tr><td><b>${esc(e.employeeId)}</b></td><td>${esc(nameOf(e))}</td><td>${esc(e.position || "-")}<small>${esc(e.department || "")}</small></td><td colspan="8" class="muted">No pay record yet</td><td class="actions"><button class="btn small primary" data-new="${esc(e.id)}">Set up pay</button></td></tr>`; }).join("") || `<tr><td colspan="12">No employee found. Employees are registered by HR or the IT Admin.</td></tr>`}</table></div></div>`;
  $("piQ").oninput = (e) => { S.q = e.target.value; const p = e.target.selectionStart; rInfo(); const n = $("piQ"); n.focus(); n.setSelectionRange(p, p); };
}
const newId = () => Math.random().toString(36).slice(2, 10);
const deRows = (rows) => `<div class="pr-rows" id="deRows">${rows.map((r, i) => `<div class="r" data-id="${esc(r.id || "")}"><select data-de="type" aria-label="Type">${LOAN_TYPES.map((t) => `<option${(r.type || "Bank / other loan") === t ? " selected" : ""}>${t}</option>`).join("")}</select><input data-de="label" placeholder="Name / reference (optional)" value="${esc(r.label && r.label !== r.type ? r.label : "")}" maxlength="40"><input class="pr-in" type="number" min="0" step="0.01" data-de="amount" value="${+r.amount || 0}" aria-label="Amount per month" title="Amount per month"><input class="pr-in" type="number" min="0" step="0.01" data-de="balance" value="${tracked(r) ? +r.balance : ""}" placeholder="Balance" aria-label="Balance (optional)" title="Balance left (optional)"><button class="btn small danger" type="button" data-rm="de:${i}">Remove</button></div>`).join("")}</div><button class="btn small" type="button" data-add="de">Add a loan or deduction</button>`;
const rowsHtml = (kind, rows) => kind === "de" ? deRows(rows) : `<div class="pr-rows" id="${kind}Rows">${rows.map((r, i) => `<div class="r"><input data-${kind}="label" placeholder="${kind === "al" ? "e.g. Rice allowance" : "e.g. Salary loan"}" value="${esc(r.label)}" maxlength="40"><input class="pr-in" type="number" min="0" step="0.01" data-${kind}="amount" value="${+r.amount || 0}" aria-label="Amount per month"><button class="btn small danger" type="button" data-rm="${kind}:${i}">Remove</button></div>`).join("")}</div><button class="btn small" type="button" data-add="${kind}">Add ${kind === "al" ? "an allowance" : "a deduction"}</button>`;
function infoForm(f) {
  const e = S.emps.find((x) => x.id === f.employeeKey) || f, fx = f.fixed || {}, ca = f.ca || {}, T = f._typed || {};
  const ck = (id, v, l) => `<label class="sc-chk"><input type="checkbox" id="${id}"${v !== false ? " checked" : ""}> ${l}</label>`;
  return `<div class="pr-card"><h3>${esc(nameOf(e))} <small>Employee No. ${esc(f.employeeId)}</small></h3>
    <h3>Pay</h3>
    <div class="row"><label>How is this employee paid?<select id="fPayType"><option value="monthly"${!isHourly(f) ? " selected" : ""}>Fixed monthly pay</option><option value="hourly"${isHourly(f) ? " selected" : ""}>Per hour (teachers)</option></select></label>
      <label>Rate per hour (PHP) <small>(per-hour employees)</small><input id="fRate" type="number" min="0" step="0.01" value="${+f.hourlyRate || 0}"${isHourly(f) ? "" : " disabled"}></label>
      <label>Monthly basic pay (PHP) <small>(fixed-pay employees)</small><input id="fBasic" type="number" min="0" step="0.01" value="${+f.basicMonthly || 0}"${isHourly(f) ? " disabled" : ""}></label></div>
    <p class="muted fine">A <b>per-hour</b> employee is paid for the hours actually worked in each cut-off (hours from the biometric DTR, which you can correct in the payroll) times the rate per hour. No daily rate, no absence or late deduction. A <b>fixed monthly</b> employee is paid the monthly pay, less absences and late.</p>
    <div class="row"><label>Bank / account no. <small>(optional, for the payroll list)</small><input id="fBank" maxlength="60" value="${esc(f.bank || "")}"></label></div>
    <div class="row"><label>Biometric ID <small>(only if it differs from the Employee No.)</small><input id="fBio" maxlength="30" value="${esc(f.bioId || "")}"></label><label>Own work start <small>(blank = school default)</small><input id="fShS" type="time" value="${esc(f.shiftStart || "")}"></label><label>Own work end<input id="fShE" type="time" value="${esc(f.shiftEnd || "")}"></label></div>
    <div class="row"><fieldset class="sc-days"><legend>Deduct</legend>${ck("fSss", f.sss, "SSS")}${ck("fPhic", f.philhealth, "PhilHealth")}${ck("fHdmf", f.pagibig, "Pag-IBIG")}${ck("fTax", f.tax, "Withholding tax")}</fieldset><fieldset class="sc-days"><legend>Status</legend>${ck("fActive", f.active, "On payroll")}</fieldset></div>
    <h3>Government benefits: fixed amount for this employee <small>(per month; leave blank to use the amount set under Settings)</small></h3>
    <div class="row"><label>SSS<input class="pr-in" id="fxSss" type="number" min="0" step="0.01" placeholder="from Settings" value="${hasN(fx.sss) ? +fx.sss : ""}"></label><label>PhilHealth<input class="pr-in" id="fxPhic" type="number" min="0" step="0.01" placeholder="from Settings" value="${hasN(fx.phic) ? +fx.phic : ""}"></label><label>Pag-IBIG<input class="pr-in" id="fxHdmf" type="number" min="0" step="0.01" placeholder="from Settings" value="${hasN(fx.hdmf) ? +fx.hdmf : ""}"></label><label>Withholding tax<input class="pr-in" id="fxTax" type="number" min="0" step="0.01" placeholder="automatic" value="${hasN(fx.tax) ? +fx.tax : ""}"></label></div>
    <p class="muted fine">A typed amount is the employee's share per month (a twice-a-month payroll takes it according to the Settings). It is used instead of the amount under Settings (fixed amount or percent); the amounts can still be changed for one payroll.</p>
    <h3>Allowances (per month)</h3>${rowsHtml("al", f.allowances || [])}
    <h3>Cash advance</h3><div class="row"><label>Balance now (PHP)<input class="pr-in" id="caBal" type="number" min="0" step="0.01" value="${T.caBal !== undefined ? esc(T.caBal) : +ca.balance || 0}"></label><label>Deduct every pay (PHP)<input class="pr-in" id="caPer" type="number" min="0" step="0.01" value="${T.caPer !== undefined ? esc(T.caPer) : +ca.perPay || 0}"></label><label>New cash advance given (PHP)<small>added to the balance when you save</small><input class="pr-in" id="caNew" type="number" min="0" step="0.01" value="${esc(T.caNew || "")}"></label><label>Note<input id="caNote" maxlength="60" placeholder="e.g. emergency, tuition" value="${esc(T.caNote || "")}"></label></div>
    ${(ca.history || []).length ? `<div class="tablewrap"><table><tr><th>Date</th><th>What</th><th class="pr-num">Amount</th><th>Note</th></tr>${[...ca.history].reverse().slice(0, 6).map((h) => `<tr><td>${dateText(h.date)}</td><td>${h.type === "advance" ? "Cash advance given" : h.type === "payment" ? "Deducted from pay" : "Balance corrected"}</td><td class="pr-num">${money(h.amount)}</td><td>${esc(h.note || "")}</td></tr>`).join("")}</table></div>` : ""}
    <p class="muted fine">The deduction every pay is taken automatically in each payroll (never more than the balance) and can be changed for one payroll. The balance goes down when the payroll is <b>finalized</b>.</p>
    <h3>Loans and other deductions <small>(per month)</small></h3><p class="muted fine">For example an SSS salary loan, a Pag-IBIG loan or a bank loan. The amount is per month (a twice-a-month payroll takes half in each pay). Fill in the <b>balance</b> if you want the loan to stop when it is paid off; the balance goes down when a payroll is finalized.</p>${rowsHtml("de", f.deductions || [])}
    <div class="btnbar"><button class="btn primary" id="fSave" type="button">Save pay information</button><button class="btn" id="fCancel" type="button">Close</button></div></div>`;
}
const hasN = (v) => v !== undefined && v !== null && v !== "" && !isNaN(+v);
const readDe = () => [...document.querySelectorAll("#deRows .r")].map((r) => { const g = (k) => r.querySelector(`[data-de="${k}"]`).value, type = g("type"), bal = g("balance"); return { id: r.dataset.id || newId(), type, label: g("label").trim() || type, amount: r2(+g("amount")), balance: bal === "" ? "" : r2(+bal) }; }).filter((x) => x.amount || x.balance);
const readRows = (kind) => kind === "de" ? readDe() : [...document.querySelectorAll(`#${kind}Rows .r`)].map((r) => ({ label: r.querySelector(`[data-${kind}="label"]`).value.trim(), amount: r2(+r.querySelector(`[data-${kind}="amount"]`).value) })).filter((x) => x.label || x.amount);
function pullRows() {      // keeps everything typed in the form when a row is added or removed (the form is drawn again)
  if (!S.form) return; const f = S.form;
  f.allowances = readRows("al"); f.deductions = readRows("de"); f.fixed = fixedNow();
  f.basicMonthly = +$("fBasic").value || 0; f.bank = $("fBank").value; f.bioId = $("fBio").value; f.shiftStart = $("fShS").value; f.shiftEnd = $("fShE").value;
  f.sss = $("fSss").checked; f.philhealth = $("fPhic").checked; f.pagibig = $("fHdmf").checked; f.tax = $("fTax").checked; f.active = $("fActive").checked;
  f._typed = { caBal: $("caBal").value, caPer: $("caPer").value, caNew: $("caNew").value, caNote: $("caNote").value };
}
const fixedNow = () => { const o = {}; [["sss", "fxSss"], ["phic", "fxPhic"], ["hdmf", "fxHdmf"], ["tax", "fxTax"]].forEach(([k, id]) => { const v = $(id).value; if (v !== "") o[k] = r2(+v); }); return o; };
function caNow(f) {   // the cash advance of the form: balance, amount taken every pay, and a short history
  const old = f.ca || {}, bal0 = r2(+old.balance || 0), bal1 = r2(+$("caBal").value || 0), add = r2(+$("caNew").value || 0), note = $("caNote").value.trim(), hist = [...(old.history || [])], today = localDate();
  if (bal1 !== bal0) hist.push({ date: today, type: "adjust", amount: Math.abs(r2(bal1 - bal0)), note: note || (bal1 > bal0 ? "balance increased by hand" : "balance reduced by hand") });
  if (add > 0) hist.push({ date: today, type: "advance", amount: add, note });
  return { balance: r2(bal1 + add), perPay: r2(+$("caPer").value || 0), history: hist.slice(-40) };
}
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
    const patch = { payType: $("fPayType").value, hourlyRate: r2(+$("fRate").value), basicMonthly: r2(+$("fBasic").value), bank: $("fBank").value.trim(), bioId: $("fBio").value.trim(), shiftStart: $("fShS").value, shiftEnd: $("fShE").value, sss: $("fSss").checked, philhealth: $("fPhic").checked, pagibig: $("fHdmf").checked, tax: $("fTax").checked, active: $("fActive").checked, allowances: f.allowances, deductions: f.deductions, fixed: fixedNow(), ca: caNow(f), name: nameOf(e), position: e.position || "", department: e.department || "", updatedAt: serverTimestamp() };
    if (patch.payType === "hourly" ? !(patch.hourlyRate > 0) : !(patch.basicMonthly >= 0)) return flash(patch.payType === "hourly" ? "Enter the rate per hour." : "Enter the monthly basic pay.");
    await setDoc(doc(db, "payrollInfo", f.employeeKey), patch, { merge: true }); S.form = null; await refresh(); flash("Pay information saved.", true);
  }
}));
S.pendingPay = {};
$("pInfo").addEventListener("change", (ev) => { if (ev.target.id !== "fPayType") return; const h = ev.target.value === "hourly"; $("fRate").disabled = !h; $("fBasic").disabled = h; });
$("pInfo").addEventListener("input", (ev) => {        // typing a pay only marks it; nothing is saved until the Save button is pressed
  const t = ev.target; if (!t.dataset.quick) return; S.pendingPay[t.dataset.quick] = t.value; t.style.background = "#fff4e5";
  let bar = $("payBar"); if (!bar) { bar = document.createElement("div"); bar.id = "payBar"; bar.className = "btnbar"; bar.innerHTML = '<button class="btn primary" id="paySave" type="button"></button><button class="btn" id="payUndo" type="button">Cancel changes</button>'; $("pInfo").querySelector(".tablewrap").before(bar); }
  $("paySave").textContent = `Save ${Object.keys(S.pendingPay).length} changed pay amount(s)`;
});
$("pInfo").addEventListener("click", (ev) => run(async () => {
  const t = ev.target.closest("button"); if (!t) return;
  if (t.id === "payUndo") { S.pendingPay = {}; return rInfo(); }
  if (t.id === "paySave") {
    const ids = Object.keys(S.pendingPay), b = writeBatch(db);
    for (const id of ids) { const v = r2(+S.pendingPay[id]); if (!(v >= 0)) return flash("One of the pay amounts is not valid."); b.set(doc(db, "payrollInfo", id), { basicMonthly: v, updatedAt: serverTimestamp() }, { merge: true }); }
    await b.commit(); S.pendingPay = {}; await refresh(); flash("Pay amounts saved.", true);
  }
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
const rawOf = (d) => ({ d: d.d, in: d.in, out: d.out, n: d.n, ov: d.ov || "", man: d.man || null });   // what is kept of a day when it is worked out again: the times AND the corrections typed by hand
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
      const old = (S.dtr[m] || []).find((x) => x.employeeKey === inf.id), map = new Map((old ? old.days : []).map((d) => [d.d, rawOf(d)]));
      cover.filter((d) => d.startsWith(m)).forEach((date) => { const x = p.days.get(date); map.set(date, { ...(map.get(date) || {}), d: date, in: x ? hm(x.in) : "", out: x && x.out !== null ? hm(x.out) : "", n: x ? x.times.length : 0 }); });
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
    ${act.map((i) => { const x = docs.find((d) => d.employeeKey === i.id), t = x && x.totals; return x ? `<tr><td>${esc(i.employeeId)}</td><td>${esc(x.name)}</td><td class="pr-num">${t.present}</td><td class="pr-num">${t.absent}</td><td class="pr-num">${t.late}</td><td class="pr-num">${t.ut}</td><td class="pr-num">${round2(t.ot / 60)}</td><td class="pr-num">${t.hours}</td><td class="pr-num${t.inc ? " pr-warn" : ""}">${t.inc}</td><td class="actions"><button class="btn small primary" data-dv="${esc(i.id)}">Edit DTR</button><button class="btn small" data-dp="${esc(i.id)}">Print</button></td></tr>`
      : `<tr><td>${esc(i.employeeId)}</td><td>${esc(i.name)}</td><td colspan="7" class="muted">No biometric data for this month</td><td class="actions"><button class="btn small" data-dnew="${esc(i.id)}" title="Make an empty DTR of this month and type the times by hand">Create DTR by hand</button></td></tr>`; }).join("") || `<tr><td colspan="10">No employee on payroll yet.</td></tr>`}</table></div></div></div>
    ${view ? dayEditor(view) : ""}`;
}
const OV = [["", "Automatic"], ["P", "Present (full day)"], ["HD", "Half day"], ["A", "Absent"], ["L", "On leave (paid)"], ["H", "Holiday"], ["R", "Rest day"]];
function dayEditor(x) {
  const lab = { P: "Present", HD: "Half day", A: "Absent", L: "On leave", H: "Holiday", R: "Rest day", RW: "Worked on a rest day / holiday", INC: "One punch only" };
  const num = (d, k, v) => `<input class="pr-in sm" type="number" min="0" step="1" data-dd="${esc(d.d)}" data-k="${k}" data-orig="${v}" value="${v}" title="Minutes. Type your own figure, or clear it to go back to the automatic one.">`;
  return `<div class="panel" id="dtView"><h2>${esc(x.name)} <small>${esc(x.month)} &middot; Employee No. ${esc(x.employeeId)}</small></h2><p class="muted fine">Everything can be corrected here: the <b>time in / out</b> (for example a forgotten punch), the <b>status of the day</b> (present, half day, absent, leave, holiday, rest day) and the <b>late / undertime / overtime minutes</b>. Press <b>Save corrections</b>: the hours and the totals are worked out again, and the next payroll uses them. A figure you typed is marked <span style="background:#e7f1ff;padding:0 .3rem">blue</span>; clear it to return to the automatic figure.</p>
    <div class="tablewrap"><table><tr><th>Date</th><th>Day</th><th>Time in</th><th>Time out</th><th>Status of the day</th><th class="pr-num">Late (min)</th><th class="pr-num">Under (min)</th><th class="pr-num">OT (min)</th><th class="pr-num">Hours</th><th>Result</th></tr>
    ${x.days.map((d) => { const m = d.man || {}, bl = (k) => (m[k] !== undefined && m[k] !== "" ? ' style="background:#e7f1ff"' : "");
      return `<tr${d.inc ? ' style="background:#fff4e5"' : d.s === "A" ? ' style="background:#fdeced"' : ""}><td>${esc(d.d)}</td><td>${DOW[new Date(d.d + "T00:00").getDay()]}</td><td><input type="time" data-dd="${esc(d.d)}" data-k="in" value="${esc(d.in)}"></td><td><input type="time" data-dd="${esc(d.d)}" data-k="out" value="${esc(d.out)}"></td>
      <td><select data-dd="${esc(d.d)}" data-k="ov"${d.ov ? ' style="background:#e7f1ff"' : ""}>${OV.map(([v, l]) => `<option value="${v}"${(d.ov || "") === v ? " selected" : ""}>${l}</option>`).join("")}</select></td>
      <td class="pr-num"${bl("late")}>${num(d, "late", d.late || 0)}</td><td class="pr-num"${bl("ut")}>${num(d, "ut", d.ut || 0)}</td><td class="pr-num"${bl("ot")}>${num(d, "ot", d.ot || 0)}</td>
      <td class="pr-num">${round2(d.h)}</td><td>${esc(lab[d.s] || d.s)}</td></tr>`; }).join("")}
    <tr class="pr-tot"><td colspan="5">TOTAL</td><td class="pr-num">${x.totals.late}</td><td class="pr-num">${x.totals.ut}</td><td class="pr-num">${x.totals.ot}</td><td class="pr-num">${x.totals.hours}</td><td>Present ${x.totals.present} &middot; Absent ${x.totals.absent}</td></tr></table></div>
    <div class="btnbar"><button class="btn primary" id="dvSave" type="button">Save corrections</button><button class="btn" id="dvClose" type="button">Close</button><button class="btn danger" id="dvDel" type="button">Delete this DTR</button></div></div>`;
}
/** Reads the editor back into raw days. A late / undertime / overtime figure counts as typed by hand only when it was changed (or was already typed before). */
function readEditor(x) {
  const q = (d, k) => document.querySelector(`[data-dd="${d.d}"][data-k="${k}"]`);
  return x.days.map((d) => {
    const man = {}; ["late", "ut", "ot"].forEach((k) => { const el = q(d, k), v = el.value; if (v === "") return; if (v !== el.dataset.orig) man[k] = Math.max(0, +v || 0); else if (d.man && d.man[k] !== undefined && d.man[k] !== "") man[k] = d.man[k]; });
    return { d: d.d, in: q(d, "in").value, out: q(d, "out").value, n: d.n, ov: q(d, "ov").value, man: Object.keys(man).length ? man : null };
  });
}
function printDtr(list) {
  if (!list.length) return flash("There is no DTR to print.");
  const st = S.settings, sch = (school && (school.displayName || school.name)) || "", one = (x, copy) => `<div class="ps"><div class="hd"><div><p><b style="font-size:12px">${esc(sch)}</b></p><p>DAILY TIME RECORD &middot; <b>${esc(copy)}</b></p></div></div>
    <table><tr><td colspan="2"><small>Name</small><br><b>${esc(x.name)}</b></td><td colspan="2"><small>Employee No.</small><br><b>${esc(x.employeeId)}</b></td><td colspan="3"><small>Month</small><br><b>${esc(x.month)}</b></td></tr>
    <tr><th>Day</th><th></th><th>In</th><th>Out</th><th>Hours</th><th>Late / UT (min)</th><th>OT (min)</th></tr>
    ${x.days.map((d) => `<tr><td>${d.d.slice(8)}</td><td>${DOW[new Date(d.d + "T00:00").getDay()]}</td><td>${esc(d.in)}</td><td>${esc(d.out)}</td><td class="r">${d.h ? round2(d.h) : ""}</td><td class="r">${(d.late || 0) + (d.ut || 0) || ""}</td><td class="r">${d.ot || ""}</td></tr>`).join("")}
    <tr class="tot"><td colspan="4">TOTAL</td><td class="r">${x.totals.hours}</td><td class="r">${x.totals.late + x.totals.ut}</td><td class="r">${x.totals.ot}</td></tr></table>
    <p><small>Days present ${x.totals.present} &middot; days absent ${x.totals.absent} &middot; made from the biometric record.</small></p><div class="sg"><div><br>Employee</div><div><br>Verified by</div>${signBlocks((st.signatories || []).slice(-1))}</div></div>`;
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
  if (t.dataset.dv) { S.dtrView = t.dataset.dv; await rDtr(); return $("dtView")?.scrollIntoView({ behavior: "smooth" }); }
  if (t.dataset.dp) return printDtr(docs.filter((x) => x.employeeKey === t.dataset.dp)); if (t.id === "dtPrintAll") return printDtr(docs);
  if (t.id === "dvClose") { S.dtrView = ""; return rDtr(); }
  if (t.dataset.dnew) {      // an empty DTR of the month: every day is typed by hand
    const inf = S.info.get(t.dataset.dnew); if (!inf) return; const [y, m] = S.dtrMonth.split("-").map(Number), last = new Date(y, m, 0).getDate();
    const raw = datesBetween(`${S.dtrMonth}-01`, `${S.dtrMonth}-${String(last).padStart(2, "0")}`).map((d) => ({ d, in: "", out: "", n: 0, ov: "", man: null }));
    await saveDtrDocs([{ id: `${inf.id}_${S.dtrMonth}`, isNew: true, data: dtrDoc(inf, S.dtrMonth, buildDays(raw, shiftOf(inf), D(), leaveSet(inf))) }]); S.dtr = {}; S.dtrView = inf.id; await rDtr(); $("dtView")?.scrollIntoView({ behavior: "smooth" });
    return flash("An empty DTR was created. Type the times (or choose the status of each day), then press Save corrections. Working days without a time count as absent.", true);
  }
  if (t.id === "dvDel") {
    const x = docs.find((d) => d.employeeKey === S.dtrView); if (!x) return;
    const a = await showPopup({ title: "Delete this DTR?", ok: false, html: `<p>The DTR of ${esc(x.name)} for ${esc(x.month)} is deleted. Uploading the biometric file again makes it again.</p>`, buttons: [{ label: "Keep", value: "no" }, { label: "Delete", value: "yes", primary: true, danger: true }] }); if (a.value !== "yes") return;
    const b = writeBatch(db); b.delete(doc(db, "payrollDtr", x.id)); await b.commit(); S.dtr = {}; S.dtrView = ""; await rDtr(); return flash("DTR deleted.", true);
  }
  if (t.id === "dvSave") {
    const x = docs.find((d) => d.employeeKey === S.dtrView), inf = S.info.get(S.dtrView); if (!x || !inf) return;
    const raw = readEditor(x);
    await saveDtrDocs([{ id: x.id, data: dtrDoc(inf, x.month, buildDays(raw, shiftOf(inf), D(), leaveSet(inf))) }]); S.dtr = {}; await rDtr(); return flash("Corrections saved and recalculated.", true);
  }
  if (t.id === "dtRecalc") {
    const a = await showPopup({ title: "Recalculate the whole month?", html: `<p>Every day of ${esc(S.dtrMonth)} is worked out again from the punches with the present Settings (work hours, grace, overtime, half day, holidays and approved leave). Your time corrections stay.</p>`, buttons: [{ label: "Cancel", value: "no" }, { label: "Recalculate", value: "yes", primary: true }] }); if (a.value !== "yes") return;
    const out = docs.map((x) => { const inf = S.info.get(x.employeeKey); return inf ? { id: x.id, data: dtrDoc(inf, x.month, buildDays(x.days.map(rawOf), shiftOf(inf), D(), leaveSet(inf))) } : null; }).filter(Boolean);
    await saveDtrDocs(out); S.dtr = {}; await rDtr(); flash(`${out.length} DTR${out.length === 1 ? "" : "s"} recalculated.`, true);
  }
}));

/* ---------- payroll runs ---------- */
const unpaidLeaveDays = (emp, per) => (S.settings.unpaidLeave && emp ? S.leave.filter((l) => l.status === "Approved" && /without pay|no pay|unpaid/i.test(l.leaveType || "") && ((emp.accountUid && l.requesterUid === emp.accountUid) || (l.employeeId && l.employeeId === emp.employeeId)))
  .reduce((n, l) => n + weekdaysIn(l.startDate, l.endDate, per.start, per.end), 0) : 0);
function buildRow(infoDoc, emp, inp, per) { const x = { ...inp }; x.leaveDays = unpaidLeaveDays(emp, per); const slip = computeSlip(infoDoc, x, S.settings, per); if (x.caDed === undefined) x.caDed = slip.caDed; return { key: infoDoc.id, info: infoDoc, emp, inp: x, slip }; }
const KEEP = ["otherEarn", "otherDed", "mSss", "mPhic", "mHdmf", "mTax", "caDed"];   // typed by hand: kept when the attendance is taken from the DTR again
function dtrInputs(i, per) {   // absent days, late + undertime minutes and overtime hours of the period, from the biometric DTR
  const days = []; for (const m of new Set([per.start.slice(0, 7), per.end.slice(0, 7)])) days.push(...((S.dtr[m] || []).find((x) => x.employeeKey === i.id)?.days || []));
  const mine = days.filter((d) => d.d >= per.start && d.d <= per.end); if (!mine.length) return null;
  const t = totalsOf(mine); return { absentDays: t.absent, lateMin: t.late + t.ut, otHours: r2(t.ot / 60), hoursWorked: r2(Math.max(0, t.hours - t.ot / 60)), dtr: { present: t.present, absent: t.absent, lateMin: t.late, utMin: t.ut, otHrs: r2(t.ot / 60), hours: t.hours, missing: t.inc } };
}
const ensureDtr = (per) => Promise.all([...new Set([per.start.slice(0, 7), per.end.slice(0, 7)])].map((m) => loadDtr(m)));
/* cut-off: 26th-10th, 11th-25th, 1st-15th, 16th-end, a whole month, or dates typed by hand */
const perOf = (m, key) => (key === "whole" ? { ...periodOf(m, "whole", S.settings.period), cut: "whole" } : key === "custom" ? { ...periodOf(m, "first", S.settings.period), cut: "custom" } : cutoffPeriod(m, key));
const halfOf = (key) => (key === "whole" ? "whole" : (CUTOFFS.find((c) => c.key === key) || { half: "first" }).half);
const cutOf = (per) => per.cut || cutOfDates(per.start, per.end);
function mkPer(a, b, half) {     // period of two typed dates: a cut-off when the dates match one, otherwise custom
  const k = cutOfDates(a, b); if (k === "custom") return { ...customPeriod(a, b, half), cut: "custom" };
  return perOf(k === "c26_10" ? b.slice(0, 7) : a.slice(0, 7), k);
}
function defaultCut(now) {       // the cut-off to start with: the usual pair under Settings, by today's date
  const st = S.settings, d = now.getDate(), ym = (y, m) => `${y}-${String(m).padStart(2, "0")}`, y = now.getFullYear(), m = now.getMonth() + 1;
  if (st.frequency === "monthly") return { month: ym(y, m), key: "whole" };
  if (st.cutoffPair === "A") return d <= 10 ? { month: ym(y, m), key: "c26_10" } : d <= 25 ? { month: ym(y, m), key: "c11_25" } : { month: m === 12 ? ym(y + 1, 1) : ym(y, m + 1), key: "c26_10" };
  return { month: ym(y, m), key: d <= 15 ? "c1_15" : "c16_end" };
}
function newDraft(month, half, payDate, per0) {
  const per = per0 || perOf(month, half), rows = [...S.info.values()].filter((i) => i.active !== false && empOf(i)).sort((a, b) => nameOf(empOf(a)).localeCompare(nameOf(empOf(b)))).map((i) => buildRow(i, empOf(i), dtrInputs(i, per) || {}, per));
  S.draft = { per, payDate: payDate || payDateOf(month, per.half, S.settings.period), rows, runId: "", status: "Draft" };
}
function rRuns() {
  const st = S.settings, now = new Date(), d0 = S.draft, locked = !!d0 && d0.status === "Final", dc = defaultCut(now), month = d0 ? d0.per.end.slice(0, 7) : dc.month;
  const cut = d0 ? cutOf(d0.per) : dc.key, per = d0 ? d0.per : perOf(month, cut), pay = d0 ? d0.payDate : payDateOf(month, halfOf(cut), st.period);
  $("pRuns").innerHTML = `<div class="panel"><h2>Payroll</h2><p class="muted">Choose the month and the <b>cut-off</b> (26th - 10th, 11th - 25th, 1st - 15th or 16th - end of month) and press <b>Compute payroll</b>. <b>Teachers are calculated separately, per hour</b> (hours worked x rate); everyone else gets the fixed monthly pay. Basic pay, allowances, overtime, absences, SSS, PhilHealth, Pag-IBIG, withholding tax, cash advance and loans are calculated automatically for every employee on payroll. Approved leave <i>without pay</i> is deducted by itself. The pay period <b>dates</b> and the <b>pay date</b> start with the rules under Settings, and you can change them here for every payroll.</p>
    <div class="row"><label>Month <small>(the month the cut-off ends in)</small><input type="month" id="rnMonth" value="${month}"></label><label>Cut-off<select id="rnHalf">${CUTOFFS.map((c) => `<option value="${c.key}"${cut === c.key ? " selected" : ""}>${c.label}</option>`).join("")}<option value="whole"${cut === "whole" ? " selected" : ""}>Whole month</option><option value="custom"${cut === "custom" ? " selected" : ""}>Other dates (type them)</option></select></label>
      <label>Period from<input type="date" id="rnFrom" value="${per.start}"${locked ? " disabled" : ""}></label><label>Period to<input type="date" id="rnTo" value="${per.end}"${locked ? " disabled" : ""}></label>
      <label>Pay date<input type="date" id="rnPay" value="${pay}"></label><button class="btn primary" id="rnGo" type="button">Compute payroll</button>${locked ? '<button class="btn" id="rnPaySave" type="button">Save the new pay date</button>' : ""}</div>
    ${d0 && !locked ? '<p class="muted fine">A payroll is open: changing <b>Period from / to</b> or <b>Pay date</b> changes the open payroll (press <b>Reload from the biometric DTR</b> below to take the attendance of the new dates). <b>Compute payroll</b> starts a new one from the month and period chosen.</p>' : ""}</div>
    ${S.draft ? draftHtml() : ""}
    <div class="panel"><h2>Saved payroll</h2><div class="tablewrap"><table><tr><th>Period</th><th>Pay date</th><th>Employees</th><th class="pr-num">Gross</th><th class="pr-num">Deductions</th><th class="pr-num">Net pay</th><th>Status</th><th></th></tr>
    ${S.runs.map((r) => `<tr><td><b>${esc(r.label)}</b></td><td>${dateText(r.payDate)}</td><td>${r.count}</td><td class="pr-num">${money(r.gross)}</td><td class="pr-num">${money(r.deductions)}</td><td class="pr-num">${money(r.net)}</td><td><span class="badge ${r.status === "Final" ? "active" : "warn"}">${esc(r.status)}</span></td>
      <td class="actions"><button class="btn small" data-open="${esc(r.id)}">${r.status === "Final" ? "View" : "Edit"}</button><button class="btn small" data-print="${esc(r.id)}">Print payslips</button>${r.status === "Final" ? "" : `<button class="btn small primary" data-final="${esc(r.id)}">Finalize</button><button class="btn small danger" data-delrun="${esc(r.id)}">Delete</button>`}</td></tr>`).join("") || `<tr><td colspan="8">No payroll saved yet.</td></tr>`}</table></div></div>`;
}
function draftHtml() {
  const d = S.draft, locked = d.status === "Final";
  const inp = (r, f, cls = "sm", val) => `<input class="pr-in ${cls}" type="number" min="0" step="${["otherEarn", "otherDed", "caDed"].includes(f) ? "0.01" : f === "hoursWorked" ? "0.25" : "0.5"}" data-r="${esc(r.key)}" data-f="${f}" value="${val !== undefined ? val : +r.inp[f] || 0}"${locked ? " disabled" : ""}>`;
  const gov = (r, f, key) => `<input class="pr-in sm" type="number" min="0" step="0.01" data-r="${esc(r.key)}" data-f="${f}" value="${+r.slip[key] || 0}" placeholder="${+(r.slip.auto || {})[key] || 0}"${r.inp[f] !== undefined && r.inp[f] !== "" ? ' style="background:#e7f1ff"' : ""}${locked ? " disabled" : ""} title="From the Settings (fixed amount or percent) or from Add information. Type your own amount for this payroll; clear it to go back.">`;
  const caNote = (r) => (+r.slip.caBal > 0 || +r.slip.caDed > 0 ? `<small data-c="cab">balance ${money(r.slip.caBal)} &rarr; ${money(r.slip.caAfter)}</small>` : `<small data-c="cab"></small>`);
  const tail = (r) => `<td>${gov(r, "mSss", "sssEe")}</td><td>${gov(r, "mPhic", "phicEe")}</td><td>${gov(r, "mHdmf", "hdmfEe")}</td><td>${gov(r, "mTax", "tax")}</td>
      <td>${inp(r, "caDed", "", +r.slip.caDed || 0)}${caNote(r)}</td><td class="pr-num" data-c="loan">${money(sumBy(r.slip.dedList || [], (x) => x.amount))}</td><td>${inp(r, "otherDed", "")}</td>
      <td class="pr-num" data-c="gross">${money(r.slip.gross)}</td><td class="pr-num" data-c="ded">${money(r.slip.totalDed)}</td><td class="pr-num" data-c="net"><b>${money(r.slip.net)}</b></td></tr>`;
  const who = (r) => `<td><b>${esc(r.emp ? nameOf(r.emp) : r.info.name)}</b><small>${esc(r.info.employeeId)}${r.inp.dtr ? ` &middot; present ${r.inp.dtr.present} d, hours ${r.inp.dtr.hours}` : ""}${r.inp.leaveDays && !r.slip.perHour ? ` &middot; ${r.inp.leaveDays} day(s) unpaid leave` : ""}`;
  const teachers = d.rows.filter((r) => r.slip.perHour), staff = d.rows.filter((r) => !r.slip.perHour);
  const tblH = `<div class="tablewrap"><table id="dTblH"><tr><th>Teacher</th><th class="pr-num">Rate / hour</th><th>Hours worked</th><th class="pr-num">Basic pay (hours x rate)</th><th>Overtime (hrs)</th><th>Other earnings</th><th>SSS</th><th>PhilHealth</th><th>Pag-IBIG</th><th>Tax</th><th>Cash advance</th><th class="pr-num">Loans (auto)</th><th>Other deductions</th><th class="pr-num">Gross</th><th class="pr-num">Deductions</th><th class="pr-num">Net pay</th></tr>
    ${teachers.map((r) => `<tr data-row="${esc(r.key)}">${who(r)}${+r.info.hourlyRate > 0 ? "" : ' <span class="pr-warn">no rate per hour set</span>'}</small></td><td class="pr-num">${money(r.slip.rate)}</td><td>${inp(r, "hoursWorked")}</td><td class="pr-num" data-c="basic">${money(r.slip.basic)}</td><td>${inp(r, "otHours")}</td><td>${inp(r, "otherEarn", "")}</td>${tail(r)}`).join("")}
    <tr class="pr-tot" id="dTotH">${totalsRow(teachers, true)}</tr></table></div>`;
  const tblM = `<div class="tablewrap"><table id="dTblM"><tr><th>Employee</th><th class="pr-num">Basic pay</th><th>Absent days</th><th>Late (min)</th><th>Overtime (hrs)</th><th>Other earnings</th><th>SSS</th><th>PhilHealth</th><th>Pag-IBIG</th><th>Tax</th><th>Cash advance</th><th class="pr-num">Loans (auto)</th><th>Other deductions</th><th class="pr-num">Gross</th><th class="pr-num">Deductions</th><th class="pr-num">Net pay</th></tr>
    ${staff.map((r) => `<tr data-row="${esc(r.key)}">${who(r)}${+r.info.basicMonthly > 0 ? "" : ' <span class="pr-warn">no pay set</span>'}</small></td><td class="pr-num">${money(r.slip.basic)}</td>
      <td>${inp(r, "absentDays")}</td><td>${inp(r, "lateMin")}</td><td>${inp(r, "otHours")}</td><td>${inp(r, "otherEarn", "")}</td>${tail(r)}`).join("")}
    <tr class="pr-tot" id="dTotM">${totalsRow(staff, false)}</tr></table></div>`;
  return `<div class="panel"><h2>${esc(d.per.label)} ${d.runId ? `<small>(saved ${locked ? "and final" : "as draft"})</small>` : ""}</h2>
    ${fromDtrBanner(d)}<p class="muted fine">Hours worked, absences, late / undertime and overtime come from the <b>biometric DTR</b> when one was uploaded; you can still change them. <b>SSS, PhilHealth and Pag-IBIG</b> are the fixed amounts (or the percent) set under Settings, or the amount typed for the employee under Add information; type your own amount to replace them for this payroll (blue = typed by you). <b>Cash advance</b> is taken from the balance, never more than what is left. Every figure recalculates at once.${S.settings.unpaidLeave ? " Unpaid leave from the leave requests is already included for fixed-pay employees." : ""}</p>
    ${teachers.length ? `<div class="pr-card"><h3>Teachers - paid per hour (${teachers.length})</h3><p class="muted fine">Pay = hours worked x rate per hour. Only the hours worked are paid, so there is no absence or late deduction. Overtime hours are paid on top at the overtime rate.</p>${tblH}</div>` : ""}
    ${staff.length ? `<div class="pr-card"><h3>Employees with a fixed monthly pay (${staff.length})</h3>${tblM}</div>` : ""}
    <div class="pr-card"><h3>Total of this payroll</h3><p id="dGrand">${grandHtml(d)}</p></div>
    <div class="btnbar">${locked ? "" : `<button class="btn primary" id="rnSave" type="button">Save payroll (draft)</button>`}${locked ? "" : `<button class="btn" id="rnReload" type="button" title="Take the hours, absences, late and overtime from the biometric DTR again (what you typed for the other columns stays)">Reload from the biometric DTR</button><button class="btn" id="rnAuto" type="button" title="Forget the amounts typed for SSS, PhilHealth, Pag-IBIG and tax in this payroll">Use automatic government amounts</button>`}<button class="btn" id="rnClose" type="button">Close</button></div></div>`;
}
const grandHtml = (d) => { const T = (f) => money(sumBy(d.rows, (r) => f(r.slip))); return `${d.rows.length} employee(s) &middot; Gross <b>${T((x) => x.gross)}</b> &middot; Deductions <b>${T((x) => x.totalDed)}</b> &middot; Net pay <b>${T((x) => x.net)}</b>`; };
const fromDtrBanner = (d) => { const n = d.rows.filter((r) => r.inp.dtr).length, m = d.rows.length - n; return d.status === "Final" ? "" : `<p class="${m ? "pr-warn" : "muted"} fine">${n} employee${n === 1 ? "" : "s"} filled in from the biometric DTR${m ? `; <b>${m} without biometric data</b> (their hours, absences, late and overtime are zero until you type them or upload the file).` : "."}</p>`; };
const totalsRow = (rows, hourly) => { const T = (f) => money(sumBy(rows, (r) => f(r.slip))), tail = `<td class="pr-num">${T((x) => x.sssEe)}</td><td class="pr-num">${T((x) => x.phicEe)}</td><td class="pr-num">${T((x) => x.hdmfEe)}</td><td class="pr-num">${T((x) => x.tax)}</td><td class="pr-num">${T((x) => x.caDed)}</td><td class="pr-num">${T((x) => sumBy(x.dedList || [], (y) => y.amount))}</td><td></td><td class="pr-num">${T((x) => x.gross)}</td><td class="pr-num">${T((x) => x.totalDed)}</td><td class="pr-num">${T((x) => x.net)}</td>`;
  return hourly ? `<td>TOTAL (${rows.length})</td><td></td><td class="pr-num">${r2(sumBy(rows, (r) => r.slip.hours))} hrs</td><td class="pr-num">${T((x) => x.basic)}</td><td colspan="2"></td>${tail}` : `<td>TOTAL (${rows.length})</td><td class="pr-num">${T((x) => x.basic)}</td><td colspan="4"></td>${tail}`; };
const redrawTotals = () => { const d = S.draft; if (!d) return; const h = $("dTotH"), m = $("dTotM"); if (h) h.innerHTML = totalsRow(d.rows.filter((r) => r.slip.perHour), true); if (m) m.innerHTML = totalsRow(d.rows.filter((r) => !r.slip.perHour), false); const g = $("dGrand"); if (g) g.innerHTML = grandHtml(d); };
$("pRuns").addEventListener("input", (ev) => {      // recalculates one row while typing (no redraw, so the cursor stays)
  const t = ev.target; if (!t.dataset.r || !S.draft) return; const row = S.draft.rows.find((x) => x.key === t.dataset.r); if (!row) return; const f = t.dataset.f;
  if (/^m(Sss|Phic|Hdmf|Tax)$/.test(f)) { if (t.value === "") { delete row.inp[f]; t.style.background = ""; } else { row.inp[f] = +t.value || 0; t.style.background = "#e7f1ff"; } }   // blank = automatic again
  else row.inp[f] = +t.value || 0;
  row.slip = computeSlip(row.info, row.inp, S.settings, S.draft.per);
  const tr = t.closest("tr"); tr.querySelector('[data-c="gross"]').textContent = money(row.slip.gross); tr.querySelector('[data-c="ded"]').textContent = money(row.slip.totalDed); tr.querySelector('[data-c="net"]').innerHTML = `<b>${money(row.slip.net)}</b>`;
  const bc = tr.querySelector('[data-c="basic"]'); if (bc) bc.textContent = money(row.slip.basic);
  const cab = tr.querySelector('[data-c="cab"]'); if (cab) cab.innerHTML = +row.slip.caBal > 0 || +row.slip.caDed > 0 ? `balance ${money(row.slip.caBal)} &rarr; ${money(row.slip.caAfter)}` : "";
  redrawTotals();
});
// the period and pay date of the form follow the month and half chosen; with an open payroll they change that payroll
$("pRuns").addEventListener("change", (ev) => run(async () => {
  const t = ev.target, d = S.draft;
  if (t.id === "rnMonth" || t.id === "rnHalf") { const m = $("rnMonth").value, h = $("rnHalf").value; if (!m) return; if (h === "custom") return; const p = perOf(m, h); $("rnFrom").value = p.start; $("rnTo").value = p.end; $("rnPay").value = payDateOf(m, halfOf(h), S.settings.period); return; }
  if (!d) return;
  if (t.id === "rnPay") { if (d.status !== "Final") d.payDate = t.value; return; }
  if ((t.id === "rnFrom" || t.id === "rnTo") && d.status !== "Final") {
    const a = $("rnFrom").value, b = $("rnTo").value; if (!a || !b || a > b) return flash("The period must start before it ends.");
    d.per = mkPer(a, b, d.per.half);
    d.rows.forEach((r) => (r.slip = computeSlip(r.info, r.inp, S.settings, d.per))); rRuns(); flash("The pay period was changed. Press Reload from the biometric DTR to take the attendance of these dates.", true);
  }
}));
const slipDoc = (r, d, runId, label, status) => ({ schoolId: SID, runId, runLabel: label, start: d.per.start, end: d.per.end, payDate: d.payDate, employeeKey: r.key, employeeId: r.info.employeeId, name: r.emp ? nameOf(r.emp) : r.info.name, position: (r.emp && r.emp.position) || r.info.position || "", department: (r.emp && r.emp.department) || r.info.department || "",
  ...Object.fromEntries(["basic", "allow", "allowList", "ot", "otherEarn", "gross", "absent", "late", "sssEe", "phicEe", "hdmfEe", "sssEr", "phicEr", "hdmfEr", "tax", "other", "dedList", "caDed", "caBal", "caAfter", "manual", "totalDed", "net", "absentDays", "perHour", "rate", "hours"].map((k) => [k, r.slip[k]])), inputs: { hoursWorked: +r.inp.hoursWorked || 0, absentDays: +r.inp.absentDays || 0, lateMin: +r.inp.lateMin || 0, otHours: +r.inp.otHours || 0, otherEarn: +r.inp.otherEarn || 0, otherDed: +r.inp.otherDed || 0, caDed: +r.inp.caDed || 0, ...Object.fromEntries(["mSss", "mPhic", "mHdmf", "mTax"].filter((k) => r.inp[k] !== undefined && r.inp[k] !== "").map((k) => [k, +r.inp[k]])), leaveDays: r.inp.leaveDays || 0, dtr: r.inp.dtr || null }, status });
async function saveRun() {
  const d = S.draft; if (!d.rows.length) return flash("No employee is on payroll yet. Add the pay information first.");
  if (!d.runId && S.runs.some((r) => r.start === d.per.start && r.end === d.per.end)) { const a = await showPopup({ title: "This period already has a payroll", html: `<p>${esc(d.per.label)} was already saved. Save another one anyway?</p>`, buttons: [{ label: "Cancel", value: "no" }, { label: "Save anyway", value: "yes", primary: true }] }); if (a.value !== "yes") return; }
  const runId = d.runId || doc(collection(db, "payrollRuns")).id, b = writeBatch(db), ex = S.slips[runId] || [];
  b.set(doc(db, "payrollRuns", runId), { schoolId: SID, label: d.per.label, start: d.per.start, end: d.per.end, payDate: $("rnPay") && $("rnPay").value || d.payDate, kind: d.per.half, cut: cutOf(d.per), count: d.rows.length, gross: sumBy(d.rows, (r) => r.slip.gross), deductions: sumBy(d.rows, (r) => r.slip.totalDed), net: sumBy(d.rows, (r) => r.slip.net), status: "Draft", createdBy: user.uid, createdByName: profile.displayName, createdAt: serverTimestamp() }, { merge: true });
  d.rows.forEach((r) => { const old = ex.find((s) => s.employeeKey === r.key); b.set(old ? doc(db, "payslips", old.id) : doc(collection(db, "payslips")), { ...slipDoc(r, d, runId, d.per.label, "Draft"), createdBy: user.uid, createdAt: serverTimestamp() }, { merge: true }); });
  await b.commit(); delete S.slips[runId]; d.runId = runId; await refresh(); S.draft = d; rRuns(); flash("Payroll saved as a draft. Press Finalize when everything is correct.", true);
}
async function slipsOf(runId) { if (!S.slips[runId]) S.slips[runId] = (await bySchool2("payslips", runId)).sort((a, b) => String(a.name).localeCompare(String(b.name))); return S.slips[runId]; }
const bySchool2 = async (c, runId) => (await getDocs(query(collection(db, c), where("schoolId", "==", SID), where("runId", "==", runId)))).docs.map((d) => ({ id: d.id, ...d.data() }));
$("pRuns").addEventListener("click", (ev) => run(async () => {
  const t = ev.target.closest("button"); if (!t) return;
  if (t.id === "rnGo") {
    const m = $("rnMonth").value, h = $("rnHalf").value, a = $("rnFrom").value, b = $("rnTo").value; if (!m) return flash("Choose the month."); if (!a || !b || a > b) return flash("Choose the period: it must start before it ends.");
    const def = h === "custom" ? null : perOf(m, h), per = def && a === def.start && b === def.end ? def : mkPer(a, b, halfOf(h));
    await ensureDtr(per); newDraft(m, per.half, $("rnPay").value, per); return rRuns();
  }
  if (t.id === "rnPaySave") {      // the pay date of a finalized payroll can still be corrected
    const d = S.draft, v = $("rnPay").value; if (!d || !v) return flash("Choose the pay date.");
    const slips = await slipsOf(d.runId), b = writeBatch(db); b.update(doc(db, "payrollRuns", d.runId), { payDate: v }); slips.forEach((x) => b.update(doc(db, "payslips", x.id), { payDate: v })); await b.commit();
    delete S.slips[d.runId]; d.payDate = v; await refresh(); return flash("The pay date was changed on the payroll and on every payslip.", true);
  }
  if (t.id === "rnReload") { await ensureDtr(S.draft.per); S.draft.rows = S.draft.rows.map((r) => buildRow(r.info, r.emp, { ...Object.fromEntries(KEEP.filter((k) => r.inp[k] !== undefined).map((k) => [k, r.inp[k]])), ...(dtrInputs(r.info, S.draft.per) || {}) }, S.draft.per)); rRuns(); return flash("The absences, late / undertime and overtime were filled in again from the biometric DTR.", true); }
  if (t.id === "rnAuto") { S.draft.rows = S.draft.rows.map((r) => { const inp = { ...r.inp }; ["mSss", "mPhic", "mHdmf", "mTax"].forEach((k) => delete inp[k]); return { ...r, inp, slip: computeSlip(r.info, inp, S.settings, S.draft.per) }; }); rRuns(); return flash("SSS, PhilHealth, Pag-IBIG and tax are automatic again.", true); }
  if (t.id === "rnSave") return saveRun(); if (t.id === "rnClose") { S.draft = null; return rRuns(); }
  const id = t.dataset.open || t.dataset.print || t.dataset.final || t.dataset.delrun, r = S.runs.find((x) => x.id === id);
  if (t.dataset.open) {
    const slips = await slipsOf(id), per = { start: r.start, end: r.end, label: r.label, half: r.kind || "whole", cut: r.cut || cutOfDates(r.start, r.end) };
    S.draft = { per, payDate: r.payDate, runId: id, status: r.status, rows: slips.map((s) => { const i = S.info.get(s.employeeKey) || { id: s.employeeKey, employeeId: s.employeeId, name: s.name, position: s.position, department: s.department, basicMonthly: 0 }; return r.status === "Final" ? { key: s.employeeKey, info: i, emp: empOf(i), inp: { ...s.inputs }, slip: { ...s, allowList: s.allowList || [], dedList: s.dedList || [] } } : buildRow(i, empOf(i), { ...s.inputs, leaveDays: 0 }, per); }) };
    rRuns(); return scrollTo({ top: 200, behavior: "smooth" });
  }
  if (t.dataset.print) return printSlips(await slipsOf(id));
  if (t.dataset.final) {
    const a = await showPopup({ title: `Finalize ${r.label}?`, html: `<p>The payslips of ${r.count} employees are locked. They can no longer be changed.</p>`, buttons: [{ label: "Cancel", value: "no" }, { label: "Finalize", value: "yes", primary: true }] }); if (a.value !== "yes") return;
    const slips = await slipsOf(id), b = writeBatch(db), fresh = new Map((await bySchool("payrollInfo")).map((i) => [i.id, i])); let n = 0;
    b.update(doc(db, "payrollRuns", id), { status: "Final", finalizedAt: serverTimestamp() }); slips.forEach((x) => b.update(doc(db, "payslips", x.id), { status: "Final", sign: S.settings.signatories }));
    slips.forEach((x) => {      // cash advance and loan balances go down by what this payroll took
      const inf = fresh.get(x.employeeKey); if (!inf) return; const patch = {};
      if (+x.caDed > 0) { const ca = { ...(inf.ca || {}) }; ca.balance = r2(Math.max(0, (+ca.balance || 0) - x.caDed)); ca.history = [...(ca.history || []), { date: r.payDate || localDate(), type: "payment", amount: x.caDed, note: r.label, runId: id }].slice(-40); patch.ca = ca; }
      const paid = (x.dedList || []).filter((d) => d.id && +d.amount > 0);
      if (paid.length && (inf.deductions || []).some((d) => paid.some((p) => p.id === d.id) && tracked(d))) patch.deductions = (inf.deductions || []).map((d) => { const p = paid.find((y) => y.id === d.id); return p && tracked(d) ? { ...d, balance: r2(Math.max(0, +d.balance - p.amount)) } : d; });
      if (Object.keys(patch).length) { b.update(doc(db, "payrollInfo", inf.id), { ...patch, updatedAt: serverTimestamp() }); n++; }
    });
    await b.commit(); delete S.slips[id]; S.draft = null; await refresh(); return flash("Payroll finalized." + (n ? ` The cash advance / loan balances of ${n} employee${n === 1 ? "" : "s"} were reduced.` : ""), true);
  }
  if (t.dataset.delrun) {
    const a = await showPopup({ title: `Delete the draft ${r.label}?`, ok: false, html: `<p>The draft and its payslips are deleted.</p>`, buttons: [{ label: "Keep", value: "no" }, { label: "Delete", value: "yes", primary: true, danger: true }] }); if (a.value !== "yes") return;
    const slips = await slipsOf(id), b = writeBatch(db); slips.forEach((s) => b.delete(doc(db, "payslips", s.id))); b.delete(doc(db, "payrollRuns", id)); await b.commit(); delete S.slips[id]; S.draft = null; await refresh(); flash("Draft deleted.", true);
  }
}));

/* ---------- payslips: ready to print, two copies on one landscape page ---------- */
const signBlocks = (sig) => (sig || []).filter((x) => x && (x.name || x.position || x.label)).map((x) => `<div><b>${esc(x.name || "")}</b>${x.name ? "<br>" : ""}${esc(x.position || "")}<br><small><i>${esc(x.label || "")}</i></small></div>`).join("");
function slipHtml(s, copy) {
  const st = S.settings, logo = school && school.logo ? `<img src="${esc(school.logo)}" alt="">` : "", sch = (school && (school.displayName || school.name)) || "", sig = (s.status === "Final" && s.sign) || st.signatories;
  const earn = [[s.perHour ? `Teaching pay (${s.hours} hr${+s.hours === 1 ? "" : "s"} x ${money(s.rate)})` : "Basic pay", s.basic], ...(s.allowList || []).map((a) => [a.label || "Allowance", a.amount]), ...(s.ot ? [["Overtime", s.ot]] : []), ...(s.otherEarn ? [["Other earnings", s.otherEarn]] : [])];
  const loanSum = sumBy(s.dedList || [], (d) => d.amount), otherOnly = r2((+s.other || 0) - loanSum);
  const ded = [...(s.absent ? [[`Absences (${s.absentDays || 0} day${+s.absentDays === 1 ? "" : "s"})`, s.absent]] : []), ...(s.late ? [["Late / undertime", s.late]] : []), ["SSS", s.sssEe], ["PhilHealth", s.phicEe], ["Pag-IBIG", s.hdmfEe], ["Withholding tax", s.tax], ...(+s.caDed > 0 ? [["Cash advance", s.caDed]] : []),
    ...(s.dedList || []).filter((d) => +d.amount > 0).map((d) => [d.label && d.label !== d.type ? `${d.type}: ${d.label}` : d.label || d.type || "Deduction", d.amount]), ...(otherOnly > 0 ? [["Other deductions", otherOnly]] : [])];
  const n = Math.max(earn.length, ded.length, 5), rows = Array.from({ length: n }, (_, i) => `<tr><td>${earn[i] ? esc(earn[i][0]) : "&nbsp;"}</td><td class="r">${earn[i] ? money(earn[i][1]) : ""}</td><td>${ded[i] ? esc(ded[i][0]) : ""}</td><td class="r">${ded[i] ? money(ded[i][1]) : ""}</td></tr>`).join("");
  const bals = [...(+s.caBal > 0 || +s.caDed > 0 ? [`Cash advance balance after this pay: <b>${money(s.caAfter)}</b>`] : []), ...(s.dedList || []).filter((d) => d.balanceAfter !== null && d.balanceAfter !== undefined && d.balanceBefore !== null && +d.amount > 0).map((d) => `${esc(d.label || d.type)} balance after this pay: <b>${money(d.balanceAfter)}</b>`)];
  return `<div class="ps"><div class="hd">${logo}<div><p><b style="font-size:12px">${esc(sch)}</b></p><p>Finance - Payroll &middot; <b>${esc(copy)}</b></p></div></div><h1>PAYSLIP</h1>
  <table><tr><td colspan="2"><small>Employee</small><br><b>${esc(s.name)}</b></td><td><small>Employee No.</small><br><b>${esc(s.employeeId)}</b></td><td><small>Pay period</small><br><b>${esc(s.runLabel)}</b></td></tr>
  <tr><td colspan="2"><small>Position</small><br>${esc(s.position || "-")}</td><td><small>Department</small><br>${esc(s.department || "-")}</td><td><small>Pay date</small><br>${esc(dateText(s.payDate))}</td></tr></table>
  <table style="margin-top:4px"><tr><th>EARNINGS</th><th>Amount</th><th>DEDUCTIONS</th><th>Amount</th></tr>${rows}<tr class="tot"><td>GROSS PAY</td><td class="r">${money(s.gross)}</td><td>TOTAL DEDUCTIONS</td><td class="r">${money(s.totalDed)}</td></tr></table>
  ${s.inputs && s.inputs.dtr ? `<p><small>Attendance: present ${s.inputs.dtr.present} day(s) &middot; absent ${s.inputs.dtr.absent} &middot; late ${s.inputs.dtr.lateMin} min &middot; undertime ${s.inputs.dtr.utMin} min &middot; overtime ${s.inputs.dtr.otHrs} hr(s) &middot; hours worked ${s.inputs.dtr.hours}</small></p>` : ""}
  ${bals.length ? `<p><small>${bals.join(" &middot; ")}</small></p>` : ""}
  <div class="net">NET PAY: ${money(s.net)}</div>
  <div class="sg"><div><br>Received by<br><small><i>Employee</i></small></div>${signBlocks(sig)}</div>
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
  <div class="panel"><h2>Payroll register - ${esc(run0.label)}</h2><div class="tablewrap"><table><tr><th>Employee No.</th><th>Name</th><th>Department</th><th class="pr-num">Basic</th><th class="pr-num">Allow.</th><th class="pr-num">OT / other</th><th class="pr-num">Gross</th><th class="pr-num">Absent / late</th><th class="pr-num">SSS</th><th class="pr-num">PhilHealth</th><th class="pr-num">Pag-IBIG</th><th class="pr-num">Tax</th><th class="pr-num">Cash adv.</th><th class="pr-num">Loans / other</th><th class="pr-num">Net pay</th></tr>
    ${slips.map((s) => `<tr><td>${esc(s.employeeId)}</td><td>${esc(s.name)}</td><td>${esc(s.department || "")}</td><td class="pr-num">${money(s.basic)}</td><td class="pr-num">${money(s.allow)}</td><td class="pr-num">${money(r2(s.ot + s.otherEarn))}</td><td class="pr-num">${money(s.gross)}</td><td class="pr-num">${money(r2(s.absent + s.late))}</td><td class="pr-num">${money(s.sssEe)}</td><td class="pr-num">${money(s.phicEe)}</td><td class="pr-num">${money(s.hdmfEe)}</td><td class="pr-num">${money(s.tax)}</td><td class="pr-num">${money(s.caDed || 0)}</td><td class="pr-num">${money(s.other)}</td><td class="pr-num"><b>${money(s.net)}</b></td></tr>`).join("")}
    <tr class="pr-tot"><td colspan="3">TOTAL (${slips.length})</td><td class="pr-num">${money(T("basic"))}</td><td class="pr-num">${money(T("allow"))}</td><td class="pr-num">${money(r2(T("ot") + T("otherEarn")))}</td><td class="pr-num">${money(T("gross"))}</td><td class="pr-num">${money(r2(T("absent") + T("late")))}</td><td class="pr-num">${money(T("sssEe"))}</td><td class="pr-num">${money(T("phicEe"))}</td><td class="pr-num">${money(T("hdmfEe"))}</td><td class="pr-num">${money(T("tax"))}</td><td class="pr-num">${money(T("caDed"))}</td><td class="pr-num">${money(T("other"))}</td><td class="pr-num">${money(T("net"))}</td></tr></table></div></div>
  <div class="pr-grid"><div class="pr-card"><h3>By department</h3><div class="tablewrap"><table><tr><th>Department</th><th>Employees</th><th class="pr-num">Gross</th><th class="pr-num">Deductions</th><th class="pr-num">Net</th></tr>${Object.entries(dep).map(([d, v]) => `<tr><td>${esc(d)}</td><td>${v.n}</td><td class="pr-num">${money(v.gross)}</td><td class="pr-num">${money(v.ded)}</td><td class="pr-num">${money(v.net)}</td></tr>`).join("")}</table></div></div>
  <div class="pr-card"><h3>Government remittances and tax</h3><div class="tablewrap"><table><tr><th></th><th class="pr-num">Employee share</th><th class="pr-num">Employer share</th><th class="pr-num">Total to remit</th></tr>
    ${[["SSS", "sssEe", "sssEr"], ["PhilHealth", "phicEe", "phicEr"], ["Pag-IBIG", "hdmfEe", "hdmfEr"]].map(([l, a, b]) => `<tr><td>${l}</td><td class="pr-num">${money(T(a))}</td><td class="pr-num">${money(T(b))}</td><td class="pr-num">${money(r2(T(a) + T(b)))}</td></tr>`).join("")}<tr><td>Withholding tax</td><td class="pr-num">${money(T("tax"))}</td><td class="pr-num">-</td><td class="pr-num">${money(T("tax"))}</td></tr></table></div></div></div>${balancesHtml()}`}</div>`;
  $("rpRun").onchange = (e) => { S.repRun = e.target.value; rReports(); };
  if ($("rpPrint")) $("rpPrint").onclick = () => printWindow(`<div style="padding:4mm"><div class="ps"><h1>${esc((school && (school.displayName || school.name)) || "")} - PAYROLL REPORT</h1></div>${$("rpBody").innerHTML}</div>`, "Payroll report");
  if ($("rpXls")) $("rpXls").onclick = () => {
    if (!window.XLSX) return flash("The Excel writer did not load. Check your internet connection.");
    const wb = XLSX.utils.book_new(), reg = slips.map((s) => ({ "Employee No.": s.employeeId, Name: s.name, Position: s.position, Department: s.department, Basic: s.basic, Allowances: s.allow, Overtime: s.ot, "Other earnings": s.otherEarn, Gross: s.gross, Absences: s.absent, Late: s.late, SSS: s.sssEe, PhilHealth: s.phicEe, "Pag-IBIG": s.hdmfEe, Tax: s.tax, "Cash advance": s.caDed || 0, "Cash advance balance after": s.caAfter || 0, "Loans / other": s.other, "Total deductions": s.totalDed, "Net pay": s.net }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reg), "Payroll register");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([["SSS", T("sssEe"), T("sssEr")], ["PhilHealth", T("phicEe"), T("phicEr")], ["Pag-IBIG", T("hdmfEe"), T("hdmfEr")], ["Withholding tax", T("tax"), 0]].map(([k, a, b]) => ({ Item: k, "Employee share": a, "Employer share": b, "Total to remit": r2(a + b) }))), "Remittances");
    XLSX.writeFile(wb, `payroll-${run0.start}.xlsx`);
  };
}

/* ---------- settings ---------- */
const sigRow = (x) => `<div class="r"><input data-sg="label" placeholder="Role, e.g. Prepared by" maxlength="30" value="${esc(x.label || "")}"><input data-sg="name" placeholder="Full name" maxlength="80" value="${esc(x.name || "")}"><input data-sg="position" placeholder="Position, e.g. Finance Officer" maxlength="60" value="${esc(x.position || "")}"><button class="btn small danger" type="button" data-sgrm="1">Remove</button></div>`;
const holRow = (d, l) => `<div class="r"><input type="date" value="${esc(d || "")}"><input placeholder="Holiday name" maxlength="40" value="${esc(l || "")}"><button class="btn small danger" type="button" data-holrm="1">Remove</button></div>`;
function rSettings() {
  const s = S.settings, n = (id, v, step = "0.01") => `<input type="number" id="${id}" step="${step}" value="${v}">`, ck = (id, v) => `<label class="sc-chk"><input type="checkbox" id="${id}"${v ? " checked" : ""}> On</label>`;
  $("pSettings").innerHTML = `<div class="panel"><h2>Settings</h2><p class="muted">These are the rates the automatic computation uses. They start with the current Philippine rates (2026) but the government changes them, so <b>check them with the latest circulars</b>. A school under GSIS can change the rates below (or switch SSS off).</p>
  <div class="pr-card"><h3>Pay</h3><div class="row"><label>Pay frequency<select id="sFreq"><option value="semi"${s.frequency === "semi" ? " selected" : ""}>Twice a month (two cut-offs)</option><option value="monthly"${s.frequency === "monthly" ? " selected" : ""}>Once a month</option></select></label>
    <label>Working days a month <small>(daily rate = monthly pay / this)</small>${n("sDays", s.workDays, "1")}</label><label>Hours a day${n("sHours", s.hoursPerDay, "0.5")}</label><label>Overtime rate <small>(x hourly rate)</small>${n("sOt", s.otRate)}</label>
    <label>Contributions are taken<select id="sTiming"><option value="split"${s.contribTiming === "split" ? " selected" : ""}>Half in each pay</option><option value="first"${s.contribTiming === "first" ? " selected" : ""}>All in the 1st pay</option><option value="second"${s.contribTiming === "second" ? " selected" : ""}>All in the 2nd pay</option></select></label>
    <label class="sc-chk" style="margin-top:1.6rem"><input type="checkbox" id="sLeave"${s.unpaidLeave ? " checked" : ""}> Deduct approved leave without pay automatically</label></div></div>
  <div class="pr-card"><h3>Cut-off and pay date</h3><p class="muted fine">Every payroll can follow one of four cut-offs: <b>26th - 10th</b>, <b>11th - 25th</b>, <b>1st - 15th</b> or <b>16th - end of month</b> (or a whole month, or dates you type). Choose the cut-off on the Payroll tab each time; the pair below is only the one offered first. The pay day starts with these rules and can be changed for every payroll. Use 0 for the pay day to mean the last day of the month.</p>
    <div class="row"><label>Usual cut-offs<select id="sPair"><option value="B"${s.cutoffPair !== "A" ? " selected" : ""}>1st - 15th and 16th - end of month</option><option value="A"${s.cutoffPair === "A" ? " selected" : ""}>26th - 10th and 11th - 25th</option></select></label>
      <label>Pay day of the 1st cut-off <small>(26th - 10th or 1st - 15th)</small>${n("sPayF", s.period.payFirst, "1")}</label><label>Pay day of the 2nd cut-off <small>(11th - 25th or 16th - end)</small>${n("sPayS", s.period.paySecond, "1")}</label><label>Pay day when paid once a month${n("sPayW", s.period.payWhole, "1")}</label></div></div>
  <div class="pr-card"><h3>SSS</h3><p class="muted fine">Fixed amount is used by default. An employee can have an own fixed amount under Add information. The percent fields below are used only when you choose <b>Percent of the pay</b>.</p><div class="row"><label>Deduct${ck("sSssOn", s.sss.on)}</label><label>How is it computed?<select id="sSssM"><option value="fixed"${s.sss.mode !== "percent" ? " selected" : ""}>Fixed amount (a month)</option><option value="percent"${s.sss.mode === "percent" ? " selected" : ""}>Percent of the pay</option></select></label><label>Fixed amount: employee share (PHP a month)${n("sSssFe", s.sss.fixedEe)}</label><label>Fixed amount: employer share (PHP a month)${n("sSssFr", s.sss.fixedEr)}</label><label>Employee rate % <small>(percent mode)</small>${n("sSssR", s.sss.rate)}</label><label>Employer rate %${n("sSssE", s.sss.erRate)}</label><label>Employer EC (PHP)${n("sSssEc", s.sss.ec)}</label><label>Lowest salary credit${n("sSssMin", s.sss.min, "1")}</label><label>Highest salary credit${n("sSssMax", s.sss.max, "1")}</label></div></div>
  <div class="pr-card"><h3>PhilHealth</h3><div class="row"><label>Deduct${ck("sPhOn", s.phic.on)}</label><label>How is it computed?<select id="sPhM"><option value="fixed"${s.phic.mode !== "percent" ? " selected" : ""}>Fixed amount (a month)</option><option value="percent"${s.phic.mode === "percent" ? " selected" : ""}>Percent of the pay</option></select></label><label>Fixed amount: employee share (PHP a month)${n("sPhFe", s.phic.fixedEe)}</label><label>Fixed amount: employer share (PHP a month)${n("sPhFr", s.phic.fixedEr)}</label><label>Premium rate % (total)${n("sPhR", s.phic.rate)}</label><label>Employee share %${n("sPhS", s.phic.employeeShare, "1")}</label><label>Lowest base pay${n("sPhMin", s.phic.min, "1")}</label><label>Highest base pay${n("sPhMax", s.phic.max, "1")}</label></div></div>
  <div class="pr-card"><h3>Pag-IBIG</h3><div class="row"><label>Deduct${ck("sHdOn", s.hdmf.on)}</label><label>How is it computed?<select id="sHdM"><option value="fixed"${s.hdmf.mode !== "percent" ? " selected" : ""}>Fixed amount (a month)</option><option value="percent"${s.hdmf.mode === "percent" ? " selected" : ""}>Percent of the pay</option></select></label><label>Fixed amount: employee share (PHP a month)${n("sHdFe", s.hdmf.fixedEe)}</label><label>Fixed amount: employer share (PHP a month)${n("sHdFr", s.hdmf.fixedEr)}</label><label>Employee rate %${n("sHdR", s.hdmf.rate)}</label><label>Employer rate %${n("sHdE", s.hdmf.erRate)}</label><label>Monthly fund salary cap${n("sHdCap", s.hdmf.cap, "1")}</label></div></div>
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
  <div class="pr-card"><h3>Signatories printed on the payslip</h3><p class="muted fine">Who signs the payslip: name and position (for example <b>Prepared by</b> - your name - <b>Finance Officer</b>). The employee's "Received by" is always printed first. Up to 3 signatories; the last one is also printed on the DTR. A payroll keeps the signatories it was finalized with.</p>
    <div class="pr-rows" id="sSig">${s.signatories.map((x) => sigRow(x)).join("")}</div><button class="btn small" type="button" id="sSigAdd">Add a signatory</button></div>
  <div class="btnbar"><button class="btn primary" id="sSave" type="button">Save settings</button><button class="btn" id="sReset" type="button">Restore the default rates</button></div></div>`;
  $("sSigAdd").onclick = () => { if (document.querySelectorAll("#sSig .r").length >= 3) return flash("Up to 3 signatories."); $("sSig").insertAdjacentHTML("beforeend", sigRow({ label: "", name: "", position: "" })); };
  $("sSig").onclick = (e) => { const b = e.target.closest("[data-sgrm]"); if (b) b.closest(".r").remove(); };
  $("sHolAdd").onclick = () => $("sHol").insertAdjacentHTML("beforeend", holRow("", ""));
  $("sHol").onclick = (e) => { const b = e.target.closest("[data-holrm]"); if (b) b.closest(".r").remove(); };
  $("sSave").onclick = () => run(async () => {
    const v = (id) => +$(id).value, c = (id) => $(id).checked;
    const brackets = [...document.querySelectorAll("#sTax tr")].slice(1).map((r) => { const i = r.querySelectorAll("input"); return { over: +i[0].value || 0, rate: +i[1].value || 0, base: +i[2].value || 0 }; }).sort((a, b) => a.over - b.over);
    if (!brackets.length || brackets[0].over !== 0) return flash("The first tax row must start at 0.");
    if (!(v("sDays") >= 1 && v("sHours") > 0)) return flash("Check the working days and hours.");
    if (toMin($("dStart").value || "08:00") >= toMin($("dEnd").value || "17:00")) return flash("The work end time must be after the work start time.");
    if (!document.querySelector("[data-wd]:checked")) return flash("Tick at least one working day.");
    const per = { ...S.settings.period, payFirst: v("sPayF"), paySecond: v("sPayS"), payWhole: v("sPayW") };
    if ([per.payFirst, per.paySecond, per.payWhole].some((x) => !(x >= 0 && x <= 31))) return flash("A pay day must be 0 (last day of the month) or a day from 1 to 31.");
    if (["sSssFe", "sSssFr", "sPhFe", "sPhFr", "sHdFe", "sHdFr"].some((id) => !(v(id) >= 0))) return flash("A fixed amount cannot be negative.");
    const signatories = [...document.querySelectorAll("#sSig .r")].map((r) => { const g = (k) => r.querySelector(`[data-sg="${k}"]`).value.trim(); return { label: g("label"), name: g("name"), position: g("position") }; }).filter((x) => x.label || x.name || x.position);
    if (!signatories.length) return flash("Add at least one signatory (for example Prepared by - your name - Finance Officer).");
    const data = { schoolId: SID, frequency: $("sFreq").value, cutoffPair: $("sPair").value, workDays: v("sDays"), hoursPerDay: v("sHours"), otRate: v("sOt"), contribTiming: $("sTiming").value, unpaidLeave: c("sLeave"),
      sss: { on: c("sSssOn"), mode: $("sSssM").value, fixedEe: v("sSssFe"), fixedEr: v("sSssFr"), rate: v("sSssR"), erRate: v("sSssE"), ec: v("sSssEc"), min: v("sSssMin"), max: v("sSssMax"), step: 500 }, phic: { on: c("sPhOn"), mode: $("sPhM").value, fixedEe: v("sPhFe"), fixedEr: v("sPhFr"), rate: v("sPhR"), employeeShare: v("sPhS"), min: v("sPhMin"), max: v("sPhMax") },
      hdmf: { on: c("sHdOn"), mode: $("sHdM").value, fixedEe: v("sHdFe"), fixedEr: v("sHdFr"), rate: v("sHdR"), erRate: v("sHdE"), cap: v("sHdCap") }, tax: { on: c("sTxOn"), brackets }, dtr: { start: $("dStart").value || "08:00", end: $("dEnd").value || "17:00", lunchMin: v("dLunch"), graceMin: v("dGrace"), otStartMin: v("dOtS"), otBlockMin: Math.max(5, v("dOtB")), halfDayHrs: v("dHalf"), dateOrder: $("dOrder").value, restDayAsOt: c("dRest"), workDays: [...document.querySelectorAll("[data-wd]:checked")].map((x) => +x.dataset.wd),
        holidays: [...document.querySelectorAll("#sHol .r")].map((r) => { const i = r.querySelectorAll("input"); return { date: i[0].value, label: i[1].value.trim() }; }).filter((h) => h.date) }, period: per, signatories, updatedAt: serverTimestamp() };
    await setDoc(doc(db, "payrollSettings", SID), data); await refresh(); flash("Settings saved. New computations use them; saved payroll is not changed.", true);
  });
  $("sReset").onclick = () => run(async () => { const a = await showPopup({ title: "Restore the default rates?", html: "<p>Your changes to the rates and the tax table are replaced by the defaults.</p>", buttons: [{ label: "Cancel", value: "no" }, { label: "Restore", value: "yes", primary: true }] }); if (a.value !== "yes") return; await setDoc(doc(db, "payrollSettings", SID), { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), schoolId: SID, updatedAt: serverTimestamp() }); await refresh(); flash("Defaults restored.", true); });
}

await refresh(); show("dash");
// Another user changed something this page shows: a notice with an Update button appears (db.js). Nothing reloads until it is pressed, and what you have open (payroll, form, DTR) is kept.
liveRefresh(["employees", "payrollInfo", "payrollRuns", "payrollSettings", "leaveRequests", "payrollDtr"], () => { S.dtr = {}; S.slips = {}; return refresh(true); });
