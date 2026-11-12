/* VIEW-ONLY mode for the School Admin account.
   The School Admin sees the dashboards and reports of every department (Registrar, Finance, Payroll, HR, Custodian, Guidance) but cannot change anything.
   This file does nothing for any other account. It (1) adds a department bar at the top of the page, (2) keeps only the dashboard / report tabs of the page,
   and (3) hides the buttons that edit or delete. The real lock is in db.js (refuses every save) and in apps-script/Code.gs (no write rule exists for this role). */
import { getProfile } from "./auth.js";

const profile = await getProfile();
if (profile && profile.role === "schooladmin") {
  document.body.classList.add("viewonly");
  const page = (location.pathname.split("/").pop() || "").replace(/\.html$/, "");

  /* the tabs of each page that are dashboards or reports (everything else - forms, settings, history - is removed) */
  const KEEP = {
    registrar: ["dash", "master", "enrolled"],
    finance: ["dash", "tx", "em", "bal"],
    hr: ["dash", "list", "leave"],
    payroll: ["dash", "reports"],
    custodian: ["dash", "list", "file", "matrix"],
    guidance: ["dash", "list", "file"],
  };
  if (KEEP[page]) document.querySelectorAll("#tabs button").forEach((b) => { if (!KEEP[page].includes(b.dataset.t)) b.remove(); });

  /* the department bar */
  const DEPTS = [["schooladmin", "Overview"], ["registrar", "Registrar"], ["finance", "Finance"], ["payroll", "Payroll"], ["hr", "HR"], ["custodian", "Custodian"], ["guidance", "Guidance"]];
  const bar = document.createElement("nav");
  bar.className = "vo-bar noprint"; bar.setAttribute("aria-label", "Departments");
  bar.innerHTML = `<span class="vo-tag">View only</span>` + DEPTS.map(([k, l]) => `<a href="${k}"${k === page ? ' class="on" aria-current="page"' : ""}>${l}</a>`).join("");
  const anchor = document.getElementById("msg") || document.getElementById("tabs");
  if (anchor) anchor.insertAdjacentElement("beforebegin", bar);
}
