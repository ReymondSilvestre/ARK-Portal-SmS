import { db, call, callFn, rpc, getSession, setSession, clearSession, decode } from "./db.js";

export { db };
export const app = null;                       // (kept so older imports still work; there is no Firebase app any more)
export const auth = {
  get currentUser() { const s = getSession(); return s ? { uid: s.uid } : null; },
  signOut: async () => { clearSession(); meCache = null; },
};

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const homeFor = (role) =>
  role === "superadmin" ? "superadmin" : role === "admin" ? "admin" : role === "registrar" ? "registrar" : role === "finance" ? "finance" : role === "payroll" ? "payroll" : role === "custodian" ? "custodian" : role === "guidance" ? "guidance" : role === "hr" ? "hr" : role === "schooladmin" ? "schooladmin" : role === "staff" ? "staff" : role === "student" ? "student" : "teacher";

/* ---------- logins ----------
   Students: Exam ID No.                      (no school code)
   Employees (teacher, registrar, finance, custodian, guidance, HR, any other staff): School code + Employee No.
   IT admins / Super Admin: a real email address.
   An optional REAL email on a teacher / student account also works as a username and receives reset links. */
export const STUDENT_DOMAIN = "student.ark-exam.app";   // only used to show a placeholder address on accounts without a real email
export const STAFF_DOMAIN = "staff.ark-exam.app";
export const studentEmail = (examId) => `${String(examId).trim().toLowerCase()}@${STUDENT_DOMAIN}`;
const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
export const staffEmail = (schoolCode, employeeNo) => `${slug(schoolCode)}.${slug(employeeNo)}@${STAFF_DOMAIN}`;
export const isRealEmail = (e) => {
  const v = String(e || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && !v.endsWith("@" + STUDENT_DOMAIN) && !v.endsWith("@" + STAFF_DOMAIN);
};
export const cleanEmail = (e) => (isRealEmail(e) ? String(e).trim().toLowerCase() : "");
/** ONE inbox for every reset link: IT Admin email + a tag, e.g. school@gmail.com + 2026-0001 -> school+2026-0001@gmail.com.
 *  Gmail (and Outlook) deliver every "+tag" address to the base inbox. Returns "" when the base is not a usable email. */
export const sharedEmail = (baseEmail, tag) => {
  const m = /^([^\s@+]+)(?:\+[^\s@]*)?@([^\s@]+\.[^\s@]{2,})$/.exec(String(baseEmail || "").trim().toLowerCase());
  const t = String(tag || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return m && t ? `${m[1]}+${t}@${m[2]}` : "";
};
export const staffKey = (schoolCode, employeeNo) => `${slug(schoolCode)}.${slug(employeeNo)}`;
export const studentKey = (examId) => slug(examId);
export const fbPass = (p) => p;                 // (no 6-character minimum any more, so nothing is added)
/** Birth year + first letter of the last name, e.g. 1985 + Dela Cruz = "1985D". Used for teachers AND students. */
export function defaultStudentPassword(s) {
  const y = /^(\d{4})-/.exec(s.birthday || "")?.[1], l = String(s.lastName || "").trim()[0];
  return y && l ? y + l.toUpperCase() : "";
}
export function ageOf(birthday) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday || ""); if (!m) return "";
  const t = new Date(); let a = t.getFullYear() - +m[1];
  if (t.getMonth() + 1 < +m[2] || (t.getMonth() + 1 === +m[2] && t.getDate() < +m[3])) a--;
  return a >= 0 && a < 120 ? a : "";
}
export const fullName = (last, first, mi) => `${last}, ${first}${mi ? " " + mi + "." : ""}`;

export function friendlyError(e) {
  const map = {
    "auth/invalid-credential": "The username, school code or password is incorrect.",
    "auth/wrong-password": "The username, school code or password is incorrect.",
    "auth/user-not-found": "The username, school code or password is incorrect.",
    "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
    "auth/network-request-failed": "No connection. Check your internet and try again.",
    "auth/weak-password": "Choose a stronger password (at least 10 characters with a letter and a number; students 8).",
    "auth/email-already-in-use": "That account already exists (same school code and Employee No., or same email).",
    "auth/invalid-email": "That email address is not valid.",
    "permission-denied": "You do not have permission for that action.",
    "unauthenticated": "Please sign in again.",
    "unavailable": "The server is busy. Please try again in a moment.",
  };
  return map[e?.code] || e?.message || "Something went wrong.";
}

/* The profile + school of the signed-in person.
   Every page used to wait for a round trip to Google before it could even start. Now the answer from sign-in is kept for this browser tab (10 minutes),
   so the page opens at once, and a fresh copy is fetched quietly in the background (together with the page's first data request, so it costs no extra trip).
   If the fresh copy says the account was suspended / changed, the person is sent back to sign in. The server checks every request anyway. */
const ME_KEY = "ark.me", ME_TTL = 10 * 60 * 1000, ME_FRESH = 3 * 60 * 1000;   // trusted as is for 3 minutes; after that it is re-checked quietly
let meCache = null;
const readMe = () => { try { const o = JSON.parse(sessionStorage.getItem(ME_KEY) || "null"), s = getSession(); if (o && s && o.uid === s.uid && o.exp > Date.now()) return o; } catch { } return null; };
const saveMe = (raw) => { try { const s = getSession(); sessionStorage.setItem(ME_KEY, JSON.stringify({ uid: s && s.uid, at: Date.now(), exp: Date.now() + ME_TTL, me: raw })); } catch { } };
const forgetMe = () => { meCache = null; try { sessionStorage.removeItem(ME_KEY); } catch { } };
function revalidateMe() {
  call({ k: "me" }).then((r) => {
    saveMe(r); const fresh = decode(r), p = fresh.profile, old = meCache && meCache.profile;
    const bad = !p || p.status !== "active" || (old && p.role !== old.role) || (p.role !== "superadmin" && (!fresh.school || fresh.school.status !== "active"));
    if (bad) { clearSession(); if (!/\/login(\.html)?\/?$/.test(location.pathname)) location.href = "login?denied=1"; } else meCache = fresh;
  }).catch((e) => { if (e && e.code === "unauthenticated") forgetMe(); });
}
const fetchMe = async () => {
  if (meCache) return meCache;
  const hit = readMe();
  if (hit) { meCache = decode(hit.me); if (Date.now() - (hit.at || 0) > ME_FRESH) revalidateMe(); return meCache; }
  const r = await call({ k: "me" }); saveMe(r); return (meCache = decode(r));
};

/** `who` = email (IT admin / Super Admin), Employee No. (teacher, needs `school`) or Exam ID No. (student, no school). */
export async function login(who, password, school) {
  const r = await rpc("login", { who: who.trim(), password, school: school || "" });
  setSession({ token: r.token, exp: r.exp, uid: r.uid, role: r.profile && r.profile.role });   // the role is kept so db.js can block every write of a view-only School Admin
  saveMe({ profile: r.profile, school: r.school }); meCache = decode({ profile: r.profile, school: r.school });
  return { user: { uid: r.uid } };
}

/** "Forgot password": emails a reset link to the account's REAL email.
 *  Returns "sent" or "noemail" (the account has no real email, so only the IT Admin / teacher can reset it). */
export async function sendReset(who, school) {
  const r = await rpc("resetRequest", { who: who.trim(), school: school || "" });
  return r.result;
}
export const resetWithToken = (uid, token, password) => rpc("resetConfirm", { uid, token, password });
export const logout = async () => { clearSession(); meCache = null; location.href = "login"; };
export { warmUp } from "./db.js";
export { forgetMe };

export async function getProfile() { try { return (await fetchMe()).profile; } catch { return null; } }
export async function getSchool(profile) {
  if (!profile || profile.role === "superadmin") return null;
  try { return (await fetchMe()).school; } catch { return null; }
}

export async function destinationFor() {
  const m = await fetchMe(), p = m.profile;
  if (!p) throw new Error("This account is not registered. Contact your IT administrator.");
  if (p.status !== "active") throw new Error("This account is suspended. Contact your IT administrator.");
  if (p.role !== "superadmin" && (!m.school || m.school.status !== "active")) throw new Error("This school is not active. Contact the system administrator.");
  return p.mustChangePassword ? "change-password" : homeFor(p.role);
}

export async function changeOwnPassword(newPassword) {
  const r = await callFn("changePassword", { newPassword });
  const s = getSession(); setSession({ ...s, token: r.token, exp: r.exp });
  forgetMe();
}

export async function requireRole(roles, { allowMustChange = false } = {}) {
  const s = getSession();
  if (!s) { location.href = "login"; return new Promise(() => {}); }
  let m = null;
  try { m = await fetchMe(); } catch (e) { if (e.code === "unauthenticated") return new Promise(() => {}); }
  const profile = m && m.profile, school = m && m.school;
  const schoolOk = profile && (profile.role === "superadmin" || (school && school.status === "active"));
  if (!profile || profile.status !== "active" || !schoolOk || !roles.includes(profile.role)) {
    clearSession(); location.href = "login?denied=1"; return new Promise(() => {});
  }
  if (profile.mustChangePassword && !allowMustChange) { location.href = "change-password"; return new Promise(() => {}); }
  return { user: { uid: s.uid, email: profile.email }, profile, school };
}

/* ---------- school identity (name + logo set by the IT Admin) ---------- */
export const schoolTitle = (sc) => (sc && (sc.displayName || sc.name)) || "";
/** Shows the school identity as ONE block (logo + school name) underneath the signed-in user's name, inside .brand.
 *  The signed-in user's name is shown on its own line BELOW that block (see the .brand.has-school rule in style.css). Falls back to the default mark when the school has no logo. */
export function applyBranding(sc) {
  if (!sc) return;
  const b = document.querySelector(".brand"); if (!b || document.getElementById("brandSchoolBox")) return;
  const box = Object.assign(document.createElement("div"), { id: "brandSchoolBox", className: "school-id" });
  const mark = b.querySelector(".mark");
  if (sc.logo) { box.append(Object.assign(document.createElement("img"), { src: sc.logo, alt: "", className: "school-logo" })); mark?.remove(); }
  else if (mark) box.append(mark);
  const t = schoolTitle(sc);
  if (t) { const n = document.createElement("span"); n.id = "brandSchool"; n.className = "brand-school"; n.textContent = t; box.append(n); }
  b.classList.add("has-school"); b.append(box);
}
