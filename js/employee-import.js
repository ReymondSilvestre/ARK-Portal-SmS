/* Upload many employees at once from an Excel (or CSV) file.
   Used by HR (Add employee) and by the IT Admin (Employee registration), so nobody has to fill the form one employee at a time.
   Flow: download the Excel template  ->  fill it in  ->  choose the file  ->  check the preview  ->  Import.
   The same information as the form is kept (the 2x2 photo is added later with Edit). Employee No. already registered = skipped (or updated, if you tick the box). */
import { collection, doc, writeBatch, serverTimestamp } from "./db.js";
import { db, esc, staffKey, friendlyError } from "./auth.js";
import { FIELDS, STATUSES, TYPES, ACCESS, accessFor } from "./employee-fields.js";

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const ALIAS = {
  employeeId: ["employeeno", "employeenumber", "employeeid", "empno", "empid", "idno", "idnumber", "id"],
  lastName: ["lastname", "surname", "familyname"],
  firstName: ["firstname", "givenname"],
  middleInitial: ["mi", "middleinitial", "middlename", "middle"],
  birthday: ["birthday", "birthdate", "dateofbirth", "dob", "birthdaymmddyyyy"],
  gender: ["gender", "sex"],
  civilStatus: ["civilstatus", "maritalstatus"],
  employmentType: ["employmenttype", "employmentstatus", "type"],
  dateHired: ["datehired", "hiredate", "datestarted", "dateofhire"],
  accessType: ["portalaccount", "accounttype", "access", "account"],
  contact: ["contactno", "contactnumber", "mobile", "mobileno", "phone", "cellphone", "cellphoneno"],
  emergencyName: ["emergencycontactperson", "emergencycontactname", "emergencyperson"],
  emergencyContact: ["emergencycontactno", "emergencycontactnumber", "emergencyno"],
  sss: ["sssno", "sss", "sssnumber"], philhealth: ["philhealthno", "philhealth", "philhealthnumber"], pagibig: ["pagibigno", "pagibig", "pagibignumber", "hdmf"],
  tin: ["tin", "tinno", "tinnumber"], prc: ["prclicenseno", "prc", "prclicense", "prcno"],
};
const HEADER_TO_FIELD = (() => { const m = new Map(); FIELDS.forEach((f) => { m.set(norm(f.label), f.id); m.set(norm(f.id), f.id); (ALIAS[f.id] || []).forEach((a) => m.set(a, f.id)); }); return m; })();

const pad = (n) => String(n).padStart(2, "0");
function ymd(y, m, d) { const t = new Date(y, m - 1, d); return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d && y > 1900 && y < 2100 ? `${y}-${pad(m)}-${pad(d)}` : null; }
/** Excel date number, "2026-11-05", "11/5/2026" (month first; day first when the first number is over 12) or "Nov 5, 2026" -> "YYYY-MM-DD" (null = not a date, "" = empty). */
export function toIsoDate(v) {
  if (v === "" || v === null || v === undefined) return "";
  if (v instanceof Date) return ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === "number") { const c = window.XLSX && XLSX.SSF.parse_date_code(v); return c ? ymd(c.y, c.m, c.d) : null; }
  const s = String(v).trim(); let m;
  if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/))) { let a = +m[1], b = +m[2], y = +m[3]; if (y < 100) y += y > 30 ? 1900 : 2000; if (a > 12 && b <= 12) [a, b] = [b, a]; return ymd(y, a, b); }
  const t = Date.parse(s); if (!isNaN(t)) { const d = new Date(t); return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
  return null;
}
const cellText = (v) => (v === null || v === undefined || v instanceof Date ? "" : String(v)).trim();
const pick = (v, options) => { const n = norm(v); return options.find((o) => norm(o) === n) || ""; };
function accessOf(v) {
  const n = norm(v); if (!n) return "";
  const hit = ACCESS.filter(([k]) => k).find(([k, label]) => norm(k) === n || norm(label) === n || (n.length >= 4 && norm(label).startsWith(n)));
  if (hit) return hit[0];
  if (/^(no|none|n\/?a|noaccount|noneeded)/.test(n)) return "";
  if (/^(financepayroll|payrollofficer)$/.test(n)) return "payroll";
  if (/^(faculty|teacher|instructor)$/.test(n)) return "teacher";
  if (/^(schooladmin|principal|schoolhead)$/.test(n)) return "schooladmin";
  return null;
}

/** One sheet row -> { values, errors } using the columns found in the header row. */
function readRow(raw, cols, lists) {
  const v = {}, errors = [];
  FIELDS.forEach((f) => (v[f.id] = ""));
  Object.entries(cols).forEach(([c, fid]) => {
    const f = FIELDS.find((x) => x.id === fid), x = raw[c];
    if (f.type === "date") { const d = toIsoDate(x); if (d === null) errors.push(`${f.label} "${cellText(x)}" is not a date`); else v[fid] = d; return; }
    let t = cellText(x);
    if (fid === "middleInitial") { v[fid] = t.replace(/[^A-Za-z]/g, "").slice(0, 1).toUpperCase(); return; }
    if (fid === "gender") { const g = /^m/i.test(t) ? "Male" : /^f/i.test(t) ? "Female" : ""; if (t && !g) errors.push(`Gender "${t}" should be Male or Female`); v[fid] = g; return; }
    if (f.type === "select") { const o = t ? pick(t, f.options) : ""; if (t && !o) errors.push(`${f.label} "${t}" is not one of: ${f.options.join(", ")}`); v[fid] = o; return; }
    if (f.type === "list") { v[fid] = t ? (lists[f.list] || []).find((o) => norm(o) === norm(t)) || t : ""; return; }
    if (f.type === "access") { const a = accessOf(t); if (a === null) errors.push(`Portal account "${t}" is not valid`); else v[fid] = a; return; }
    if (f.type === "email" && t && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t)) { errors.push(`Email "${t}" is not valid`); return; }
    v[fid] = f.max ? t.slice(0, f.max) : t.slice(0, 500);
  });
  return { values: v, errors };
}

/** Parses the workbook: the first sheet, the first row with at least 2 known column titles is the header. */
export function parseWorkbook(buf, existing, lists, sid) {
  if (!window.XLSX) throw new Error("The Excel reader did not load. Check your internet connection and reload the page.");
  const wb = XLSX.read(buf, { type: "array" }), ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("The file has no sheet.");
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
  let h = grid.findIndex((r) => r.filter((c) => HEADER_TO_FIELD.has(norm(c))).length >= 2);
  if (h < 0) throw new Error("The column titles were not found. Download the template and keep its first row (Employee No., Last name, First name, Birthday ...).");
  const cols = {}; grid[h].forEach((c, i) => { const fid = HEADER_TO_FIELD.get(norm(c)); if (fid && !Object.values(cols).includes(fid)) cols[i] = fid; });
  const need = ["employeeId", "lastName", "firstName", "birthday"].filter((f) => !Object.values(cols).includes(f));
  if (need.length) throw new Error("These columns are missing from the file: " + need.map((f) => FIELDS.find((x) => x.id === f).label).join(", ") + ".");
  const rows = [], seen = new Map();
  for (let r = h + 1; r < grid.length; r++) {
    const raw = grid[r]; if (!raw.some((c) => cellText(c) !== "")) continue;
    const { values, errors } = readRow(raw, cols, lists);
    if (!values.employeeId) errors.unshift("Employee No. is empty");
    if (!values.lastName) errors.push("Last name is empty");
    if (!values.firstName) errors.push("First name is empty");
    if (!values.birthday && !errors.some((e) => e.startsWith("Birthday"))) errors.push("Birthday is empty (it is used for the first password)");
    const given = Object.entries(cols).filter(([c]) => cellText(raw[c]) !== "").map(([, fid]) => fid);
    if (!values.accessType && !(Object.values(cols).includes("accessType") && cellText(raw[Object.keys(cols).find((k) => cols[k] === "accessType")]))) values.accessType = accessFor(values.position);
    const key = values.employeeId ? staffKey(sid, values.employeeId) : "";
    let state = errors.length ? "error" : "new";
    if (!errors.length && seen.has(key)) { errors.push(`Same Employee No. as row ${seen.get(key)} of the file`); state = "error"; }
    if (values.employeeId && !seen.has(key)) seen.set(key, r + 1);
    if (state === "new" && existing.has(key)) state = "exists";
    rows.push({ line: r + 1, values, errors, state, given });
  }
  return { rows, columns: Object.values(cols) };
}

/** Downloads the Excel template. */
export function downloadTemplate(lists) {
  if (!window.XLSX) return alert("The Excel writer did not load. Check your internet connection.");
  const head = FIELDS.map((f) => f.label + (f.req ? " *" : ""));
  const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet([head]);
  ws["!cols"] = FIELDS.map((f) => ({ wch: Math.max(14, f.label.length + 4) }));
  XLSX.utils.book_append_sheet(wb, ws, "Employees");
  const ex = { "Employee No.": "1001", "Last name": "Dela Cruz", "First name": "Juan", "M.I.": "S", Birthday: "1990-05-21", Gender: "Male", "Civil status": "Single", Position: "Teacher", Department: "Junior High School", "Employment type": "Regular", "Date hired": "2020-06-01", Status: "Active", "Portal account": "Faculty / Teacher", "Contact No.": "09171234567", Email: "juan@example.com" };
  const help = [["How to fill in the Employees sheet"], [""], ["1. Type one employee in each row, starting in row 2. Do not change or delete the column titles in row 1 (the * marks the required columns)."], ["2. Required: Employee No., Last name, First name, Birthday (the birthday is used for the first password)."], ["3. Dates: write them as 2026-05-21 (year-month-day) or as a normal Excel date."],
    ["4. Gender: " + "Male / Female.   Civil status: Single / Married / Widowed / Separated.   Status: " + STATUSES.join(" / ") + "."], ["5. Employment type: " + TYPES.join(" / ") + "."], ["6. Position examples: " + (lists.positions || []).join(", ")], ["7. Department examples: " + (lists.departments || []).join(", ")],
    ["8. Portal account (leave blank = it follows the position): " + ACCESS.filter(([k]) => k).map(([, l]) => l.split(" (")[0]).join(" / ")], ["9. The 2x2 photo is not uploaded from Excel: add it later with Edit. Format the Contact No. columns as Text so the leading 0 is kept."], ["10. Delete nothing from this help sheet; only the Employees sheet is read."], [""], ["Example row:"], [Object.keys(ex).join(" | ")], [Object.values(ex).join(" | ")]];
  const wh = XLSX.utils.aoa_to_sheet(help); wh["!cols"] = [{ wch: 130 }];
  XLSX.utils.book_append_sheet(wb, wh, "How to fill");
  XLSX.writeFile(wb, "employee-upload-template.xlsx");
}

let KEEP = null;   // the last file read (kept when the page redraws itself)
/** Draws the upload panel in `host`.  ctx: { SID, user, byName, extra, existing(): Map(key -> employee), lists(), onDone(): Promise } */
export function mountEmployeeImport(host, ctx) {
  let H = host;
  const root = () => { if (!H.isConnected && H.id && document.getElementById(H.id)) H = document.getElementById(H.id); return H; };   // the page may have redrawn itself
  const $ = (s) => root().querySelector(s);
  const draw = () => {
    const K = KEEP && KEEP.sid === ctx.SID ? KEEP : null, rows = K ? K.rows : [];
    const n = (s) => rows.filter((r) => r.state === s).length, upd = K && K.update;
    const will = n("new") + (upd ? n("exists") : 0);
    root().innerHTML = `<div class="panel"><h2>Upload many employees from Excel</h2>
      <p class="muted">Do not fill out the form one by one: type (or paste) all employees in an Excel file, upload it here and press <b>Import</b>. <b>1.</b> Download the template. <b>2.</b> Fill it in (one employee a row). <b>3.</b> Choose the file and check the preview.</p>
      <div class="btnbar"><button class="btn" id="impTpl" type="button">Download the Excel template</button></div>
      <div class="row"><label>Choose the Excel file <small>(.xlsx, .xls or .csv)</small><input type="file" id="impFile" accept=".xlsx,.xls,.csv"></label></div>
      <div id="impMsg" class="notice" hidden></div>
      ${K ? `<p><b>${esc(K.name)}</b>: ${rows.length} row${rows.length === 1 ? "" : "s"} read &middot; <span class="badge st-enrolled">${n("new")} new</span> <span class="badge st-pending">${n("exists")} already registered</span> <span class="badge st-out">${n("error")} with a problem</span></p>
      ${n("exists") ? `<label class="sc-chk"><input type="checkbox" id="impUpd"${upd ? " checked" : ""}> Also update the ${n("exists")} employee(s) that are already registered (only the columns that are filled in; empty cells keep what is saved)</label>` : ""}
      <div class="tablewrap"><table><tr><th>Row</th><th>Employee No.</th><th>Name</th><th>Birthday</th><th>Position</th><th>Department</th><th>Result</th></tr>${rows.slice(0, 300).map((r) => `<tr><td>${r.line}</td><td>${esc(r.values.employeeId)}</td><td>${esc(r.values.lastName)}, ${esc(r.values.firstName)}</td><td>${esc(r.values.birthday)}</td><td>${esc(r.values.position)}</td><td>${esc(r.values.department)}</td><td>${r.state === "error" ? `<span class="pr-warn">${esc(r.errors.join("; "))}</span>` : r.state === "exists" ? (upd ? "Will be updated" : "Already registered - skipped") : "Will be added"}</td></tr>`).join("")}</table></div>
      ${rows.length > 300 ? `<p class="muted fine">The first 300 rows are shown; all ${rows.length} are imported.</p>` : ""}
      ${n("error") ? `<p class="muted fine">Rows with a problem are <b>not</b> imported. Fix them in the Excel file and upload it again (the ones already imported are skipped then).</p>` : ""}
      <div class="btnbar"><button class="btn primary" id="impGo" type="button"${will ? "" : " disabled"}>Import ${will} employee${will === 1 ? "" : "s"}</button><button class="btn" id="impClear" type="button">Clear</button></div>` : ""}</div>`;
    $("#impTpl").onclick = () => downloadTemplate(ctx.lists());
    $("#impFile").onchange = (ev) => read(ev.target.files[0]);
    if ($("#impUpd")) $("#impUpd").onchange = (e) => { KEEP.update = e.target.checked; draw(); };
    if ($("#impClear")) $("#impClear").onclick = () => { KEEP = null; draw(); };
    if ($("#impGo")) $("#impGo").onclick = go;
  };
  const say = (t, ok) => { const m = $("#impMsg"); if (!m) return; m.textContent = t; m.className = "notice " + (ok ? "ok" : "err"); m.hidden = false; };
  async function read(file) {
    if (!file) return;
    try {
      const { rows } = parseWorkbook(await file.arrayBuffer(), ctx.existing(), ctx.lists(), ctx.SID);
      if (!rows.length) { KEEP = null; draw(); return say("No employee row was found under the column titles.", false); }
      KEEP = { sid: ctx.SID, name: file.name, rows, update: false }; draw();
    } catch (e) { console.error(e); say(e.message || "That file could not be read.", false); }
  }
  async function go() {
    const K = KEEP; if (!K) return;
    const todo = K.rows.filter((r) => r.state === "new" || (r.state === "exists" && K.update));
    if (!todo.length) return;
    const btn = $("#impGo"); btn.disabled = true; let done = 0, added = 0, updated = 0;
    try {
      for (let i = 0; i < todo.length; i += 40) {
        const b = writeBatch();
        for (const r of todo.slice(i, i + 40)) {
          const key = staffKey(ctx.SID, r.values.employeeId), ref = doc(db, "employees", key);
          if (r.state === "exists" && K.update) { const patch = { updatedAt: serverTimestamp() }; Object.entries(r.values).forEach(([k, val]) => { if (k !== "employeeId" && val !== "" && r.given.includes(k)) patch[k] = val; }); b.update(ref, patch); updated++; }
          else { b.set(ref, { ...r.values, status: r.values.status || "Active", photo: "", schoolId: ctx.SID, createdBy: ctx.user.uid, ...(ctx.extra || {}), createdAt: serverTimestamp() }); added++; }
        }
        await b.commit(); done += Math.min(40, todo.length - i); btn.textContent = `Importing ${done} of ${todo.length}...`;
      }
      const lb = writeBatch(); lb.set(doc(collection(db, "hrLog")), { schoolId: ctx.SID, byUid: ctx.user.uid, byName: ctx.byName, action: `Imported from Excel (${added} added${updated ? ", " + updated + " updated" : ""})`, targetName: K.name, targetNo: "", createdAt: serverTimestamp() }); await lb.commit().catch(() => {});
      KEEP = null; await ctx.onDone(); draw();
      say(`${added} employee${added === 1 ? "" : "s"} added${updated ? `, ${updated} updated` : ""}. ${K.rows.filter((r) => r.state === "error").length ? "Rows with a problem were not imported." : ""}`, true);
    } catch (e) { console.error(e); const why = friendlyError(e); try { await ctx.onDone(); } catch (_) { /* the list reloads by itself later */ } const now = ctx.existing(); K.rows.forEach((r) => { if (r.state === "new" && now.has(staffKey(ctx.SID, r.values.employeeId))) r.state = "exists"; }); draw(); say(`Stopped: ${why} Up to ${done} of ${todo.length} were saved before this. Press Import again to continue (the ones saved are skipped).`, false); }
  }
  draw();
}
