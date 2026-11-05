/* Page of an employee whose position has no special tools (principal, librarian, nurse, security guard, driver, janitor ...).
   It shows who the person is and lets them send leave requests to HR (the Leave request button comes from js/leave.js). */
import { requireRole, logout, esc, applyBranding } from "./auth.js";

const $ = (id) => document.getElementById(id);
const { profile, school } = await requireRole(["staff"]);
$("who").textContent = profile.displayName; $("out").onclick = logout; applyBranding(school);
$("name").textContent = profile.displayName;
$("info").innerHTML = [["Employee No.", profile.employeeId], ["Position", profile.position], ["Department", profile.department], ["School", school && (school.displayName || school.name)]]
  .filter(([, v]) => v).map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v)}`).join("<br>");
if (profile.photo) { $("pic").src = profile.photo; $("pic").hidden = false; }
const net = () => { $("sync").className = "sync" + (navigator.onLine ? "" : " off"); $("sync").lastElementChild.textContent = navigator.onLine ? "Online" : "Offline"; };
addEventListener("online", net); addEventListener("offline", net); net();
$("goLeave").onclick = () => document.getElementById("leaveBtn")?.click();
