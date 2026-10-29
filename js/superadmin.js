import { requireRole, logout, db, esc, friendlyError } from "./auth.js";
import { collection, query, where, getDocs, getDoc, getCountFromServer, doc, writeBatch, deleteDoc, updateDoc, addDoc, serverTimestamp, callFn }
  from "./db.js";

const $ = (id) => document.getElementById(id);
const { user, profile } = await requireRole(["superadmin"]);
$("who").textContent = profile.displayName || "Super Admin"; $("out").onclick = logout;

const msg = $("msg");
const flash = (t, ok = false) => { msg.textContent = t; msg.className = "notice " + (ok ? "ok" : "err"); msg.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => (msg.hidden = true), 8000); };
const fmt = (ts) => (ts?.toDate ? ts.toDate().toLocaleDateString() : "-");
function popup(title, body, secret) {
  $("dlgTitle").textContent = title; $("dlgBody").textContent = body;
  $("dlgPw").hidden = $("dlgCopy").hidden = !secret; $("dlgPw").textContent = secret || ""; $("dlg").showModal();
}
$("dlgOk").onclick = () => { $("dlg").close(); $("dlgPw").textContent = ""; };
$("dlgCopy").onclick = () => navigator.clipboard?.writeText($("dlgPw").textContent);
const setSync = () => { $("sync").className = "sync" + (navigator.onLine ? "" : " off"); $("sync").lastElementChild.textContent = navigator.onLine ? "Online" : "Offline"; };
addEventListener("online", setSync); addEventListener("offline", setSync); setSync();

function genPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint32Array(14));
  return Array.from(r, (n) => chars[n % chars.length]).join("") + "a9";
}
const audit = (schoolId, action, targetUid, details = {}) =>
  addDoc(collection(db, "auditLogs"), { actorUid: user.uid, schoolId, action, targetUid, details, createdAt: serverTimestamp() });

let schools = [], admins = [];
async function refresh() {
  try {
    const [s, a] = await Promise.all([getDocs(collection(db, "schools")), getDocs(query(collection(db, "users"), where("role", "==", "admin")))]);
    schools = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((x, y) => x.name.localeCompare(y.name));
    admins = a.docs.map((d) => d.data());
    const n = await Promise.all(schools.map(async (sc) => {
      const c = (role) => getCountFromServer(query(collection(db, "users"), where("schoolId", "==", sc.id), where("role", "==", role))).then((r) => r.data().count);
      return [await c("teacher"), await c("student")];
    }));
    $("tbl").innerHTML = "<tr><th>School</th><th>Code</th><th>IT Admin</th><th>Teachers</th><th>Students</th><th>Status</th><th>Registered</th><th></th></tr>" +
      (schools.map((sc, i) => { const ad = admins.filter((x) => x.schoolId === sc.id);
        return `<tr><td>${esc(sc.name)}</td><td><code>${esc(sc.code)}</code></td><td>${ad.map((x) => esc(x.displayName) + " (" + esc(x.email) + ")").join("<br>") || "-"}</td>
        <td>${n[i][0]}</td><td>${n[i][1]}</td><td><span class="badge ${esc(sc.status)}">${esc(sc.status)}</span></td><td>${fmt(sc.createdAt)}</td>
        <td class="actions"><button class="btn small" data-act="toggle" data-id="${esc(sc.id)}">${sc.status === "active" ? "Suspend school" : "Reactivate"}</button>
        ${ad[0] ? `<button class="btn small" data-act="pw" data-uid="${esc(ad[0].uid)}">Reset IT Admin password</button>` : ""}
        <button class="btn small danger" data-act="clear" data-id="${esc(sc.id)}" data-name="${esc(sc.name)}" data-code="${esc(sc.code)}" title="Delete all data of ${esc(sc.name)} but keep the school">Delete all data</button>
        <button class="icon-btn" data-act="delete" data-id="${esc(sc.id)}" data-name="${esc(sc.name)}" title="Delete ${esc(sc.name)}" aria-label="Delete ${esc(sc.name)}">&#128465;</button></td></tr>`; }).join("") || "<tr><td colspan=8>No schools registered yet.</td></tr>");
  } catch (e) { flash("Could not load schools: " + friendlyError(e)); }
}

$("newS").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const name = f.name.trim(), code = f.code.trim().toUpperCase(), adminName = f.adminName.trim(), adminEmail = f.adminEmail.trim().toLowerCase();
  if (name.length < 3 || !/^[A-Z0-9-]{3,20}$/.test(code) || adminName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail))
    return flash("Enter the school name, a code (3-20 letters, numbers or hyphens), and the IT Admin's name and email.");
  $("addBtn").disabled = true;
  try {
    if ((await getDoc(doc(db, "schools", code))).exists()) throw new Error("That school code is already used. Choose another.");
    const pw = genPassword();
    // The server creates the school record, the IT Admin's profile and the login in one step.
    await callFn("createAccount", { role: "admin", displayName: adminName, email: adminEmail, password: pw, school: { name, code } });
    e.target.reset();
    popup(`${name} registered`, `School code ${code}. IT Admin sign-in: ${adminEmail} (no school code). Temporary password below, shown once. They must choose a new one at first sign-in.`, pw);
    await refresh();
  } catch (err) { flash(friendlyError(err)); }
  finally { $("addBtn").disabled = false; }
});

/** The server deletes everything of the school (all records and every login). Returns true when finished. */
async function runErase(fnName, schoolId) { await callFn(fnName, { schoolId }); return true; }

$("tbl").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  try {
    if (b.dataset.act === "toggle") {
      const sc = schools.find((x) => x.id === b.dataset.id), next = sc.status === "active" ? "suspended" : "active";
      if (!confirm(`${next === "suspended" ? "Suspend" : "Reactivate"} ${sc.name}? ${next === "suspended" ? "Nobody in this school can sign in or use the system until you reactivate it." : ""}`)) return;
      await updateDoc(doc(db, "schools", sc.id), { status: next, updatedAt: serverTimestamp() });
      await audit(sc.id, "school." + next, "", { name: sc.name }); flash(`${sc.name} is now ${next}.`, true);
    } else if (b.dataset.act === "clear") {
      const { name, code } = b.dataset;
      if (!confirm(`Delete ALL DATA of ${name}?\n\nThis removes every teacher and student account, section, exam, result, module, classroom code and activity log of this school.\nThe school stays registered and its IT Admin can still sign in, but starts completely empty.\n\nThis cannot be undone.`)) return;
      if (prompt(`Type the school code to confirm: ${code}`) !== code) { flash("Nothing was deleted: the school code did not match."); return; }
      b.disabled = true; flash(`Deleting all data of ${name}... this can take a minute. Please keep this page open.`, true);
      await runErase("superClearSchoolData", b.dataset.id);
      flash(`All data of ${name} was deleted. The school and its IT Admin are still registered.`, true);
    } else if (b.dataset.act === "delete") {
      const name = b.dataset.name;
      if (!confirm(`Permanently delete ${name}?\n\nThis removes the school itself, its IT Admin, every teacher and student account, and all of their sections, exams, results and modules.\n\nThis cannot be undone.`)) return;
      if (prompt(`Type the school name to confirm: ${name}`) !== name) { flash("Deletion cancelled: the name did not match."); return; }
      b.disabled = true; flash(`Deleting ${name} and all of its data... this can take a minute. Please keep this page open.`, true);
      await runErase("superDeleteSchool", b.dataset.id);
      flash(`${name} and all of its data and accounts were deleted.`, true);
    } else {
      const a = admins.find((x) => x.uid === b.dataset.uid); if (!a || !confirm(`Set a new temporary password for ${a.displayName}?`)) return;
      const pw = genPassword();
      await callFn("adminSetTempPassword", { uid: a.uid, password: pw });
      popup(`New password for ${a.displayName}`, "Give this to the IT Admin in person. It is shown once. They must choose a new one at the next sign-in.", pw);
    }
    await refresh();
  } catch (err) { b.disabled = false; flash(friendlyError(err)); }
});
refresh();
