import { liveRefresh } from "./db.js";   // live updates: other users' saves appear here by themselves
import { requireRole, logout, db, esc, friendlyError, staffEmail, sharedEmail, defaultStudentPassword, fullName, applyBranding, cleanEmail, forgetMe } from "./auth.js";
import { squarePhoto } from "./photo.js";
import {
  collection, query, where, orderBy, limit, getDocs, getCountFromServer,
  doc, setDoc, updateDoc, deleteDoc, addDoc, serverTimestamp, callFn
} from "./db.js";

const $ = (id) => document.getElementById(id);
// The school's IT admin. Everything below is limited to this one school.
const { user, profile, school } = await requireRole(["admin"]);
const SID = profile.schoolId;
$("who").textContent = profile.displayName; $("school").textContent = `School code: ${school.code}`;
$("out").onclick = logout;
applyBranding(school);
// Lets teachers (who cannot read the IT Admin's profile) build the shared reset-inbox address.
if (!school.adminEmail && profile.email) { school.adminEmail = profile.email; updateDoc(doc(db, "schools", SID), { adminEmail: profile.email, updatedAt: serverTimestamp() }).catch(() => {}); }

/* ---------- helpers ---------- */
const msg = $("msg");
function flash(text, ok = false) {
  msg.textContent = text; msg.className = "notice " + (ok ? "ok" : "err"); msg.hidden = false;
  clearTimeout(flash.t); flash.t = setTimeout(() => (msg.hidden = true), 8000);
}
const fmt = (ts) => (ts?.toDate ? ts.toDate().toLocaleString() : "-");
function popup(title, body, secret) {
  $("dlgTitle").textContent = title; $("dlgBody").textContent = body;
  $("dlgPw").hidden = $("dlgCopy").hidden = !secret; $("dlgPw").textContent = secret || "";
  $("dlg").showModal();
}
$("dlgOk").onclick = () => { $("dlg").close(); $("dlgPw").textContent = ""; };
$("dlgCopy").onclick = () => navigator.clipboard?.writeText($("dlgPw").textContent);
const ask = (text) => confirm(text);
const lastOf = (t) => t.lastName || String(t.displayName || "").split(",")[0];
const pwOf = (t) => defaultStudentPassword({ birthday: t.birthday, lastName: lastOf(t) });
const ROLE_NAME = { teacher: "Teacher", registrar: "Registrar", finance: "Finance", payroll: "Finance - Payroll", custodian: "Custodian", guidance: "Guidance", hr: "HR", schooladmin: "School Admin", staff: "Other staff" };
const ROLE_LABEL = { student: "student", registrar: "registrar", finance: "finance", payroll: "finance - payroll", custodian: "custodian", guidance: "guidance", hr: "HR", schooladmin: "school admin", staff: "other staff", teacher: "faculty / teacher" };
const userOf = (t) => (t.role === "student" ? t.studentId : t.employeeId);

/* ---------- connection indicator ---------- */
function setSync() {
  const on = navigator.onLine;
  $("sync").className = "sync" + (on ? "" : " off");
  $("sync").lastElementChild.textContent = on ? "Online" : "Offline - changes need a connection";
}
addEventListener("online", setSync); addEventListener("offline", setSync); setSync();

/* ---------- navigation ---------- */
const titles = { dashboard: "Dashboard", employees: "Employee registration", teachers: "Accounts", branding: "Branding", activity: "Activity log" };
function nav() {
  const v = titles[location.hash.slice(1)] ? location.hash.slice(1) : "dashboard";
  document.querySelectorAll("[data-view]").forEach((s) => (s.hidden = s.dataset.view !== v));
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.v === v));
  $("title").textContent = titles[v];
}
addEventListener("hashchange", nav); nav();

const logAudit = (action, targetUid, details = {}) =>
  addDoc(collection(db, "auditLogs"), { actorUid: user.uid, schoolId: SID, action, targetUid, details, createdAt: serverTimestamp() });

/* ---------- accounts of this school ---------- */
let users = [], teachers = [], stuInfo = new Map(), empRecs = null;
const syOf = (ts) => { const d = ts?.toDate ? ts.toDate() : null; if (!d) return "Unknown year"; const y = d.getFullYear(); return d.getMonth() >= 5 ? `${y}-${y + 1}` : `${y - 1}-${y}`; };
const UI = { acc: "emp" };
async function loadTeachers() {
  const [snap, st] = await Promise.all([
    getDocs(query(collection(db, "users"), where("schoolId", "==", SID), where("role", "in", ["teacher", "registrar", "finance", "payroll", "custodian", "guidance", "hr", "schooladmin", "staff", "student"]))),
    getDocs(query(collection(db, "students"), where("schoolId", "==", SID))).catch(() => null),
  ]);
  users = snap.docs.map((d) => d.data()).sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
  stuInfo = new Map(st ? st.docs.map((d) => [d.id, d.data()]) : []);
  teachers = users.filter((u) => u.role === "teacher");
  renderTeachers();
  $("s-teachers").textContent = teachers.length;
  $("s-active").textContent = teachers.filter((t) => t.status === "active").length;
  $("s-students").textContent = users.filter((u) => u.role === "student").length;
}
const rowActions = (t) => { const stu = t.role === "student"; return `
  <button class="btn small" data-act="toggle" data-uid="${esc(t.uid)}">${t.status === "active" ? "Suspend" : "Reactivate"}</button>
  ${stu ? "" : `<button class="btn small" data-act="details" data-uid="${esc(t.uid)}">Details</button>`}
  ${t.hasRealEmail ? `<button class="btn small" data-act="mail" data-uid="${esc(t.uid)}">Email reset link</button>` : ""}
  <button class="btn small" data-act="reset" data-uid="${esc(t.uid)}">Reset password</button><button class="btn small" data-act="setpw" data-uid="${esc(t.uid)}">Set password</button>
  ${stu ? "" : `<button class="btn small" data-act="photo" data-uid="${esc(t.uid)}">Change photo</button><button class="btn small" data-act="photodel" data-uid="${esc(t.uid)}">Remove photo</button>`}
  <button class="btn small danger" data-act="remove" data-uid="${esc(t.uid)}">Remove account</button>`; };
let shownEmp = [];
function renderTeachers() {
  const emps = users.filter((u) => u.role !== "student"), stus = users.filter((u) => u.role === "student");
  $("nEmp").textContent = emps.length; $("nStu").textContent = stus.length;
  $("accEmp").hidden = UI.acc !== "emp"; $("accStu").hidden = UI.acc !== "stu";
  document.querySelectorAll("[data-acc]").forEach((b) => b.classList.toggle("on", b.dataset.acc === UI.acc));
  /* employees: one table, Employee No. first */
  const q = $("q").value.trim().toLowerCase(), rf = $("roleF").value;
  shownEmp = emps.filter((t) => (!rf || t.role === rf) && (!q || [t.displayName, t.employeeId, t.position, t.department].join(" ").toLowerCase().includes(q)));
  $("teachers").innerHTML = `<tr><th>Employee No.</th><th>Name</th><th>Account type</th><th>Position / department</th><th>Status</th><th>Created</th><th></th></tr>` +
    (shownEmp.length ? shownEmp.map((t) => `<tr><td><b>${esc(t.employeeId)}</b><small>Sign in: ${esc(school.code)} / ${esc(t.employeeId)}</small></td><td>${esc(t.displayName)}${t.hasRealEmail ? `<small>${esc(t.email)}</small>` : ""}</td><td>${ROLE_LABEL[t.role] || esc(t.role)}</td>
      <td>${esc(t.position || "-")}${t.department ? `<small>${esc(t.department)}</small>` : ""}</td><td><span class="badge ${esc(t.status)}">${esc(t.status)}</span></td><td>${fmt(t.createdAt)}</td><td class="actions">${rowActions(t)}</td></tr>`).join("") : `<tr><td colspan="7">No accounts found.</td></tr>`);
  /* students: school year > section */
  const qs = $("qs").value.trim().toLowerCase();
  const info = (t) => ({ year: syOf(t.createdAt), sec: (stuInfo.get(t.studentId) || {}).className || "No section" });
  const years = [...new Set(stus.map((t) => info(t).year))].sort().reverse(), yf = $("yearF").value || years[0] || "";
  $("yearF").innerHTML = `<option value="*">All school years</option>` + years.map((y) => `<option${y === yf ? " selected" : ""}>${esc(y)}</option>`).join("");
  if (!$("yearF").value) $("yearF").value = "*";
  const yv = $("yearF").value, secs = [...new Set(stus.filter((t) => yv === "*" || info(t).year === yv).map((t) => info(t).sec))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), sf = $("secF").value;
  $("secF").innerHTML = `<option value="">All sections</option>` + secs.map((x) => `<option${x === sf ? " selected" : ""}>${esc(x)}</option>`).join("");
  const list = stus.filter((t) => (yv === "*" || info(t).year === yv) && (!$("secF").value || info(t).sec === $("secF").value) && (!qs || [t.displayName, t.studentId].join(" ").toLowerCase().includes(qs)));
  const by = {}; list.forEach((t) => { const i = info(t); ((by[i.year] ||= {})[i.sec] ||= []).push(t); });
  $("studentGroups").innerHTML = Object.keys(by).sort().reverse().map((y) => `<details class="sc-card" open><summary><b>School year ${esc(y)}</b> &middot; ${Object.values(by[y]).reduce((n, l) => n + l.length, 0)} students</summary>` +
    Object.keys(by[y]).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((sec) => { const l = by[y][sec], ids = l.map((t) => t.uid).join(",");
      return `<details open style="margin:.6rem 0 0 .8rem"><summary><b>${esc(sec)}</b> &middot; ${l.length} students
        <span class="actions" style="display:inline-flex;margin-left:.6rem"><button class="btn small" data-bulk="default" data-uids="${esc(ids)}" data-label="${esc(sec)}">Default password for this section</button><button class="btn small" data-bulk="custom" data-uids="${esc(ids)}" data-label="${esc(sec)}">Set one password for this section</button></span></summary>
        <div class="tablewrap"><table><tr><th>Exam ID No.</th><th>Name</th><th>Status</th><th>Created</th><th></th></tr>${l.map((t) => `<tr><td><b>${esc(t.studentId)}</b></td><td>${esc(t.displayName)}${t.hasRealEmail ? `<small>${esc(t.email)}</small>` : ""}</td><td><span class="badge ${esc(t.status)}">${esc(t.status)}</span></td><td>${fmt(t.createdAt)}</td><td class="actions">${rowActions(t)}</td></tr>`).join("")}</table></div></details>`; }).join("") + `</details>`).join("") || `<p class="muted">No student accounts found.</p>`;
}
$("q").addEventListener("input", renderTeachers); $("roleF").addEventListener("change", renderTeachers); $("qs").addEventListener("input", renderTeachers);
$("yearF").addEventListener("change", () => { $("secF").value = ""; renderTeachers(); }); $("secF").addEventListener("change", renderTeachers);
document.querySelectorAll("[data-acc]").forEach((b) => (b.onclick = () => { UI.acc = b.dataset.acc; renderTeachers(); }));

/* ---------- set the passwords of many accounts at once ---------- */
async function bulkSet(uids, label, how) {
  if (!uids.length) return flash("There is no account to change.");
  let useDefault = how === "default", pw = "";
  if (how.startsWith("custom-")) { pw = how.slice(7); if (pw.length < 10 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return flash("Use at least 10 characters with a letter and a number."); if (!ask(`Give ALL ${uids.length} listed accounts this password? They must choose their own at the next sign-in.`)) return; }
  else if (!useDefault) {
    pw = prompt(`Type ONE password for all ${uids.length} accounts (${label}).\n\nStudents: at least 6 characters. Employees: at least 10, with a letter and a number.\nEveryone must choose their own new password at the next sign-in.`);
    if (pw === null) return; if (pw.length < 6) return flash("The password is too short.");
  } else if (!ask(`Set the temporary password (birth year + first letter of the last name) for ${uids.length} accounts (${label})? Their current passwords stop working. Everyone must choose a new one at the next sign-in.`)) return;
  let done = 0; const skipped = [];
  for (let i = 0; i < uids.length; i += 40) { const r = await callFn("adminBulkSetPassword", { uids: uids.slice(i, i + 40), useDefault, password: pw }); done += r.done; skipped.push(...(r.skipped || [])); }
  flash(`Password set for ${done} account${done === 1 ? "" : "s"}.` + (skipped.length ? ` Skipped ${skipped.length} (no birthday on file, or the password was too weak for that account type): ${skipped.slice(0, 6).join(", ")}${skipped.length > 6 ? " ..." : ""}.` : ""), !skipped.length);
}
$("bulkEmp").onclick = () => run2(async () => { const how = prompt(`Set the password of the ${shownEmp.length} accounts in the list below.\n\nType 1 = birth-year default (everyone gets their own).\nOr type the password you want everybody to get (at least 10 characters, with a letter and a number).`); if (how === null || !how.trim()) return; await bulkSet(shownEmp.map((t) => t.uid), "listed employees", how.trim() === "1" ? "default" : "custom-" + how.trim()); });
const run2 = async (fn) => { try { await fn(); } catch (e) { flash(friendlyError(e)); } };

/* the details of an employee (from the employee record, with the Employee No.) */
async function showDetails(t) {
  if (!empRecs) empRecs = (await getDocs(query(collection(db, "employees"), where("schoolId", "==", SID)))).docs.map((d) => d.data());
  const e = empRecs.find((x) => x.employeeId === t.employeeId) || {};
  const L = (k, v) => (v ? `${k}: ${v}\n` : "");
  $("dlgBody").style.whiteSpace = "pre-line";
  popup(`${t.displayName}`, L("Employee No.", t.employeeId) + L("Account type", ROLE_LABEL[t.role] || t.role) + L("Position", e.position || t.position) + L("Department", e.department || t.department) + L("Employment", e.employmentType) + L("Date hired", e.dateHired) + L("Birthday", e.birthday || t.birthday) +
    L("Contact", e.contact) + L("Email", e.email || (t.hasRealEmail ? t.email : "")) + L("Address", e.address) + L("SSS", e.sss) + L("PhilHealth", e.philhealth) + L("Pag-IBIG", e.pagibig) + L("TIN", e.tin) + (e.employeeId ? "" : "\n(No HR / employee record found. Add it under Employee registration.)"));
}

/* ---------- employees added by HR who do not have a login yet ---------- */
let cands = [];
async function loadCandidates() {
  cands = (await callFn("hrCandidates")).employees || [];
  renderCandidates();
}
const candName = (c) => `${c.lastName}, ${c.firstName}${c.middleInitial ? " " + c.middleInitial + "." : ""}`;
function renderCandidates() {
  const keepV = $("empSel").value, hrRole = $("roleSel").value === "hr";
  $("empSel").innerHTML = (cands.length ? `<option value="">- Choose an employee -</option>` : `<option value="">${hrRole ? "" : "No employee is waiting. Register one under Employee registration (or ask HR)."}</option>`) +
    (hrRole ? `<option value="__new">New HR person (type the details below)</option>` : "") +
    cands.map((c) => `<option value="${esc(c.key)}">${esc(c.employeeId)} - ${esc(candName(c))}${c.position ? " (" + esc(c.position) + ")" : ""}</option>`).join("");
  if ([...$("empSel").options].some((o) => o.value === keepV)) $("empSel").value = keepV;
  showEmpInfo();
}
function showEmpInfo() {
  const v = $("empSel").value, c = cands.find((x) => x.key === v);
  $("manualWrap").hidden = v !== "__new";
  $("empInfo").hidden = !c;
  if (c) {
    $("empInfo").innerHTML = [["Employee No.", c.employeeId], ["Name", candName(c)], ["Birthday", c.birthday || "-"], ["Position", c.position || "-"], ["Department", c.department || "-"], ["HR says it needs", ROLE_NAME[c.accessType] || "-"]].map(([k, x]) => `<div><span>${k}</span><b>${esc(x)}</b></div>`).join("");
  }
}
$("empSel").addEventListener("change", () => {
  const c = cands.find((x) => x.key === $("empSel").value);
  if (c && ROLE_NAME[c.accessType]) $("roleSel").value = c.accessType;   // HR already said which account this person needs
  showEmpInfo();
});
$("roleSel").addEventListener("change", renderCandidates);
/* the Employee registration page tells this page when an employee was added / changed, or when "Create account" was pressed for someone */
addEventListener("employees-changed", () => { empRecs = null; });
addEventListener("employees-changed", () => loadCandidates().catch(() => {}));
addEventListener("employee-pick", (e) => loadCandidates().then(() => { $("empSel").value = e.detail; $("empSel").dispatchEvent(new Event("change")); }).catch(() => {}));

/* ---------- create the login of an employee HR has added: username = Employee No., password = birth year + first letter of last name ---------- */
$("newT").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const role = ROLE_NAME[f.role] && f.role !== "student" ? f.role : "teacher", pick = $("empSel").value;
  const manual = pick === "__new", c = cands.find((x) => x.key === pick);
  if (!c && !manual) return flash("Choose an employee. If the person is not in the list, ask HR to add them first.");
  const m = manual ? { lastName: $("mLast").value.trim(), firstName: $("mFirst").value.trim(), mi: $("mMi").value.trim().slice(0, 1).toUpperCase(), employeeId: $("mNo").value.trim(), birthday: $("mBirth").value } : null;
  if (manual && (!m.lastName || !m.firstName || !m.employeeId || !m.birthday)) return flash("Enter the last name, first name, Employee No. and birthday of the HR person.");
  const employeeId = manual ? m.employeeId : c.employeeId;
  // Typed email wins, then the email HR has on file, otherwise ONE shared inbox: IT Admin email + Employee No. (adminemail+1001@gmail.com)
  const realEmail = cleanEmail(f.email) || (c && cleanEmail(c.email)) || sharedEmail(profile.email, employeeId);
  if ((f.email || "").trim() && !cleanEmail(f.email)) return flash("That email address is not valid. Fix it or leave it blank.");
  const bday = manual ? m.birthday : c.birthday, last = manual ? m.lastName : c.lastName;
  if (!defaultStudentPassword({ birthday: bday, lastName: last })) return flash("HR has not saved a valid birthday for this employee yet.");
  $("addBtn").disabled = true;
  try {
    // The server checks the rules, makes the login and links it to the HR record. (It also writes the activity-log line, so nothing else is sent.)
    const made = await callFn("createAccount", manual
      ? { role: "hr", displayName: fullName(m.lastName, m.firstName, m.mi), lastName: m.lastName, firstName: m.firstName, middleInitial: m.mi, employeeId, birthday: bday, realEmail, email: realEmail || staffEmail(school.code, employeeId) }
      : { role, employeeKey: c.key, realEmail, email: realEmail || staffEmail(school.code, employeeId) });
    e.target.reset(); $("manualWrap").hidden = true;
    popup(ROLE_NAME[role] + " account created", `Sign-in: school code ${school.code}, Employee No. ${employeeId}${realEmail ? ` (or the email ${realEmail})` : ""}. Temporary password (birth year + first letter of last name). They must choose a new one at first sign-in.` + (realEmail ? ` Forgot-password links go to ${realEmail}.` : " No email was given, so password help goes through you."), made.password);
    await refresh();
  } catch (err) {
    const m = String((err && err.message) || "");
    flash(/unknown account type/i.test(m)
      ? "Server said: \"" + m + "\". " + (/type:\s*\S+/i.test(m)
          ? "The server is the NEW version but received an unexpected account type (see the word after the colon)."
          : "The server has no version stamp, so the site is calling an OLD deployment. Open the Web app URL in config.js in a browser: it must show 'Version: HR-2'. If it does not, the URL points to an old deployment.")
      : friendlyError(err));
  }
  finally { $("addBtn").disabled = false; }
});

/* ---------- reset a password to the temporary one ---------- */
async function resetToDefault(t) {
  const pw = pwOf(t);
  if (!pw) throw new Error("This account has no birthday or last name on file, so the temporary password cannot be made.");
  const who = `Username: ${t.role === "student" ? "Exam ID No. " + t.studentId : "school code " + school.code + " + Employee No. " + t.employeeId}.`;
  await callFn("adminSetTempPassword", { uid: t.uid, useDefault: true });
  popup(`Password reset for ${t.displayName}`, `${who} Temporary password below. They must choose a new password at the next sign-in.`, pw);
}

/* ---------- set a specific password for an account (instead of only the birth-year default) ---------- */
async function setCustomPassword(t) {
  const min = t.role === "student" ? 6 : 10;
  const pw = prompt(`Set a new password for ${t.displayName}.\n\nAt least ${min} characters${t.role === "student" ? "" : ", with a letter and a number"}. They are not told what it is; they must choose a new one at their next sign-in.`);
  if (pw === null) return;
  if (pw.length < min || (t.role !== "student" && (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)))) return flash(`Use at least ${min} characters${t.role === "student" ? "" : " with a letter and a number"}.`);
  await callFn("adminSetTempPassword", { uid: t.uid, password: pw });
  await logAudit(t.role + ".temp_password_set", t.uid, { username: userOf(t) });
  flash(`Password set for ${t.displayName}. They must choose a new one at their next sign-in.`, true);
}

/* ---------- remove an account ---------- */
async function removeAccount(u) {
  const stu = u.role === "student", label = stu ? `student ${u.displayName} (Exam ID No. ${u.studentId})` : `${ROLE_LABEL[u.role] === "faculty / teacher" ? "teacher" : ROLE_LABEL[u.role] || u.role} ${u.displayName} (Employee No. ${u.employeeId})`;
  const extra = u.role !== "teacher" ? "" : "\n\nEverything this teacher owns is deleted too: sections, classroom codes, students (and their logins), examinations, results and modules.";
  if (!ask(`Permanently remove ${label}? Their login is deleted and this cannot be undone.${extra}`)) return;
  await callFn("adminDeleteUser", { uid: u.uid });
  flash(`${u.displayName} was removed.`, true);
}

const onAccClick = async (e) => {
  const bk = e.target.closest("button[data-bulk]");
  if (bk) return run2(() => bulkSet(bk.dataset.uids.split(","), bk.dataset.label, bk.dataset.bulk));
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const t = users.find((x) => x.uid === b.dataset.uid); if (!t) return;
  try {
    if (b.dataset.act === "photo") { pickPhotoFor(t); return; }
    if (b.dataset.act === "photodel") {
      if (!ask(`Remove the photo of ${t.displayName}?`)) return;
      await callFn("adminSetPhoto", { uid: t.uid, photo: "" }); flash(`The photo of ${t.displayName} was removed.`, true); return;
    }
    if (b.dataset.act === "remove") { await removeAccount(t); await refresh(); return; }
    if (b.dataset.act === "details") { await showDetails(t); return; }
    if (b.dataset.act === "setpw") { await setCustomPassword(t); return; }
    if (b.dataset.act === "mail") {
      if (!ask(`Send a password-reset link to ${t.email}? ${t.displayName} can then choose a new password from their own inbox.`)) return;
      await callFn("adminSendReset", { uid: t.uid });
      return flash(`Reset link sent to ${t.email}.`, true);
    }
    if (b.dataset.act === "reset") {
      if (!ask(`Reset the password of ${t.displayName} to birth year + first letter of last name? Their current password will stop working.`)) return;
      await resetToDefault(t);
    } else {
      const next = t.status === "active" ? "suspended" : "active";
      if (!ask(`${next === "suspended" ? "Suspend" : "Reactivate"} ${t.displayName}?`)) return;
      await updateDoc(doc(db, "users", t.uid), { status: next, updatedAt: serverTimestamp() });
      await logAudit(t.role + "." + next, t.uid, { username: userOf(t) });
      flash(`${t.displayName} is now ${next}.`, true);
    }
    await refresh();
  } catch (err) { flash(friendlyError(err)); }
};
$("teachers").addEventListener("click", onAccClick); $("studentGroups").addEventListener("click", onAccClick);

async function loadAudit() {
  const snap = await getDocs(query(collection(db, "auditLogs"), where("schoolId", "==", SID), orderBy("createdAt", "desc"), limit(50)));
  const rows = snap.docs.map((d) => d.data());
  const html = `<tr><th>When</th><th>Action</th><th>Details</th></tr>` +
    (rows.length ? rows.map((r) => `<tr><td>${fmt(r.createdAt)}</td><td>${esc(r.action)}</td>
      <td>${esc(r.details?.username || r.details?.email || r.targetUid || "")}</td></tr>`).join("") : `<tr><td colspan="3">No activity yet.</td></tr>`);
  $("audit").innerHTML = html;
  $("recent").innerHTML = html.split("</tr>").slice(0, 7).join("</tr>") + (rows.length ? "</tr>" : "");
}
async function loadCounts() {
  try {
    const c = (name) => getCountFromServer(query(collection(db, name), where("schoolId", "==", SID)));
    const [e, s] = await Promise.all([c("examinations"), c("scanResults")]);
    $("s-exams").textContent = e.data().count; $("s-scans").textContent = s.data().count;
  } catch (err) { flash("Could not load counts: " + friendlyError(err)); }
}
async function refresh() {
  // all four requests leave in the same moment, so they travel to the server as ONE trip (they used to wait for each other one by one)
  try { await Promise.all([loadTeachers(), loadCandidates(), loadAudit(), loadCounts()]); }
  catch (err) { flash("Could not load data: " + friendlyError(err)); }
}
refresh();

/* ---------- branding: school name + logo, set by the IT Admin, shown across the school's pages ---------- */
const LOGO_MAX = 5 * 1024 * 1024;
/** The logo is kept in one spreadsheet cell (50,000 characters), so it is shrunk in the browser to a small picture. */
async function shrinkLogo(file) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file is not a picture.")); i.src = URL.createObjectURL(file); });
  for (const side of [160, 128, 96, 72, 56]) {
    const k = Math.min(1, side / Math.max(img.width, img.height)), c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    for (const [type, q] of [["image/png"], ["image/webp", 0.85], ["image/jpeg", 0.8]]) {
      const url = c.toDataURL(type, q);
      if (url.startsWith("data:" + type) && url.length < 30000) { URL.revokeObjectURL(img.src); return url; }
    }
  }
  URL.revokeObjectURL(img.src); throw new Error("That picture is too detailed to shrink. Try a simpler logo.");
}
function loadBranding() {
  $("brandName").value = school.displayName || "";
  $("brandPrev").innerHTML = school.logo ? `<img src="${school.logo}" alt="" style="max-width:100%;max-height:100%">` : "No logo";
}
loadBranding();
$("brandLogo").addEventListener("change", async () => {
  const f = $("brandLogo").files[0]; if (!f) return;
  if (f.size > LOGO_MAX) { flash("That image is larger than 5 MB. Choose a smaller file."); $("brandLogo").value = ""; return; }
  let url; try { url = await shrinkLogo(f); } catch (err) { flash(err.message); $("brandLogo").value = ""; return; }
  $("brandPrev").innerHTML = `<img src="${url}" alt="" style="max-width:100%;max-height:100%">`;
  $("brandPrev").dataset.pending = url;
});
$("brandF").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("brandSave").disabled = true;
  try {
    const patch = { displayName: $("brandName").value.trim(), updatedAt: serverTimestamp() };
    if ($("brandPrev").dataset.pending) patch.logo = $("brandPrev").dataset.pending;
    await updateDoc(doc(db, "schools", SID), patch);
    school.displayName = patch.displayName; if (patch.logo) school.logo = patch.logo;
    delete $("brandPrev").dataset.pending;
    applyBranding(school);
    flash("Branding saved.", true);
  } catch (err) { flash(friendlyError(err)); }
  finally { $("brandSave").disabled = false; }
});
$("brandClear").addEventListener("click", async () => {
  if (!ask("Remove the logo and go back to the default ARK mark?")) return;
  try {
    await updateDoc(doc(db, "schools", SID), { logo: "", updatedAt: serverTimestamp() });
    location.reload();
  } catch (err) { flash(friendlyError(err)); }
});

/* ---------- my own photo: the IT Admin can change or remove it (HR can still edit it too) ---------- */
function showMyPhoto(url) {
  const im = $("sidePhoto"), av = $("sideAvatar");
  if (url) { im.src = url; im.alt = profile.displayName || ""; im.hidden = false; av.hidden = true; } else { im.removeAttribute("src"); im.hidden = true; av.hidden = false; }
  $("myPhotoDel").hidden = !url; profile.photo = url || "";
}
showMyPhoto(profile.photo || "");
async function saveMyPhoto(url) {
  await callFn("adminSetPhoto", { photo: url });
  forgetMe();                       // the cached profile is refreshed at the next page load
  showMyPhoto(url);
  flash(url ? "Your photo was updated." : "Your photo was removed.", true);
}
$("myPhotoFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try { const d = await squarePhoto(f); if (d) await saveMyPhoto(d); } catch (err) { flash(friendlyError(err)); }
});
$("myPhotoDel").addEventListener("click", async () => {
  if (!ask("Remove your photo?")) return;
  try { await saveMyPhoto(""); } catch (err) { flash(friendlyError(err)); }
});

/* ---------- replace the photo of any employee account (the person sees it at their next page load; HR sees it too) ---------- */
function pickPhotoFor(t) {
  const inp = Object.assign(document.createElement("input"), { type: "file", accept: "image/*" });
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try { const d = await squarePhoto(f); if (!d) return; await callFn("adminSetPhoto", { uid: t.uid, photo: d }); flash(`The photo of ${t.displayName} was replaced.`, true); }
    catch (err) { flash(friendlyError(err)); }
  };
  inp.click();
}

/* live updates */
liveRefresh(["users", "employees", "students", "auditLogs"], refresh);
