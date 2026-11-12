/* IT Admin > Employee registration.
   The IT Admin can register an employee with the SAME full information HR keeps (personal, job, contact, government IDs, 2x2 photo), edit it,
   and then create the portal account from the same page. HR sees every record (and the line "Added by the IT Admin" in HR > History). */
import { requireRole, db, esc, staffKey, ageOf, friendlyError } from "./auth.js";
import { collection, query, where, getDocs, getDoc, doc, writeBatch, serverTimestamp, liveRefresh } from "./db.js";
import { squarePhoto } from "./photo.js";
import { showPopup, errText } from "./leave.js";
import { STATUSES, ACCESS, ACCESS_NAME, DEFAULT_LISTS, FIELDS, GROUPS, accessFor } from "./employee-fields.js";
import { mountEmployeeImport } from "./employee-import.js";   // upload many employees from an Excel file

const root = document.getElementById("empReg");
if (root) boot();

async function boot() {
  const { user, profile } = await requireRole(["admin"]);
  const SID = profile.schoolId, $ = (id) => document.getElementById(id);
  const S = { emps: [], lists: { positions: [...DEFAULT_LISTS.positions], departments: [...DEFAULT_LISTS.departments] }, photo: "", editing: null, view: "form", q: "", st: "", ac: "", loaded: false };
  const flash = (t, ok) => { const m = $("msg"); if (!m) return alert(t); m.textContent = t; m.className = "notice " + (ok ? "ok" : "err"); m.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => (m.hidden = true), 8000); scrollTo({ top: 0, behavior: "smooth" }); };
  const run = async (fn) => { try { await fn(); } catch (e) { console.error(e); flash(friendlyError(e)); } };
  const nameOf = (e) => `${e.lastName || ""}, ${e.firstName || ""}${e.middleInitial ? " " + e.middleInitial + "." : ""}`;
  const dateText = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") ? new Date(s + "T00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : s || "-");
  const hasAcct = (e) => !!e.accountUid;

  async function load() {
    const [emps, set] = await Promise.all([
      getDocs(query(collection(db, "employees"), where("schoolId", "==", SID))),
      getDoc(doc(db, "hrSettings", SID)).catch(() => null),
    ]);
    S.emps = emps.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const hs = set && set.exists() ? set.data() : null, l = (hs && hs.lists) || {};
    ["positions", "departments"].forEach((k) => { if (Array.isArray(l[k]) && l[k].length) S.lists[k] = l[k]; });
    S.loaded = true;
  }

  /* ---------- page ---------- */
  function render() {
    root.innerHTML = `<div class="panel"><h2>Employee registration</h2>
      <p class="muted">Register every employee here, with the full information (HR sees the same records). People who will never sign in (a driver, a guard ...) are registered too. When an employee needs a portal account, choose it under <b>Portal account</b> and press <b>Create account</b> in the list.</p>
      <div class="sc-tabs"><button class="btn${S.view === "form" ? " on" : ""}" data-v="form">${S.editing ? "Edit employee" : "Register an employee"}</button><button class="btn${S.view === "import" ? " on" : ""}" data-v="import">Upload from Excel</button><button class="btn${S.view === "list" ? " on" : ""}" data-v="list">Registered employees (${S.emps.length})</button></div>
      <div id="aeBody"></div></div>`;
    S.view === "form" ? form() : S.view === "import" ? importView() : list();
  }
  function importView() {
    $("aeBody").innerHTML = '<div id="impHost"></div>';
    mountEmployeeImport($("impHost"), { SID, user, byName: profile.displayName + " (IT Admin)", extra: { createdByRole: "admin" }, existing: () => new Map(S.emps.map((e) => [e.id, e])), lists: () => S.lists, onDone: async () => { await load(); render(); window.dispatchEvent(new Event("employees-changed")); } });
  }
  const control = (f) => {
    const a = `id="ae_${f.id}" data-f="${f.id}"${f.req ? " required" : ""}`;
    if (f.type === "textarea") return `<textarea ${a} class="tall" maxlength="500"></textarea>`;
    if (f.type === "select") return `<select ${a}>${f.req && f.def ? "" : '<option value="">-</option>'}${f.options.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
    if (f.type === "list") return `<select ${a}><option value="">-</option>${S.lists[f.list].map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
    if (f.type === "access") return `<select ${a}>${ACCESS.map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>`;
    return `<input ${a} type="${f.type || "text"}" autocomplete="off"${f.max ? ` maxlength="${f.max}"` : ""}>`;
  };
  function form() {
    const ed = S.editing;
    $("aeBody").innerHTML = `<form id="aeForm" novalidate><h3>Photo</h3><div class="photo-box"><img id="aePv" class="pv" alt="2x2 photo preview" hidden><div><label>2x2 picture <small>(JPG or PNG; it is cropped to a square)</small><input type="file" id="aePhoto" accept="image/*"></label><button class="btn small" type="button" id="aePhotoDel" hidden>Remove photo</button><p class="muted" id="aePhotoNote"></p></div></div>
      ${GROUPS.map((g) => `<h3>${g}</h3><div class="row">${FIELDS.filter((f) => f.group === g).map((f) => `<label${f.narrow ? ' class="narrow"' : ""}>${esc(f.label)}${f.req ? ' <span class="req">*</span>' : ""}${f.hint ? `<small>${esc(f.hint)}</small>` : ""}${control(f)}</label>`).join("")}</div>`).join("")}
      <div class="savebar"><button class="btn primary" id="aeSave">${ed ? "Save changes" : "Register employee"}</button>${ed ? '<button class="btn" id="aeCancel" type="button">Cancel editing</button>' : ""}</div></form>`;
    $("ae_status").value = "Active"; setPhoto(ed && ed.photo || "");
    if (ed) {
      FIELDS.forEach((f) => { const el = $("ae_" + f.id); if (!el) return; const v = ed[f.id] ?? ""; if (el.tagName === "SELECT" && v && ![...el.options].some((o) => o.value === v)) el.insertAdjacentHTML("beforeend", `<option>${esc(v)}</option>`); el.value = v || f.def || ""; });
      $("ae_employeeId").readOnly = true; $("ae_employeeId").title = "The Employee No. is the sign-in name, so it cannot be changed.";
    }
    $("aePhoto").onchange = (ev) => run(async () => { const f = ev.target.files[0]; if (!f) return; const d = await squarePhoto(f); if (!d) { ev.target.value = ""; return; } setPhoto(d); $("aePhotoNote").textContent = "New photo ready. Press Save to keep it."; });
    $("aePhotoDel").onclick = () => { setPhoto(""); $("aePhoto").value = ""; $("aePhotoNote").textContent = "The photo will be removed when you save."; };
    $("ae_position").addEventListener("change", () => { const a = accessFor($("ae_position").value), el = $("ae_accessType"); if (a && (!el.value || el.dataset.auto === el.value)) { el.value = a; el.dataset.auto = a; } });
    $("aeForm").addEventListener("submit", (e) => { e.preventDefault(); run(save); });
    if ($("aeCancel")) $("aeCancel").onclick = () => { S.editing = null; S.view = "list"; render(); };
  }
  const setPhoto = (d) => { S.photo = d || ""; const pv = $("aePv"); if (!pv) return; pv.src = S.photo; pv.hidden = !S.photo; $("aePhotoDel").hidden = !S.photo; };
  const readForm = () => Object.fromEntries(FIELDS.map((f) => { const el = $("ae_" + f.id); let v = el ? String(el.value || "").trim() : ""; if (f.id === "middleInitial") v = v.slice(0, 1).toUpperCase(); return [f.id, v]; }));

  async function save() {
    const v = readForm(), ed = S.editing;
    if (!v.employeeId || !v.lastName || !v.firstName) return flash("Enter the Employee No., last name and first name.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.birthday)) return flash("Enter the birthday (it is used for the first password).");
    if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) return flash("That email address is not valid. Fix it or leave it blank.");
    v.photo = S.photo || "";
    const key = staffKey(SID, v.employeeId);
    if (!ed && S.emps.some((e) => e.id === key)) return flash(`Employee No. ${v.employeeId} is already registered.`);
    $("aeSave").disabled = true;
    try {
      const b = writeBatch(), ref = doc(db, "employees", key);
      if (ed) { const patch = { ...v, updatedAt: serverTimestamp() }; delete patch.employeeId; b.update(ref, patch); }
      else b.set(ref, { ...v, schoolId: SID, createdBy: user.uid, createdByRole: "admin", createdAt: serverTimestamp() });
      b.set(doc(collection(db, "hrLog")), { schoolId: SID, byUid: user.uid, byName: profile.displayName + " (IT Admin)", action: ed ? "Edited (by the IT Admin)" : "Added (by the IT Admin)", targetName: nameOf(v), targetNo: v.employeeId, createdAt: serverTimestamp() });
      await b.commit();
      await load(); const was = ed; S.editing = null; S.view = "list"; render();
      window.dispatchEvent(new Event("employees-changed"));
      flash(was ? `${nameOf(v)} was updated.` : `${nameOf(v)} was registered.${v.accessType ? " You can now create the account (press Create account in the list)." : ""}`, true);
    } finally { if ($("aeSave")) $("aeSave").disabled = false; }
  }

  /* ---------- list ---------- */
  function list() {
    const q = S.q.toLowerCase();
    const rows = S.emps.filter((e) => (!q || [e.employeeId, nameOf(e), e.position, e.department].join(" ").toLowerCase().includes(q)) && (!S.st || (e.status || "Active") === S.st) && (!S.ac || (S.ac === "yes" ? hasAcct(e) : !hasAcct(e))));
    $("aeBody").innerHTML = `<div class="row"><label>Search<input id="aeQ" value="${esc(S.q)}" placeholder="Employee No. or name" autocomplete="off"></label>
      <label>Status<select id="aeSt"><option value="">All</option>${STATUSES.map((x) => `<option${S.st === x ? " selected" : ""}>${x}</option>`).join("")}</select></label>
      <label>Portal account<select id="aeAc"><option value="">All</option><option value="yes"${S.ac === "yes" ? " selected" : ""}>Has an account</option><option value="no"${S.ac === "no" ? " selected" : ""}>No account yet</option></select></label></div>
      <p class="muted">${rows.length} of ${S.emps.length} employees</p>
      <div class="tablewrap"><table><tr><th>Employee No.</th><th>Name</th><th>Position</th><th>Department</th><th>Status</th><th>Portal account</th><th></th></tr>${rows.map((e) => `<tr><td>${esc(e.employeeId || "-")}</td>
        <td>${e.photo ? `<img class="emp-photo" alt="" src="${esc(e.photo)}">` : ""}${esc(nameOf(e))}<br><small>${esc(dateText(e.birthday))}${ageOf(e.birthday) !== "" ? " (age " + ageOf(e.birthday) + ")" : ""}</small></td><td>${esc(e.position || "-")}</td><td>${esc(e.department || "-")}</td><td>${esc(e.status || "Active")}</td>
        <td>${hasAcct(e) ? `<span class="badge active">${esc(ACCESS_NAME[e.accountRole] || e.accountRole || "Account")}</span>` : e.accessType ? `<span class="badge warn">Needs ${esc(ACCESS_NAME[e.accessType] || e.accessType)}</span>` : "None needed"}</td>
        <td class="actions"><button class="btn small" data-a="edit" data-id="${esc(e.id)}">Edit</button>${hasAcct(e) ? "" : `<button class="btn small primary" data-a="acct" data-id="${esc(e.id)}">Create account</button><button class="btn small danger" data-a="del" data-id="${esc(e.id)}">Delete</button>`}</td></tr>`).join("") || `<tr><td colspan="7">No employees found.</td></tr>`}</table></div>`;
    $("aeQ").oninput = (e) => { S.q = e.target.value; const p = e.target.selectionStart; list(); const n = $("aeQ"); n.focus(); n.setSelectionRange(p, p); };
    $("aeSt").onchange = (e) => { S.st = e.target.value; list(); }; $("aeAc").onchange = (e) => { S.ac = e.target.value; list(); };
  }

  root.addEventListener("click", (e) => {
    const v = e.target.closest("button[data-v]"); if (v) { if (v.dataset.v === "form") S.editing = null; S.view = v.dataset.v; if (S.view === "list" || S.view === "import") return run(async () => { await load(); render(); }); return render(); }
    const b = e.target.closest("button[data-a]"); if (!b) return; const emp = S.emps.find((x) => x.id === b.dataset.id); if (!emp) return;
    if (b.dataset.a === "edit") { S.editing = emp; S.view = "form"; render(); return scrollTo({ top: 0 }); }
    if (b.dataset.a === "acct") { location.hash = "#teachers"; return setTimeout(() => window.dispatchEvent(new CustomEvent("employee-pick", { detail: emp.id })), 50); }
    if (b.dataset.a === "del") run(async () => {
      const a = await showPopup({ title: `Delete ${nameOf(emp)}?`, ok: false, html: `<p>Employee No. ${esc(emp.employeeId)} is removed from the employee records (HR sees this too).</p>`, buttons: [{ label: "Keep", value: "no" }, { label: "Delete", value: "yes", primary: true, danger: true }] });
      if (a.value !== "yes") return;
      const bt = writeBatch(); bt.delete(doc(db, "employees", emp.id));
      bt.set(doc(collection(db, "hrLog")), { schoolId: SID, byUid: user.uid, byName: profile.displayName + " (IT Admin)", action: "Deleted (by the IT Admin)", targetName: nameOf(emp), targetNo: emp.employeeId || "", createdAt: serverTimestamp() });
      try { await bt.commit(); } catch (err) { return showPopup({ title: "Not deleted", html: `<p>${esc(errText(err))}</p>`, ok: false }); }
      await load(); render(); window.dispatchEvent(new Event("employees-changed")); flash("Employee deleted.", true);
    });
  });

  await load(); render();
  liveRefresh(["employees", "hrSettings"], async () => { if (S.view === "list" && !S.editing) { await load(); render(); } });
}
