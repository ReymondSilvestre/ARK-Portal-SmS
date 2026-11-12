/* "Class schedule" tab on the Teacher page (the teacher's own classes) and on the Student page (the student's own section).
   Shows what the Registrar has SENT from Registrar > Sections > Make schedule. The server only returns those rows to this person. */
import { requireRole, db, esc } from "./auth.js";
import { collection, query, where, getDocs, getDoc, doc, liveRefresh } from "./db.js";
import { gridHtml, listHtml, breaksFor, printPages, hours, DAYS, SHORT, byTime } from "./schedule-view.js";

const root = document.getElementById("myScheduleRoot");
const tab = document.querySelector('#tabs [data-t="schedule"]');
if (root && tab) {
  const { user, profile, school } = await requireRole(["teacher", "student", "admin"]);
  if (profile.role === "admin") { tab.hidden = true; }                 // the IT Admin does not teach: class schedules are made by the Registrar
  else { load().catch((e) => { console.warn(e); root.innerHTML = `<p class="muted">The class schedule could not be loaded. Try again later.</p>`; }); liveRefresh(["scheduleSemesters", "classSchedules"], () => load()); }

  async function load() {
    const SID = profile.schoolId, isStudent = profile.role === "student";
    const sems = (await getDocs(query(collection(db, "scheduleSemesters"), where("schoolId", "==", SID)))).docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.published);
    sems.sort((a, b) => (b.publishedAt?.toMillis?.() || 0) - (a.publishedAt?.toMillis?.() || 0));
    const sem = sems[0];
    if (!sem) return empty();
    let entries, secName = "";
    if (isStudent) {
      const me = await getDoc(doc(db, "students", profile.studentId)); const st = me.exists() ? me.data() : {};
      if (!st.classId) return empty("You are not placed in a section yet.");
      secName = st.className || "";
      entries = (await getDocs(query(collection(db, "classSchedules"), where("schoolId", "==", SID), where("sectionId", "==", st.classId)))).docs;
    } else entries = (await getDocs(query(collection(db, "classSchedules"), where("schoolId", "==", SID), where("ownerUid", "==", user.uid)))).docs;
    entries = entries.map((d) => ({ id: d.id, ...d.data() })).filter((e) => e.semesterId === sem.id).sort(byTime);
    if (!entries.length) return empty(isStudent ? "No classes were scheduled for your section yet." : "No classes were scheduled for you yet.");

    const mode = isStudent ? "student" : "teacher", who = isStudent ? secName || entries[0].sectionName : profile.displayName;
    const html = gridHtml(entries, breaksFor(sem.breaks, isStudent ? "section" : "teacher", who), { mode });
    const per = DAYS.map((d) => entries.filter((e) => e.day === d).reduce((s, e) => s + hours(e.start, e.end), 0));
    const SEEN = "ark.schedSeen." + user.uid, ver = String(sem.publishedAt?.toMillis?.() || 0);
    let seen = ""; try { seen = localStorage.getItem(SEEN) || ""; } catch { }
    if (seen !== ver) tab.textContent = "Class schedule (new)";
    root.innerHTML = `<h2>${isStudent ? "My class schedule" : "My teaching schedule"}</h2>
      <p class="muted">${esc(sem.name)}${isStudent ? " &middot; Section <b>" + esc(who) + "</b>" : ""}${sem.publishedAt?.toDate ? " &middot; sent " + esc(sem.publishedAt.toDate().toLocaleDateString()) : ""}</p>
      ${isStudent ? "" : `<div class="sc-hrs">${DAYS.map((d, i) => `<span><b>${SHORT[d]}</b> ${per[i].toFixed(1)} h</span>`).join("")}<span><b>Week</b> ${per.reduce((a, b) => a + b, 0).toFixed(1)} h</span></div>`}
      <div class="btnbar noprint"><button class="btn primary" id="msPrint" type="button">Print</button></div>
      <div class="sc-scroll">${html}</div><h3 style="margin-top:1rem">List of classes</h3>${listHtml(entries, mode)}`;
    document.getElementById("msPrint").onclick = () => printPages(school, [{ title: isStudent ? `Section ${who}` : who, sub: sem.name, html }]);
    tab.onclick = () => { try { localStorage.setItem(SEEN, ver); } catch { } tab.textContent = "Class schedule"; };   // (a property, so reloading does not stack listeners)
  }
  function empty(msg) {
    root.innerHTML = `<h2>${profile.role === "student" ? "My class schedule" : "My teaching schedule"}</h2><p class="muted">${esc(msg || "No class schedule has been sent yet. The Registrar sends it when it is ready.")}</p>`;
  }
}
