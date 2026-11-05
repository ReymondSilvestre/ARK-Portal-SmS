/* HR: keeps the information of ALL employees of the school (also people who will never have a portal login).
   Flow:  HR adds the employee here  ->  the IT Admin creates the login from this list  ->  the account shows here as "Has an account".
   Records are stored per school in `employees` and are copied (in plain words) into the HR readable Google Sheet by the server. */
import { requireRole, logout, db, esc, friendlyError, ageOf, applyBranding, staffKey, defaultStudentPassword } from "./auth.js";
import { collection, query, where, orderBy, limit, getDocs, getDoc, doc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, deleteField, callFn, Timestamp } from "./db.js";
import { DEFAULT_LEAVE_TYPES, workingDays, dateText as lvDate, STATUS_CLASS, rangeText, roleName, showPopup, errText } from "./leave.js";   // also puts the "Leave request" button (HR files its own leave too) in the top bar

const $ = (id) => document.getElementById(id);
const { user, profile, school } = await requireRole(["hr"]);
const SID = profile.schoolId;
$("who").textContent = `${profile.displayName} (HR)`; $("out").onclick = logout;
applyBranding(school);

/* ---------- small helpers ---------- */
const flash = (t, ok) => { const m = $("msg"); m.textContent = t; m.className = "notice noprint " + (ok ? "ok" : "err"); m.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => (m.hidden = true), 9000); scrollTo({ top: 0, behavior: "smooth" }); };
const net = () => { $("sync").className = "sync" + (navigator.onLine ? "" : " off"); $("sync").lastElementChild.textContent = navigator.onLine ? "Online" : "Offline - changes will not save"; };
addEventListener("online", net); addEventListener("offline", net); net();
const run = async (fn) => { try { await fn(); } catch (e) { console.error(e); flash(friendlyError(e)); } };
const dateText = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") ? new Date(s + "T00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : s || "-");
const hdr = (cols) => "<tr>" + cols.map((c) => `<th>${c}</th>`).join("") + "</tr>";
const rowHtml = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
const emptyRow = (n, t) => `<tr><td colspan="${n}">${t}</td></tr>`;
const options = (list, first) => (first !== undefined ? `<option value="">${esc(first)}</option>` : "") + list.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
const keep = (id, html) => { const el = $(id); if (!el) return; const v = el.value; el.innerHTML = html; if ([...el.options].some((o) => o.value === v)) el.value = v; };
const slugName = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "employees";
const nameOf = (e) => `${e.lastName}, ${e.firstName}${e.middleInitial ? " " + e.middleInitial + "." : ""}`;
const pc = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + "%" : "-");
const bar = (a, b) => `<span class="bar"><i style="width:${b ? Math.min(100, Math.round((a / b) * 100)) : 0}%"></i></span>`;

/* ---------- what is kept about an employee ---------- */
const STATUSES = ["Active", "On leave", "Resigned", "Retired", "Terminated"];
const TYPES = ["Regular", "Probationary", "Contractual", "Part-time", "Substitute"];
const ACCESS = [["", "No portal account needed"], ["teacher", "Faculty / Teacher"], ["registrar", "Registrar"], ["finance", "Finance"], ["custodian", "Custodian"], ["guidance", "Guidance"], ["hr", "HR"], ["staff", "Other staff (principal, librarian, nurse, guard, driver ...)"]];
const ACCESS_NAME = Object.fromEntries(ACCESS.filter(([k]) => k).map(([k, v]) => [k, v]));
const DEFAULT_LISTS = {
  positions: ["Teacher", "Head Teacher", "Principal", "Registrar", "Cashier / Finance Officer", "Guidance Counselor", "Custodian", "School Nurse", "HR Officer", "IT Administrator", "Librarian", "Security Guard", "Janitor / Utility", "Driver", "Other"],
  departments: ["Elementary", "Junior High School", "Senior High School", "Administration", "Finance", "Registrar's Office", "Guidance", "Clinic", "Maintenance", "Security", "IT"],
};
const FIELDS = [
  { id: "employeeId", label: "Employee No.", req: true, group: "Basic" },
  { id: "lastName", label: "Last name", req: true, group: "Basic" },
  { id: "firstName", label: "First name", req: true, group: "Basic" },
  { id: "middleInitial", label: "M.I.", narrow: true, max: 1, group: "Basic" },
  { id: "birthday", label: "Birthday", type: "date", req: true, group: "Basic" },
  { id: "gender", label: "Gender", type: "select", options: ["Male", "Female"], group: "Basic" },
  { id: "civilStatus", label: "Civil status", type: "select", options: ["Single", "Married", "Widowed", "Separated"], group: "Basic" },
  { id: "position", label: "Position", type: "list", list: "positions", group: "Job" },
  { id: "department", label: "Department", type: "list", list: "departments", group: "Job" },
  { id: "employmentType", label: "Employment type", type: "select", options: TYPES, group: "Job" },
  { id: "dateHired", label: "Date hired", type: "date", group: "Job" },
  { id: "status", label: "Status", type: "select", options: STATUSES, req: true, def: "Active", group: "Job" },
  { id: "accessType", label: "Portal account", type: "access", group: "Job", hint: "Only says what is needed. The IT Admin creates the account." },
  { id: "contact", label: "Contact No.", group: "Contact" },
  { id: "email", label: "Email", type: "email", group: "Contact", hint: "Optional. Used for password-reset links." },
  { id: "address", label: "Address", type: "textarea", group: "Contact" },
  { id: "emergencyName", label: "Emergency contact person", group: "Contact" },
  { id: "emergencyContact", label: "Emergency contact No.", group: "Contact" },
  { id: "sss", label: "SSS No.", group: "Government IDs" },
  { id: "philhealth", label: "PhilHealth No.", group: "Government IDs" },
  { id: "pagibig", label: "Pag-IBIG No.", group: "Government IDs" },
  { id: "tin", label: "TIN", group: "Government IDs" },
  { id: "prc", label: "PRC license No.", group: "Government IDs" },
];
const GROUPS = ["Basic", "Job", "Contact", "Government IDs"];
/* the account type every position needs: the special pages for the offices below, "Other staff" for everybody else */
const POSITION_ACCESS = { "Teacher": "teacher", "Head Teacher": "teacher", "Registrar": "registrar", "Cashier / Finance Officer": "finance", "Guidance Counselor": "guidance", "Custodian": "custodian", "HR Officer": "hr" };
const accessFor = (pos) => (pos ? POSITION_ACCESS[pos] || "staff" : "");

/* ---------- state ---------- */
const S = { photo: "", leave: [], leaveTypes: DEFAULT_LEAVE_TYPES.map((t) => ({ ...t })), emps: [], lists: { positions: [...DEFAULT_LISTS.positions], departments: [...DEFAULT_LISTS.departments] }, log: [], logLoaded: false };
let editing = null;                      // the employee being edited (null = adding)
const tsec = (x) => x?.createdAt?.seconds || 0;

async function refresh() {
  await run(async () => {
    // both requests leave together, so this is ONE trip to the server
    const [snap, set, lv] = await Promise.all([getDocs(query(collection(db, "employees"), where("schoolId", "==", SID))), getDoc(doc(db, "hrSettings", SID)).catch(() => null), getDocs(query(collection(db, "leaveRequests"), where("schoolId", "==", SID))).catch(() => null)]);
    S.emps = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    if (lv) S.leave = lv.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (set && set.exists()) { const l = set.data().lists || {}; ["positions", "departments"].forEach((k) => { if (Array.isArray(l[k]) && l[k].length) S.lists[k] = l[k]; }); const lt = set.data().leaveTypes; if (Array.isArray(lt) && lt.length) S.leaveTypes = lt; }
    renderAll();
  });
}
const hasAccount = (e) => !!e.accountUid;
const waiting = (e) => !hasAccount(e) && e.accessType && (e.status || "Active") === "Active";
const acctBadge = (e) => hasAccount(e) ? `<span class="badge st-enrolled">Has an account</span><small>${esc(ACCESS_NAME[e.accountRole] || e.accountRole || "")}</small>` : waiting(e) ? `<span class="badge st-pending">Waiting for IT Admin</span><small>${esc(ACCESS_NAME[e.accessType] || "")}</small>` : `<span class="badge st-not">No account</span>`;
const statusBadge = (st, e) => `<span class="badge ${st === "Active" ? "st-enrolled" : st === "On leave" ? "st-pending" : "st-out"}">${esc(st || "Active")}</span>${e && onLeaveToday(e) ? ` <span class="badge st-going">On leave today</span>` : ""}`;

/* ---------- navigation ---------- */
function show(t) {
  document.querySelectorAll("[data-s]").forEach((s) => (s.hidden = s.dataset.s !== t));
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
  if (t === "history" && !S.logLoaded) run(loadHistory);
  if (t === "leave") run(loadLeave);
  if (t === "admin") run(loadAdmins);
}
$("tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.t); };
const sec = (t) => document.querySelector(`[data-s="${t}"]`);

/* ---------- dashboard ---------- */
function renderDash() {
  const E = S.emps, act = E.filter((e) => (e.status || "Active") === "Active"), withAcct = E.filter(hasAccount), wait = E.filter(waiting);
  const countBy = (key, list) => hdr([key === "department" ? "Department" : "Employment type", "Employees", "Active", "With a portal account"]) +
    (list.map((v) => { const a = E.filter((e) => (e[key] || "") === v); return a.length ? rowHtml([esc(v), a.length, a.filter((e) => (e.status || "Active") === "Active").length, `${a.filter(hasAccount).length} ${bar(a.filter(hasAccount).length, a.length)}`]) : ""; }).join("") ||
      emptyRow(4, "No employees yet."));
  const noDept = E.filter((e) => !e.department).length;
  const cards = [["All employees", E.length], ["Active", act.length, "good"], ["With a portal account", withAcct.length, "good"], ["Waiting for the IT Admin", wait.length, "warn"], ["Not active (leave, resigned ...)", E.length - act.length, "blue"], ["Leave requests waiting", pendingCount(), pendingCount() ? "warn" : ""], ["On leave today", E.filter(onLeaveToday).length, "blue"]];
  sec("dash").innerHTML = `<div class="cards">${cards.map(([l, n, c]) => `<div class="stat${c ? " " + c : ""}"><b>${n}</b><span>${l}</span></div>`).join("")}</div>
  <div class="panel"><h2>Waiting for the IT Admin</h2><p class="muted">Employees who need a portal account but do not have one yet. The IT Admin picks them from this list when creating accounts.</p>
    <div class="tablewrap"><table>${hdr(["Employee No.", "Name", "Position", "Account needed"]) + (wait.map((e) => rowHtml([esc(e.employeeId), esc(nameOf(e)), esc(e.position || "-"), esc(ACCESS_NAME[e.accessType] || "")])).join("") || emptyRow(4, "Nobody is waiting."))}</table></div></div>
  <div class="panel"><h2>Per department</h2><div class="tablewrap"><table>${countBy("department", [...new Set([...S.lists.departments, ...E.map((e) => e.department).filter(Boolean)])])}${noDept ? rowHtml(["(no department)", noDept, "", ""]) : ""}</table></div></div>
  <div class="panel"><h2>Per employment type</h2><div class="tablewrap"><table>${countBy("employmentType", TYPES)}</table></div></div>`;
}

/* ---------- add / edit form ---------- */
function control(f, idp = "f_") {
  const a = `id="${idp}${f.id}" data-f="${f.id}"${f.req ? " required" : ""}`;
  if (f.type === "textarea") return `<textarea ${a} class="tall" maxlength="500"></textarea>`;
  if (f.type === "select") return `<select ${a}>${f.req && f.def ? "" : '<option value="">-</option>'}${f.options.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
  if (f.type === "list") return `<select ${a}><option value="">-</option>${S.lists[f.list].map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
  if (f.type === "access") return `<select ${a}>${ACCESS.map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>`;
  return `<input ${a} type="${f.type || "text"}" autocomplete="off"${f.max ? ` maxlength="${f.max}"` : ""}>`;
}
function renderForm() {
  sec("add").innerHTML = `<div class="panel"><h2 id="formTitle">Add an employee</h2>
  <p class="muted" id="formNote">Record every employee here, also those who will never sign in to the portal. If someone needs a portal account, choose it under <b>Portal account</b>: the IT Admin then creates it from this list.</p>
  <form id="empForm" novalidate><h3>Photo</h3><div class="photo-box"><img id="photoPv" class="pv" alt="2x2 photo preview" hidden><div><label>2x2 picture of the employee <small>(JPG or PNG; it is cropped to a square)</small><input type="file" id="photoFile" accept="image/*"></label><button class="btn small" type="button" id="photoDel" hidden>Remove photo</button><p class="muted" id="photoNote"></p></div></div>${GROUPS.map((g) => `<h3>${g}</h3><div class="row">${FIELDS.filter((f) => f.group === g).map((f) => `<label${f.narrow ? ' class="narrow"' : ""}>${f.label}${f.hint ? ` <small>${esc(f.hint)}</small>` : ""}${control(f)}</label>`).join("")}</div>`).join("")}
  <div class="savebar noprint"><button class="btn primary" id="saveBtn">Save employee</button><button class="btn" id="cancelBtn" type="button" hidden>Cancel editing</button></div></form></div>`;
  $("f_status").value = "Active";
  setPhoto(editing && editing.photo || "");
  $("photoFile").onchange = (ev) => run(async () => { const f = ev.target.files[0]; if (!f) return; const d = await squarePhoto(f); if (!d) { ev.target.value = ""; return; } setPhoto(d); $("photoNote").textContent = "New photo ready. Press Save to keep it."; });
  $("photoDel").onclick = () => { setPhoto(""); $("photoFile").value = ""; $("photoNote").textContent = "The photo will be removed when you save."; };
  $("f_position").addEventListener("change", () => { const a = accessFor($("f_position").value), el = $("f_accessType"); if (a && (!el.value || el.dataset.auto === el.value)) { el.value = a; el.dataset.auto = a; } });
  $("empForm").addEventListener("submit", (e) => { e.preventDefault(); run(saveEmployee); });
  $("cancelBtn").onclick = () => { editing = null; renderForm(); show("list"); };
  if (editing) fillForm(editing);
}
function fillForm(e) {
  editing = e;
  FIELDS.forEach((f) => { const el = $("f_" + f.id); if (!el) return; const v = e[f.id] ?? ""; if (el.tagName === "SELECT" && v && ![...el.options].some((o) => o.value === v)) el.insertAdjacentHTML("beforeend", `<option>${esc(v)}</option>`); el.value = v || (f.def || ""); });
  $("f_employeeId").readOnly = true; $("f_employeeId").title = "The Employee No. is the sign-in name, so it cannot be changed.";
  $("formTitle").textContent = "Edit employee: " + nameOf(e); $("saveBtn").textContent = "Save changes"; $("cancelBtn").hidden = false;
  $("formNote").textContent = hasAccount(e) ? `This employee already has a portal account (${ACCESS_NAME[e.accountRole] || e.accountRole}). The IT Admin manages the account; you keep the personal and job information.` : "Change what you need and save.";
}
const setPhoto = (d) => { S.photo = d || ""; const pv = $("photoPv"); if (!pv) return; pv.src = S.photo; pv.hidden = !S.photo; $("photoDel").hidden = !S.photo; };
/** Opens the picture in a small window: drag it to center the face, zoom with the slider (or the mouse wheel), then press Use photo.
 *  The chosen square is shrunk to 240 x 240 (JPEG, under 19,000 characters) so it fits in one spreadsheet cell. Resolves null when cancelled. */
function squarePhoto(file) {
  return new Promise((ok, no) => {
    if (!/^image\//.test(file.type)) return no(new Error("Choose a picture file (JPG or PNG)."));
    const url = URL.createObjectURL(file), im = new Image();
    im.onerror = () => { URL.revokeObjectURL(url); no(new Error("That picture could not be read.")); };
    im.onload = () => {
      const V = 260, base = V / Math.min(im.width, im.height);   // the picture just covers the square at zoom 1
      let zoom = 1, x = 0, y = 0;                                  // x, y: where the picture's top-left corner sits in the square
      const sc = () => base * zoom;
      const clamp = () => { x = Math.min(0, Math.max(V - im.width * sc(), x)); y = Math.min(0, Math.max(V - im.height * sc(), y)); };
      const el = document.createElement("div"); el.className = "lv-pop"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
      el.innerHTML = `<div class="lv-pop-box"><h3>Position the photo</h3><p class="muted">Drag the picture to center the face inside the circle. Use the slider to zoom.</p>
        <div class="crop-view" id="cpView"><img id="cpImg" alt="" draggable="false"><div class="crop-ring"></div></div>
        <label>Zoom<input type="range" id="cpZoom" min="1" max="4" step="0.01" value="1"></label>
        <div class="lv-pop-btns"><button type="button" class="btn" id="cpCancel">Cancel</button><button type="button" class="btn" id="cpReset">Center</button><button type="button" class="btn primary" id="cpOk">Use photo</button></div></div>`;
      document.body.append(el);
      const img = el.querySelector("#cpImg"), view = el.querySelector("#cpView"), zr = el.querySelector("#cpZoom"); img.src = url;
      const draw = () => { clamp(); img.style.width = im.width * sc() + "px"; img.style.height = im.height * sc() + "px"; img.style.transform = `translate(${x}px,${y}px)`; };
      const center = () => { zoom = 1; zr.value = 1; x = (V - im.width * sc()) / 2; y = (V - im.height * sc()) / 2; draw(); };
      const setZoom = (z) => { const o = sc(), cx = (V / 2 - x) / o, cy = (V / 2 - y) / o; zoom = Math.min(4, Math.max(1, z)); zr.value = zoom; x = V / 2 - cx * sc(); y = V / 2 - cy * sc(); draw(); };
      let drag = null;
      view.addEventListener("pointerdown", (e) => { drag = { px: e.clientX, py: e.clientY, x, y }; view.setPointerCapture(e.pointerId); view.classList.add("grab"); });
      view.addEventListener("pointermove", (e) => { if (!drag) return; x = drag.x + e.clientX - drag.px; y = drag.y + e.clientY - drag.py; draw(); });
      const end = () => { drag = null; view.classList.remove("grab"); };
      view.addEventListener("pointerup", end); view.addEventListener("pointercancel", end);
      view.addEventListener("wheel", (e) => { e.preventDefault(); setZoom(zoom + (e.deltaY < 0 ? 0.1 : -0.1)); }, { passive: false });
      zr.oninput = () => setZoom(+zr.value);
      const close = (v) => { removeEventListener("keydown", key); el.remove(); URL.revokeObjectURL(url); ok(v); };
      const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(null); } };
      addEventListener("keydown", key);
      el.querySelector("#cpCancel").onclick = () => close(null);
      el.querySelector("#cpReset").onclick = center;
      el.querySelector("#cpOk").onclick = () => {
        const s0 = V / sc(), sx = -x / sc(), sy = -y / sc(), c = document.createElement("canvas"); let size = 240, q = 0.85, out = "";
        for (let i = 0; i < 12; i++) { c.width = c.height = size; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, size, size); g.drawImage(im, sx, sy, s0, s0, 0, 0, size, size); out = c.toDataURL("image/jpeg", q); if (out.length <= 18000) break; q > 0.5 ? (q -= 0.1) : (size = Math.round(size * 0.85)); }
        if (out.length > 19000) { el.remove(); URL.revokeObjectURL(url); return no(new Error("The picture is too detailed. Try another one.")); }
        close(out);
      };
      center(); el.querySelector("#cpOk").focus();
    };
    im.src = url;
  });
}
const readForm = () => Object.fromEntries(FIELDS.map((f) => { const el = $("f_" + f.id); let v = el ? String(el.value || "").trim() : ""; if (f.id === "middleInitial") v = v.slice(0, 1).toUpperCase(); return [f.id, v]; }));

async function saveEmployee() {
  const v = readForm();
  if (!v.employeeId || !v.lastName || !v.firstName) return flash("Enter the Employee No., last name and first name.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.birthday)) return flash("Enter the birthday (it is used for the first password).");
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) return flash("That email address is not valid. Fix it or leave it blank.");
  v.photo = S.photo || "";
  const key = staffKey(SID, v.employeeId);
  if (!editing && S.emps.some((e) => e.id === key)) return flash(`Employee No. ${v.employeeId} is already in the list.`);
  $("saveBtn").disabled = true;
  try {
    const b = writeBatch(), logRef = doc(collection(db, "hrLog")), ref = doc(db, "employees", key);
    const log = { schoolId: SID, byUid: user.uid, byName: profile.displayName, action: editing ? "Edited" : "Added", targetName: nameOf(v), targetNo: v.employeeId, createdAt: serverTimestamp() };
    let saved;
    if (editing) { const patch = { ...v, updatedAt: serverTimestamp() }; delete patch.employeeId; b.update(ref, patch); saved = { ...editing, ...v, updatedAt: Timestamp.now() }; }
    else { const d = { ...v, schoolId: SID, createdBy: user.uid, createdAt: serverTimestamp() }; b.set(ref, d); saved = { id: key, ...v, schoolId: SID, createdBy: user.uid, createdAt: Timestamp.now() }; }
    b.set(logRef, log);
    await b.commit();                                   // ONE request saves the employee and the history line
    const i = S.emps.findIndex((e) => e.id === key); if (i >= 0) S.emps[i] = saved; else S.emps.push(saved);   // no need to download the whole list again
    S.emps.sort((a, c) => nameOf(a).localeCompare(nameOf(c))); S.logLoaded = false;
    const was = editing; editing = null; renderAll(); show("list");
    flash(was ? `${nameOf(v)} was updated.` : `${nameOf(v)} was added.${v.accessType ? " The IT Admin can now create the account." : ""}`, true);
  } finally { $("saveBtn") && ($("saveBtn").disabled = false); }
}

/* ---------- employee list ---------- */
function renderListShell() {
  sec("list").innerHTML = `<div class="panel"><div class="toolbar noprint">
    <label class="grow">Search<input id="lq" placeholder="Employee No. or name" autocomplete="off"></label>
    <label>Department<select id="lDept"></select></label><label>Position<select id="lPos"></select></label>
    <label>Status<select id="lStat">${options(STATUSES, "All")}</select></label>
    <label>Portal account<select id="lAcct"><option value="">All</option><option value="yes">Has an account</option><option value="wait">Waiting for IT Admin</option><option value="no">No account</option></select></label>
    <button class="btn" id="lXls" type="button">Download Excel</button></div>
    <p class="muted" id="lCount"></p><div class="tablewrap"><table id="lTable"></table></div></div>`;
  ["lq", "lDept", "lPos", "lStat", "lAcct"].forEach((id) => $(id).addEventListener(id === "lq" ? "input" : "change", renderList));
  $("lXls").onclick = downloadExcel;
  $("lTable").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const emp = S.emps.find((x) => x.id === b.dataset.id); if (!emp) return;
    if (b.dataset.act === "edit") { editing = emp; renderForm(); show("add"); scrollTo({ top: 0 }); }
    else if (b.dataset.act === "view") $("lTable").querySelector(`tr[data-more="${CSS.escape(emp.id)}"]`)?.toggleAttribute("hidden");
    else run(() => removeEmployee(emp));
  });
}
const filtered = () => {
  const q = ($("lq")?.value || "").trim().toLowerCase(), d = $("lDept")?.value || "", p = $("lPos")?.value || "", st = $("lStat")?.value || "", ac = $("lAcct")?.value || "";
  return S.emps.filter((e) => (!q || [e.employeeId, nameOf(e), e.position, e.department].join(" ").toLowerCase().includes(q)) && (!d || e.department === d) && (!p || e.position === p) && (!st || (e.status || "Active") === st) &&
    (!ac || (ac === "yes" ? hasAccount(e) : ac === "wait" ? waiting(e) : !hasAccount(e) && !waiting(e))));
};
function renderList() {
  keep("lDept", options([...new Set([...S.lists.departments, ...S.emps.map((e) => e.department).filter(Boolean)])], "All"));
  keep("lPos", options([...new Set([...S.lists.positions, ...S.emps.map((e) => e.position).filter(Boolean)])], "All"));
  const rows = filtered();
  $("lCount").textContent = `${rows.length} of ${S.emps.length} employees`;
  $("lTable").innerHTML = hdr(["Employee No.", "Name", "Position", "Department", "Status", "Portal account", ""]) + (rows.map((e) => `<tr><td>${esc(e.employeeId)}</td><td>${e.photo ? `<img class="emp-photo" alt="" src="${esc(e.photo)}">` : ""}${esc(nameOf(e))}</td><td>${esc(e.position || "-")}</td><td>${esc(e.department || "-")}</td><td>${statusBadge(e.status, e)}</td><td>${acctBadge(e)}</td>
    <td class="actions"><button class="btn small" data-act="view" data-id="${esc(e.id)}">Details</button><button class="btn small" data-act="edit" data-id="${esc(e.id)}">Edit</button>
    <button class="btn small danger" data-act="del" data-id="${esc(e.id)}"${e.accountUid === user.uid ? ' disabled title="You cannot delete your own record."' : ""}>Delete</button></td></tr>
    <tr data-more="${esc(e.id)}" hidden><td colspan="7">${detailHtml(e)}</td></tr>`).join("") || emptyRow(7, "No employees found."));
}
function detailHtml(e) {
  const items = [["Photo", e.photo ? `<img class="emp-photo" style="width:80px;height:80px" alt="" src="${esc(e.photo)}">` : "-", true], ["Birthday", `${dateText(e.birthday)}${ageOf(e.birthday) !== "" ? " (age " + ageOf(e.birthday) + ")" : ""}`], ["Gender", e.gender], ["Civil status", e.civilStatus], ["Employment type", e.employmentType], ["Date hired", dateText(e.dateHired)], ["Contact No.", e.contact], ["Email", e.email], ["Address", e.address],
    ["Emergency contact", [e.emergencyName, e.emergencyContact].filter(Boolean).join(" - ")], ["SSS No.", e.sss], ["PhilHealth No.", e.philhealth], ["Pag-IBIG No.", e.pagibig], ["TIN", e.tin], ["PRC license No.", e.prc]];
  return `<div class="infogrid">${items.map(([k, v, raw]) => `<div><span>${k}</span><b>${raw ? v : esc(v || "-")}</b></div>`).join("")}</div>`;
}
async function removeEmployee(e) {
  if (e.accountUid === user.uid) return flash("You cannot delete your own record. Ask another HR account.");
  const acct = hasAccount(e);
  const a = await showPopup({ title: `Delete ${nameOf(e)}?`, ok: false, html: `<p>Employee No. ${esc(e.employeeId)} will be removed from the HR records, with the leave requests of this person.</p>` +
    (acct ? `<p class="lv-pop-err">This employee has a portal account (${esc(ACCESS_NAME[e.accountRole] || e.accountRole || "")}). The account is DELETED too.${e.accountRole === "teacher" ? " For a teacher this also deletes their students, sections and exams." : ""}</p>` : "") + "<p>This cannot be undone.</p>",
    buttons: [{ label: "Keep", value: "no" }, { label: acct ? "Delete employee and account" : "Delete employee", value: "yes", primary: true, danger: true }] });
  if (a.value !== "yes") return;
  await callFn("hrDeleteEmployee", { key: e.id });
  S.emps = S.emps.filter((x) => x.id !== e.id); S.leave = S.leave.filter((r) => !((e.accountUid && r.requesterUid === e.accountUid) || (r.employeeId && r.employeeId === e.employeeId))); S.logLoaded = false;
  renderAll(); showPopup({ title: "Employee deleted", html: `<p>${esc(nameOf(e))}${acct ? " and the portal account were" : " was"} removed.</p>`, ok: true });
}
function downloadExcel() {
  if (!window.XLSX) return flash("The Excel writer did not load. Check your internet connection.");
  const rows = filtered().map((e) => ({ "Employee No.": e.employeeId, "Last name": e.lastName, "First name": e.firstName, "Middle initial": e.middleInitial || "", Birthday: dateText(e.birthday), Gender: e.gender || "", "Civil status": e.civilStatus || "", Position: e.position || "", Department: e.department || "",
    "Employment type": e.employmentType || "", "Date hired": dateText(e.dateHired), Status: e.status || "Active", "Contact No.": e.contact || "", Email: e.email || "", Address: e.address || "", "Emergency contact": e.emergencyName || "", "Emergency contact No.": e.emergencyContact || "",
    "SSS No.": e.sss || "", "PhilHealth No.": e.philhealth || "", "Pag-IBIG No.": e.pagibig || "", TIN: e.tin || "", "PRC license No.": e.prc || "", "Portal account": hasAccount(e) ? "Has an account" : waiting(e) ? "Waiting for IT Admin" : "No account" }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Employees");
  XLSX.writeFile(wb, `${slugName(school.displayName || school.name || "school")}-employees.xlsx`);
}

/* ---------- history ---------- */
async function loadHistory() {
  const snap = await getDocs(query(collection(db, "hrLog"), where("schoolId", "==", SID), orderBy("createdAt", "desc"), limit(100)));
  S.log = snap.docs.map((d) => d.data()); S.logLoaded = true; renderHistory();
}
function renderHistory() {
  sec("history").innerHTML = `<div class="panel"><div class="tablewrap"><table>${hdr(["When", "By", "Action", "Employee"]) +
    (S.log.map((l) => rowHtml([l.createdAt?.toDate ? l.createdAt.toDate().toLocaleString() : "-", esc(l.byName || ""), esc(l.action || ""), esc(`${l.targetName || ""}${l.targetNo ? " (" + l.targetNo + ")" : ""}`)])).join("") || emptyRow(4, "Nothing recorded yet."))}</table></div></div>`;
}

/* ---------- the IT Admin: HR keeps the IT Admin's information too (name, position, department, contact, 2x2 photo) ---------- */
const A = { list: [], photo: "", loaded: false };
async function loadAdmins() {
  const r = await callFn("hrAdminGet"); A.list = r.admins || []; A.loaded = true; renderAdmins();
}
function renderAdmins() {
  const posList = [...new Set([...S.lists.positions, ...A.list.map((a) => a.position).filter(Boolean)])], depList = [...new Set([...S.lists.departments, ...A.list.map((a) => a.department).filter(Boolean)])];
  sec("admin").innerHTML = `<div class="panel"><h2>IT Admin</h2><p class="muted">The IT Admin is an employee too. Keep the name, position, department, contact number and 2x2 photo here. They show in the IT Admin's side panel.
    The sign-in email and the password stay with the Super Admin and the IT Admin.</p></div>` +
    (A.list.map((a, i) => `<div class="panel"><form data-adm="${i}" novalidate><h3 style="margin-top:0;color:var(--ink)">${esc(a.displayName || "IT Admin")}</h3>
      <div class="photo-box"><img class="pv" alt="2x2 photo preview" data-pv${a.photo ? ` src="${esc(a.photo)}"` : " hidden"}><div><label>2x2 picture <small>(JPG or PNG; it is cropped to a square)</small><input type="file" accept="image/*" data-file></label>
        <button class="btn small" type="button" data-photodel${a.photo ? "" : " hidden"}>Remove photo</button><p class="muted" data-note></p></div></div>
      <div class="row"><label>Full name<input data-k="displayName" maxlength="100" value="${esc(a.displayName)}" autocomplete="off"></label>
        <label>Position <small>Example: IT Administrator</small><input data-k="position" maxlength="80" list="admPos" value="${esc(a.position)}" autocomplete="off"></label>
        <label>Department<input data-k="department" maxlength="80" list="admDep" value="${esc(a.department)}" autocomplete="off"></label>
        <label>Contact No.<input data-k="contact" maxlength="40" value="${esc(a.contact)}" autocomplete="off"></label>
        <label>Sign-in email <small>Cannot be changed here</small><input value="${esc(a.email)}" readonly></label></div>
      <div class="savebar noprint"><button class="btn primary" type="submit">Save IT Admin information</button></div></form></div>`).join("") ||
      `<div class="panel"><p>No IT Admin account was found for this school.</p></div>`) +
    `<datalist id="admPos">${posList.map((x) => `<option value="${esc(x)}">`).join("")}</datalist><datalist id="admDep">${depList.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`;
}
sec("admin").addEventListener("change", (e) => {
  const f = e.target.closest("[data-file]"); if (!f) return;
  const form = f.closest("form"), a = A.list[+form.dataset.adm], file = f.files[0]; if (!file) return;
  run(async () => { const d = await squarePhoto(file); if (!d) { f.value = ""; return; } a.photo = d; const pv = form.querySelector("[data-pv]"); pv.src = a.photo; pv.hidden = false; form.querySelector("[data-photodel]").hidden = false; form.querySelector("[data-note]").textContent = "New photo ready. Press Save to keep it."; });
});
sec("admin").addEventListener("click", (e) => {
  const d = e.target.closest("[data-photodel]"); if (!d) return;
  const form = d.closest("form"), a = A.list[+form.dataset.adm]; a.photo = "";
  const pv = form.querySelector("[data-pv]"); pv.removeAttribute("src"); pv.hidden = true; d.hidden = true; form.querySelector("[data-file]").value = ""; form.querySelector("[data-note]").textContent = "The photo will be removed when you save.";
});
sec("admin").addEventListener("submit", (e) => {
  const form = e.target.closest("form[data-adm]"); if (!form) return; e.preventDefault();
  const a = A.list[+form.dataset.adm], v = Object.fromEntries([...form.querySelectorAll("[data-k]")].map((el) => [el.dataset.k, el.value.trim()]));
  if (v.displayName.length < 3) return flash("Enter the IT Admin's full name.");
  const btn = form.querySelector('button[type="submit"]'); btn.disabled = true;
  run(async () => {
    try { await callFn("hrAdminSave", { uid: a.uid, ...v, photo: a.photo || "" }); Object.assign(a, v); S.logLoaded = false; renderAdmins(); flash("The IT Admin information was saved. The IT Admin sees it at the next page load.", true); }
    finally { btn.disabled = false; }
  });
});

/* ---------- settings ---------- */
function renderSettings() {
  sec("settings").innerHTML = `<div class="panel"><h2>Lists</h2><p class="muted">One item per line. These fill the Position and Department drop-downs.</p>
    <div class="row"><label>Positions<textarea id="sPos" class="tall" rows="10"></textarea></label><label>Departments<textarea id="sDept" class="tall" rows="10"></textarea></label></div>
    <div class="savebar noprint"><button class="btn primary" id="sSave">Save lists</button></div></div>
  <div class="panel"><h2>Leave types</h2><p class="muted">One per line: <b>name | days a year</b>. Use 0 for leave without a limit (it is still listed, but no balance is shown). Every employee account sees these when sending a leave request.</p>
    <label>Leave types<textarea id="sLeave" class="tall" rows="8"></textarea></label><div class="savebar noprint"><button class="btn primary" id="sLeaveSave">Save leave types</button></div></div>
  <div class="panel"><h2>Accounts that were made before the HR page</h2><p class="muted">If the IT Admin already created teacher, registrar, finance, custodian, guidance or HR accounts, press the button once. Each of them gets an HR record (name, Employee No., birthday), which you can then complete.</p>
    <button class="btn" id="sSync">Add the existing accounts to the HR records</button></div>`;
  $("sLeave").value = S.leaveTypes.map((t) => `${t.name} | ${t.days}`).join("\n");
  $("sLeaveSave").onclick = () => run(async () => {
    const seen = new Set(), types = [];
    for (const line of $("sLeave").value.split("\n")) { const [n, d] = line.split("|").map((x) => x.trim()); if (!n || seen.has(n.toLowerCase())) continue; seen.add(n.toLowerCase()); const days = d === undefined || d === "" ? 0 : +d; if (!(days >= 0 && days <= 366)) return flash(`"${n}": the days a year must be a number from 0 to 366.`); types.push({ name: n.slice(0, 60), days }); }
    if (!types.length) return flash("Keep at least one leave type.");
    await setDoc(doc(db, "hrSettings", SID), { schoolId: SID, leaveTypes: types, updatedAt: serverTimestamp() }, { merge: true });
    S.leaveTypes = types; renderLeave(); flash("Leave types saved.", true);
  });
  $("sPos").value = S.lists.positions.join("\n"); $("sDept").value = S.lists.departments.join("\n");
  $("sSave").onclick = () => run(async () => {
    const clean = (t) => [...new Set(t.split("\n").map((x) => x.trim()).filter(Boolean))];
    const p = clean($("sPos").value), d = clean($("sDept").value);
    if (!p.length || !d.length) return flash("Keep at least one position and one department.");
    await setDoc(doc(db, "hrSettings", SID), { schoolId: SID, lists: { positions: p, departments: d }, updatedAt: serverTimestamp() }, { merge: true });
    S.lists.positions = p; S.lists.departments = d; renderForm(); renderList(); flash("Lists saved.", true);
  });
  $("sSync").onclick = () => run(async () => {
    $("sSync").disabled = true;
    try { const r = await callFn("hrSyncAccounts"); await refresh(); flash(r.added ? `${r.added} existing account${r.added === 1 ? "" : "s"} added to the HR records. Open Employees to complete their information.` : "Nothing to add: every account already has an HR record.", true); }
    finally { $("sSync").disabled = false; }
  });
}


/* ---------- leave: requests sent by every employee account, and the monitoring of leave used ---------- */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const LV = { year: new Date().getFullYear(), st: "Pending", type: "", q: "", page: "req" };
const reqsOf = (e) => S.leave.filter((r) => (e.accountUid && r.requesterUid === e.accountUid) || (r.employeeId && r.employeeId === e.employeeId));
const onLeaveToday = (e) => { const t = today(); return reqsOf(e).some((r) => r.status === "Approved" && r.startDate <= t && t <= r.endDate); };
const usedDays = (reqs, type, year) => reqs.filter((r) => r.status === "Approved" && r.leaveType === type && String(r.startDate || "").startsWith(String(year))).reduce((a, r) => a + (+r.days || 0), 0);
const r1 = (n) => Math.round(n * 10) / 10;
const pendingCount = () => S.leave.filter((r) => r.status === "Pending").length;
async function loadLeave() {
  const snap = await getDocs(query(collection(db, "leaveRequests"), where("schoolId", "==", SID)));
  S.leave = snap.docs.map((d) => ({ id: d.id, ...d.data() })); renderLeave(); renderDash();
}
/** Everyone who has filed or could file: the HR employee list plus filers who are not in it (the IT Admin). */
function leavePeople() {
  const seen = new Set(), people = S.emps.map((e) => { const reqs = reqsOf(e); reqs.forEach((r) => seen.add(r.id)); return { no: e.employeeId, name: nameOf(e), position: e.position || "-", reqs }; });
  const extra = {}; S.leave.filter((r) => !seen.has(r.id)).forEach((r) => (extra[r.requesterUid] ||= { no: r.employeeId || "-", name: r.requesterName || "?", position: roleName(r.requesterRole), reqs: [] }).reqs.push(r));
  return people.concat(Object.values(extra));
}
function renderLeave() {
  const year = LV.year, types = S.leaveTypes, t = today(), pg = LV.page;
  const years = [...new Set([new Date().getFullYear(), ...S.leave.map((r) => +String(r.startDate || "").slice(0, 4)).filter(Boolean)])].sort((a, b) => b - a);
  const L = S.leave, pend = L.filter((r) => r.status === "Pending"), now = L.filter((r) => r.status === "Approved" && r.startDate <= t && t <= r.endDate);
  const soon = L.filter((r) => r.status === "Approved" && r.startDate > t).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const apprYear = L.filter((r) => r.status === "Approved" && String(r.startDate || "").startsWith(String(year)));
  const cards = [["Waiting for your decision", pend.length, pend.length ? "warn" : ""], ["On leave today", now.length, "blue"], ["Approved in " + year, apprYear.length, "good"], ["Days of leave approved in " + year, r1(apprYear.reduce((a, r) => a + (+r.days || 0), 0))]];
  const nav = [["req", `Leave request${pend.length ? ` (${pend.length})` : ""}`], ["now", `On leave and coming up (${now.length + soon.length})`], ["mon", "Leave monitoring"]];
  let body = "";
  if (pg === "req") {
    const q = LV.q.toLowerCase(), rows = L.filter((r) => (!LV.st || r.status === LV.st) && (!LV.type || r.leaveType === LV.type) && (!q || [r.requesterName, r.employeeId, r.leaveType, r.reason].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => (a.status === "Pending" ? 0 : 1) - (b.status === "Pending" ? 0 : 1) || (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    const act = (r) => (r.status === "Pending" ? `<button class="btn small primary" data-lv="Approved" data-id="${esc(r.id)}">Approve</button><button class="btn small danger" data-lv="Rejected" data-id="${esc(r.id)}">Reject</button>` :
      r.status === "Cancelled" ? "" : `<button class="btn small" data-lv="Pending" data-id="${esc(r.id)}">Reopen</button>`) + `<button class="btn small" data-lvdel="${esc(r.id)}" title="Delete this request">Delete</button>`;
    body = `<div class="panel"><h2>Leave request</h2><p class="muted">Sent by every employee account, including the IT Admin and HR itself. HR can also file a leave for an employee who has no account.</p>
    <div class="toolbar noprint"><label class="grow">Search<input id="lvQ" value="${esc(LV.q)}" placeholder="Name, Employee No. or reason" autocomplete="off"></label>
      <label>Status<select id="lvSt"><option value="">All</option>${["Pending", "Approved", "Rejected", "Cancelled"].map((x) => `<option${LV.st === x ? " selected" : ""}>${x}</option>`).join("")}</select></label>
      <label>Leave type<select id="lvTy"><option value="">All</option>${[...new Set([...types.map((x) => x.name), ...L.map((r) => r.leaveType)])].map((x) => `<option${LV.type === x ? " selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
      <button class="btn primary" id="lvFile" type="button">File a leave for an employee</button><button class="btn" id="lvXls" type="button">Download Excel</button></div>
    <div class="tablewrap"><table id="lvTable">${hdr(["Filed", "Employee", "Leave", "Dates", "Days", "Reason", "Status", "Remarks", ""]) + (rows.map((r) => `<tr><td>${esc(r.createdAt?.toDate ? r.createdAt.toDate().toLocaleDateString() : "-")}</td>
      <td>${esc(r.requesterName || "")}<br><small>${esc(r.employeeId || "")} ${esc(roleName(r.requesterRole))}${r.filedByHr ? " (filed by HR)" : ""}</small></td><td>${esc(r.leaveType)}</td><td>${esc(rangeText(r))}</td><td>${esc(r.days)}</td><td>${esc(r.reason || "-")}</td>
      <td><span class="badge ${STATUS_CLASS[r.status] || ""}">${esc(r.status)}</span>${r.decidedByName ? `<br><small>${esc(r.decidedByName)}</small>` : ""}</td><td>${esc(r.hrRemarks || "")}</td><td class="actions">${act(r)}</td></tr>`).join("") || emptyRow(9, "No leave requests found."))}</table></div></div>`;
  } else if (pg === "now") {
    const row = (r, tag) => rowHtml([esc(r.requesterName) + (tag ? ' <span class="badge st-going">On leave today</span>' : ""), esc(r.employeeId || "-"), esc(r.leaveType), esc(rangeText(r)), esc(r.days)]);
    body = `<div class="panel"><h2>On leave now</h2><div class="tablewrap"><table>${hdr(["Employee", "Employee No.", "Leave", "Dates", "Days"]) + (now.map((r) => row(r, true)).join("") || emptyRow(5, "Nobody is on leave today."))}</table></div></div>
    <div class="panel"><h2>Coming up</h2><div class="tablewrap"><table>${hdr(["Employee", "Employee No.", "Leave", "Dates", "Days"]) + (soon.map((r) => row(r, false)).join("") || emptyRow(5, "No approved leave is coming up."))}</table></div></div>`;
  } else {
    const people = leavePeople(), cols = types.filter((x) => +x.days > 0);
    const bal = hdr(["Employee No.", "Name", "Position", ...cols.map((c) => `${esc(c.name)} <small>(${c.days} days)</small>`), "Other leave (days used)", "Waiting (days)"]) +
      (people.map((p) => {
        const cells = cols.map((c) => { const u = usedDays(p.reqs, c.name, year), left = r1(c.days - u); return `${r1(u)} used, <b${left < 0 ? ' style="color:var(--red)"' : ""}>${left} left</b>`; });
        const other = p.reqs.filter((r) => r.status === "Approved" && String(r.startDate || "").startsWith(String(year)) && !cols.some((c) => c.name === r.leaveType)).reduce((a, r) => a + (+r.days || 0), 0);
        const wait = p.reqs.filter((r) => r.status === "Pending").reduce((a, r) => a + (+r.days || 0), 0);
        return rowHtml([esc(p.no), esc(p.name), esc(p.position), ...cells, r1(other), r1(wait)]);
      }).join("") || emptyRow(5, "No employees yet."));
    body = `<div class="panel"><h2>Leave monitoring (balance per employee)</h2><div class="toolbar noprint"><label>Year<select id="lvYear">${years.map((y) => `<option${y === year ? " selected" : ""}>${y}</option>`).join("")}</select></label><button class="btn" id="lvXls" type="button">Download Excel</button></div>
    <p class="muted">Only approved leave is counted, by the year of its first day. The days a year for each leave type are set under <b>Settings</b>.</p><div class="tablewrap"><table id="lvBal">${bal}</table></div></div>`;
  }
  sec("leave").innerHTML = `<div class="cards">${cards.map(([l, n, c]) => `<div class="stat${c ? " " + c : ""}"><b>${n}</b><span>${l}</span></div>`).join("")}</div>
  <div class="lv-sub noprint">${nav.map(([k, l]) => `<button class="btn${pg === k ? " on" : ""}" type="button" data-lvpage="${k}">${l}</button>`).join("")}</div>${body}`;
  if ($("lvQ")) { $("lvQ").oninput = (e) => { LV.q = e.target.value; const pos = e.target.selectionStart; renderLeave(); const n = $("lvQ"); n.focus(); n.setSelectionRange(pos, pos); };
    $("lvSt").onchange = (e) => { LV.st = e.target.value; renderLeave(); }; $("lvTy").onchange = (e) => { LV.type = e.target.value; renderLeave(); }; $("lvFile").onclick = () => run(fileForEmployee); }
  if ($("lvYear")) $("lvYear").onchange = (e) => { LV.year = +e.target.value; renderLeave(); };
  if ($("lvXls")) $("lvXls").onclick = () => leaveExcel(L, leavePeople(), types.filter((x) => +x.days > 0), year);
  const tb = $("tabs").querySelector('[data-t="leave"]'); if (tb) tb.textContent = pend.length ? `Leave (${pend.length})` : "Leave";
}
/** HR files a leave for an employee, also one who has no portal account (a driver, a guard ...). */
async function fileForEmployee() {
  const emps = S.emps.filter((e) => (e.status || "Active") !== "Resigned" && e.status !== "Terminated" && e.status !== "Retired");
  if (!emps.length) return flash("Add an employee first.");
  const lt = S.leaveTypes.map((x) => `<option>${esc(x.name)}</option>`).join("");
  const a = await showPopup({ title: "File a leave for an employee", html: `<div class="row"><label>Employee<select data-pf="emp">${emps.map((e) => `<option value="${esc(e.id)}">${esc(e.employeeId)} - ${esc(nameOf(e))}${e.accountUid ? "" : " (no account)"}</option>`).join("")}</select></label></div>
    <div class="row"><label>Leave type<select data-pf="type">${lt}</select></label><label>From<input type="date" data-pf="from"></label><label>To<input type="date" data-pf="to"></label><label class="narrow">Days<input type="number" data-pf="days" min="0.5" step="0.5"></label></div>
    <label>Reason<textarea data-pf="reason" class="tall" maxlength="1000"></textarea></label>
    <label>Status<select data-pf="status"><option value="Approved">Approved (already allowed)</option><option value="Pending">Pending (decide later)</option></select></label>`,
    onOpen: (el) => { const g = (k) => el.querySelector(`[data-pf="${k}"]`), calc = () => { const n = workingDays(g("from").value, g("to").value); if (n) g("days").value = n; };
      g("from").onchange = () => { if (!g("to").value || g("to").value < g("from").value) g("to").value = g("from").value; calc(); }; g("to").onchange = calc; },
    validate: (f) => !f.from || !f.to ? "Enter the first and the last day." : f.to < f.from ? "The last day cannot be before the first day." : !(+f.days > 0) ? "Enter the number of working days." : "",
    buttons: [{ label: "Cancel", value: "no" }, { label: "Save leave", value: "yes", primary: true }] });
  if (a.value !== "yes") return;
  const f = a.fields, e = S.emps.find((x) => x.id === f.emp); if (!e) return;
  const ref = doc(collection(db, "leaveRequests")), d = { schoolId: SID, requesterUid: e.accountUid || "", requesterName: nameOf(e), requesterRole: e.accountRole || e.accessType || "", employeeId: e.employeeId, leaveType: f.type, startDate: f.from, endDate: f.to, days: +f.days, reason: (f.reason || "").trim(),
    status: f.status, filedBy: user.uid, filedByName: profile.displayName, filedByHr: true, createdAt: serverTimestamp() };
  if (f.status === "Approved") { d.decidedBy = user.uid; d.decidedByName = profile.displayName; d.decidedAt = serverTimestamp(); d.hrRemarks = "Filed by HR"; }
  try { await setDoc(ref, d); } catch (err) { console.error(err); return showPopup({ title: "The leave was not saved", html: `<p>${esc(errText(err))}</p>`, ok: false }); }
  await loadLeave(); showPopup({ title: "Leave saved", html: `<p>${esc(nameOf(e))}: ${esc(f.type)}, ${esc(rangeText({ startDate: f.from, endDate: f.to }))}.</p>`, ok: true });
}
sec("leave").addEventListener("click", (e) => {
  const pgb = e.target.closest("button[data-lvpage]"); if (pgb) { LV.page = pgb.dataset.lvpage; return renderLeave(); }
  const dl = e.target.closest("button[data-lvdel]"); if (dl) { const r = S.leave.find((x) => x.id === dl.dataset.lvdel); return r && removeLeave(r); }
  const b = e.target.closest("button[data-lv]"); if (!b) return; const r = S.leave.find((x) => x.id === b.dataset.id); if (r) decide(r, b.dataset.lv);
});
async function removeLeave(r) {
  const a = await showPopup({ title: "Delete this leave request?", ok: false, html: `<p><b>${esc(r.requesterName)}</b><br>${esc(r.leaveType)}, ${esc(rangeText(r))}</p><p>It is removed from the monitoring too.</p>`, buttons: [{ label: "Keep", value: "no" }, { label: "Delete", value: "yes", primary: true, danger: true }] });
  if (a.value !== "yes") return;
  try { await deleteDoc(doc(db, "leaveRequests", r.id)); } catch (err) { return showPopup({ title: "Not deleted", html: `<p>${esc(errText(err))}</p>`, ok: false }); }
  await loadLeave();
}
async function decide(r, status) {
  const who = `<p><b>${esc(r.requesterName)}</b><br>${esc(r.leaveType)}, ${esc(rangeText(r))} (${esc(r.days)} day${+r.days === 1 ? "" : "s"})${r.reason ? `<br><small>${esc(r.reason)}</small>` : ""}</p>`;
  let remarks = "";
  if (status === "Rejected") {
    const a = await showPopup({ title: "Reject this leave?", html: who, input: { label: "Reason (the employee will read it)", required: "Please write a short reason for rejecting." }, buttons: [{ label: "Back", value: "no" }, { label: "Reject leave", value: "yes", primary: true, danger: true }] });
    if (a.value !== "yes") return; remarks = a.text.trim();
  } else if (status === "Approved") {
    const t = S.leaveTypes.find((x) => x.name === r.leaveType), used = usedDays(S.leave.filter((x) => x.requesterUid === r.requesterUid), r.leaveType, String(r.startDate).slice(0, 4));
    const over = t && +t.days > 0 && used + (+r.days || 0) > t.days ? `<p class="lv-pop-err">${esc(r.requesterName)} has used ${r1(used)} of ${t.days} days of ${esc(r.leaveType)}. Approving ${esc(r.days)} more goes over the limit.</p>` : "";
    const a = await showPopup({ title: "Approve this leave?", html: who + over, input: { label: "Remarks for the employee (optional)" }, buttons: [{ label: "Back", value: "no" }, { label: "Approve leave", value: "yes", primary: true }] });
    if (a.value !== "yes") return; remarks = a.text.trim();
  } else if ((await showPopup({ title: "Reopen this request?", html: who + "<p>It goes back to Pending.</p>", buttons: [{ label: "Back", value: "no" }, { label: "Reopen", value: "yes", primary: true }] })).value !== "yes") return;
  const b = writeBatch(), ref = doc(db, "leaveRequests", r.id), patch = { status, updatedAt: serverTimestamp() };
  if (status === "Pending") { patch.hrRemarks = deleteField(); patch.decidedBy = deleteField(); patch.decidedByName = deleteField(); patch.decidedAt = deleteField(); }
  else { patch.hrRemarks = remarks; patch.decidedBy = user.uid; patch.decidedByName = profile.displayName; patch.decidedAt = serverTimestamp(); }
  b.update(ref, patch);
  b.set(doc(collection(db, "hrLog")), { schoolId: SID, byUid: user.uid, byName: profile.displayName, action: status === "Pending" ? "Reopened leave request" : `${status} leave (${r.leaveType}, ${rangeText(r)})`, targetName: r.requesterName || "", targetNo: r.employeeId || "", createdAt: serverTimestamp() });
  try { await b.commit(); } catch (e) { console.error(e); return showPopup({ title: "The decision was not saved", html: `<p>${esc(errText(e))}</p>`, ok: false }); }
  S.logLoaded = false; await loadLeave();
  showPopup({ title: status === "Pending" ? "Request reopened" : status === "Approved" ? "Leave approved" : "Leave rejected", html: `<p>${esc(r.requesterName)}: ${esc(r.leaveType)}, ${esc(rangeText(r))}.</p>`, ok: status !== "Rejected" });
}
function leaveExcel(rows, people, cols, year) {
  if (!window.XLSX) return flash("The Excel writer did not load. Check your internet connection.");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.map((r) => ({ Filed: r.createdAt?.toDate ? r.createdAt.toDate().toLocaleDateString() : "", "Employee No.": r.employeeId || "", Name: r.requesterName || "", Account: roleName(r.requesterRole), "Leave type": r.leaveType, From: r.startDate, To: r.endDate, "Working days": r.days, Reason: r.reason || "", Status: r.status, "HR remarks": r.hrRemarks || "", "Decided by": r.decidedByName || "" }))), "Requests");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(people.map((p) => { const o = { "Employee No.": p.no, Name: p.name, Position: p.position }; cols.forEach((c) => { const u = usedDays(p.reqs, c.name, year); o[c.name + " used"] = r1(u); o[c.name + " left"] = r1(c.days - u); }); return o; })), "Balances " + year);
  XLSX.writeFile(wb, `${slugName(school.displayName || school.name || "school")}-leave-${year}.xlsx`);
}

let listBuilt = false;
function renderAll() { renderDash(); renderLeave(); if (!editing) renderForm(); if (!listBuilt) { renderListShell(); listBuilt = true; } renderList(); renderHistory(); }
renderSettings();
renderAll();
show("dash");
await refresh();

/* New leave requests pop up in the middle of the screen when HR opens the page (once for each new request). */
(function notifyPending() {
  const pend = S.leave.filter((r) => r.status === "Pending"); if (!pend.length) return;
  const KEY = "ark.hrLeaveSeen." + user.uid; let known = []; try { known = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { }
  const fresh = pend.filter((r) => !known.includes(r.id)); if (!fresh.length) return;
  try { localStorage.setItem(KEY, JSON.stringify(pend.map((r) => r.id))); } catch { }
  showPopup({ title: fresh.length === 1 ? "New leave request" : `${fresh.length} new leave requests`, ok: undefined,
    html: fresh.slice(0, 6).map((r) => `<p><b>${esc(r.requesterName)}</b> (${esc(roleName(r.requesterRole))})<br>${esc(r.leaveType)}, ${esc(rangeText(r))}, ${esc(r.days)} day${+r.days === 1 ? "" : "s"}${r.reason ? `<br><small>${esc(r.reason)}</small>` : ""}</p>`).join("") + (fresh.length > 6 ? `<p>and ${fresh.length - 6} more...</p>` : ""),
    buttons: [{ label: "Later", value: "later" }, { label: "Review now", value: "go", primary: true }] }).then((a) => { if (a.value === "go") { LV.st = "Pending"; renderLeave(); show("leave"); } });
})();
