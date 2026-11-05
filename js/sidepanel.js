/* The side panel shared by EVERY employee page (IT Admin, teacher, registrar, finance, custodian, guidance, HR, other staff).
   It fills the panel that is written in each page's HTML:
     photo  ->  account name  ->  position  ->  department  ->  page menu  ->  Leave request  ->  Sign out
   The page menu is a copy of the page's own tab buttons (#tabs), so the pages keep working exactly as before:
   pressing a menu item presses the matching tab, and the highlighted item follows the tab that is open.
   The "Leave request" button is added above "Sign out" by js/leave.js. The school logo and name (js/auth.js applyBranding) stay in the top centre. */
import { getProfile } from "./auth.js";
import { roleName } from "./leave.js";

const $ = (id) => document.getElementById(id);
const profile = await getProfile();

if (profile) {
  const name = profile.displayName || "";
  $("sideName").textContent = name;
  const pos = profile.position || (profile.role === "admin" ? "IT Admin" : roleName(profile.role));
  $("sidePos").textContent = pos;
  $("sideDept").textContent = profile.department || "";
  $("sideDept").hidden = !profile.department;
  const initials = name.replace(/[^A-Za-z\s,]/g, " ").split(/[\s,]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  $("sideAvatar").textContent = initials;
  if (profile.photo) { const im = $("sidePhoto"); im.src = profile.photo; im.alt = name; im.hidden = false; $("sideAvatar").hidden = true; }
}

/* ---- the page menu, built from the tab buttons ---- */
const tabs = $("tabs"), nav = $("sideNav");
if (tabs && nav && !nav.children.length) {
  const build = () => {
    nav.innerHTML = "";
    [...tabs.querySelectorAll("button")].forEach((b) => {
      const i = document.createElement("button");
      i.type = "button"; i.className = "sidenav-item" + (b.classList.contains("on") ? " on" : ""); i.textContent = b.textContent;
      i.onclick = () => { b.click(); scrollTo(0, 0); };
      nav.appendChild(i);
    });
  };
  build();
  new MutationObserver(build).observe(tabs, { attributes: true, attributeFilter: ["class", "hidden"], childList: true, subtree: true, characterData: true });
}
