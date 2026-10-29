/* Mobile helpers (plain script, not a module). Include with: <script src="js/mobile.js" defer></script>
   1. Hamburger menu: on small screens the tab row (teacher / student pages) or the side bar (IT Admin page)
      is replaced by a slide-in menu opened from a hamburger button.
   2. Tables: every table gets data-label on its cells so CSS can show each row as a readable card on phones. */
(function () {
  "use strict";
  var body = document.body;

  /* ---------- 2. table labels (works on tables that are re-drawn by the page scripts) ---------- */
  function labelTable(t) {
    if (t.classList.contains("kvt")) return;
    var rows = t.rows; if (!rows.length) return;
    var head = rows[0]; if (!head.querySelector("th")) return;
    head.classList.add("hd");
    var names = [].map.call(head.cells, function (c) { return c.textContent.trim(); });
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i]; if (r.classList.contains("grp")) continue;
      var col = 0;
      for (var k = 0; k < r.cells.length; k++) {
        var c = r.cells[k];
        if (c.tagName === "TD" && c.colSpan === 1 && names[col]) c.setAttribute("data-label", names[col]);
        col += c.colSpan || 1;
      }
    }
  }
  var pending = false;
  function labelAll() { pending = false; [].forEach.call(document.querySelectorAll("table"), labelTable); }
  function queue() { if (!pending) { pending = true; requestAnimationFrame(labelAll); } }
  new MutationObserver(queue).observe(body, { childList: true, subtree: true }); // attribute changes do not trigger it
  queue();

  /* ---------- 1. hamburger menu ---------- */
  var ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>';
  var top = document.querySelector(".top");
  var tabs = document.getElementById("tabs");
  var side = document.querySelector(".side");
  if (!top || (!tabs && !side)) return;

  var btn = document.createElement("button");
  btn.type = "button"; btn.className = "navbtn"; btn.setAttribute("aria-label", "Open menu");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = ICON; // icon only; the current page is announced through aria-label
  top.insertBefore(btn, top.firstChild);

  var scrim = document.createElement("div"); scrim.className = "navscrim"; scrim.hidden = true; body.appendChild(scrim);
  var drawer, list, lastFocus;

  if (tabs) { // teacher / student: build a drawer from the tab buttons
    drawer = document.createElement("nav");
    drawer.className = "navdrawer"; drawer.id = "navDrawer"; drawer.setAttribute("aria-label", "Main menu"); drawer.hidden = true;
    drawer.innerHTML = '<div class="navhead"><b>Menu</b><button type="button" class="navclose" aria-label="Close menu">&times;</button></div><div class="navlist"></div><div class="navfoot"></div>';
    body.appendChild(drawer);
    list = drawer.querySelector(".navlist");
  } else { // admin: the existing side bar becomes the drawer
    drawer = side; drawer.id = drawer.id || "navDrawer";
    var x = document.createElement("button"); x.type = "button"; x.className = "navclose"; x.setAttribute("aria-label", "Close menu"); x.innerHTML = "&times;";
    drawer.insertBefore(x, drawer.firstChild);
  }
  btn.setAttribute("aria-controls", drawer.id);

  function currentLabel() {
    if (!tabs) return "Menu";
    var on = tabs.querySelector("button.on");
    return on ? on.textContent.replace(/\s*\(\d+\)\s*$/, "") : "Menu";
  }
  function buildItems() {
    if (!tabs) return;
    list.innerHTML = "";
    [].forEach.call(tabs.querySelectorAll("button"), function (b) {
      var i = document.createElement("button");
      i.type = "button"; i.className = "navitem" + (b.classList.contains("on") ? " on" : "");
      i.textContent = b.textContent;
      i.onclick = function () { close(); b.click(); window.scrollTo(0, 0); };
      list.appendChild(i);
    });
    var foot = drawer.querySelector(".navfoot"); foot.innerHTML = "";
    var admin = document.getElementById("adminLink");
    if (admin && !admin.hidden) { var a = document.createElement("a"); a.href = admin.getAttribute("href"); a.className = "navitem"; a.textContent = admin.textContent.replace(/^\s*\u2190\s*/, "\u2190 "); foot.appendChild(a); }
    var out = document.getElementById("out");
    if (out) { var o = document.createElement("button"); o.type = "button"; o.className = "navitem out"; o.textContent = "Sign out"; o.onclick = function () { close(); out.click(); }; foot.appendChild(o); }
  }
  function open() {
    buildItems(); lastFocus = document.activeElement;
    drawer.hidden = false; scrim.hidden = false;
    requestAnimationFrame(function () { drawer.classList.add("open"); scrim.classList.add("open"); });
    body.classList.add("nav-open"); btn.setAttribute("aria-expanded", "true");
    var f = drawer.querySelector(".navitem.on, .navitem, a, button"); if (f) f.focus();
  }
  function close() {
    drawer.classList.remove("open"); scrim.classList.remove("open"); body.classList.remove("nav-open");
    btn.setAttribute("aria-expanded", "false");
    setTimeout(function () { if (!drawer.classList.contains("open")) { scrim.hidden = true; if (tabs) drawer.hidden = true; } }, 200);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  btn.onclick = function () { drawer.classList.contains("open") ? close() : open(); };
  scrim.onclick = close;
  drawer.addEventListener("click", function (e) { if (e.target.closest(".navclose")) close(); if (!tabs && e.target.closest("nav a")) close(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && drawer.classList.contains("open")) close(); });
  window.matchMedia("(min-width:761px)").addEventListener("change", function (e) { if (e.matches && drawer.classList.contains("open")) close(); });

  /* header scrolled out of view -> CSS floats the menu button so it stays reachable */
  var ticking = false;
  function onScroll() { if (ticking) return; ticking = true; requestAnimationFrame(function () { ticking = false; body.classList.toggle("scrolled", window.scrollY > 70); }); }
  window.addEventListener("scroll", onScroll, { passive: true }); onScroll();

  /* IT Admin: show the school name and the signed-in user right under the menu button (they live in the drawer otherwise) */
  if (side) {
    var sch = document.getElementById("school"), who = document.getElementById("who");
    var ms = document.createElement("small"); ms.className = "mobschool"; ms.hidden = true;
    var mw = document.createElement("div"); mw.className = "mobwho"; mw.hidden = true;
    var h1 = top.querySelector("h1"); top.insertBefore(ms, h1); top.insertBefore(mw, h1);
    var copy = function () {
      ms.textContent = sch ? sch.textContent.trim() : ""; ms.hidden = !ms.textContent;
      mw.textContent = who ? who.textContent.trim() : ""; mw.hidden = !mw.textContent;
    };
    var mo = new MutationObserver(copy);
    [sch, who].forEach(function (n) { if (n) mo.observe(n, { childList: true, characterData: true, subtree: true }); });
    copy();
  }

  /* keep the button label in step with the active tab, and hide the whole menu while the tabs are hidden (student exam room) */
  function sync() {
    var has = !tabs || !tabs.hidden;
    body.classList.toggle("has-nav", has);
    btn.hidden = !has;
    btn.setAttribute("aria-label", "Open menu" + (tabs ? " (now on " + currentLabel() + ")" : ""));
    btn.title = "Menu";
  }
  if (tabs) new MutationObserver(sync).observe(tabs, { attributes: true, attributeFilter: ["class", "hidden"], childList: true, subtree: true, characterData: true });
  sync();
})();
