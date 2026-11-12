/* School Admin home: links to the view-only dashboards and reports of every department. */
import { requireRole, logout, applyBranding } from "./auth.js";

const $ = (id) => document.getElementById(id);
const { profile, school } = await requireRole(["schooladmin"]);
$("who").textContent = profile.displayName + " (School Admin)"; $("out").onclick = logout;
applyBranding(school);
const net = () => { $("sync").className = "sync" + (navigator.onLine ? "" : " off"); $("sync").lastElementChild.textContent = navigator.onLine ? "Online" : "Offline"; };
addEventListener("online", net); addEventListener("offline", net); net();

/* the side menu: the same departments (the page has no tab bar to copy from) */
const nav = $("sideNav");
[["Overview", "schooladmin"], ["Registrar", "registrar"], ["Finance", "finance"], ["Payroll", "payroll"], ["HR", "hr"], ["Custodian", "custodian"], ["Guidance", "guidance"]].forEach(([label, href]) => {
  const b = Object.assign(document.createElement("button"), { type: "button", className: "sidenav-item" + (href === "schooladmin" ? " on" : ""), textContent: label });
  b.onclick = () => { location.href = href; }; nav.appendChild(b);
});
