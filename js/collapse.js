/* Show / hide sections (plain script, not a module). Include with: <script src="js/collapse.js" defer></script>
   Every section heading (h2 / h3 / h4) inside a panel, card or form group gets a small Hide / Show button that folds
   everything under it, up to the next heading of the same or a higher level. A "Hide all / Show all" bar sits at the top of the page.
   Pages are drawn again by the page scripts, so the sections are watched and the buttons come back by themselves;
   what you folded is remembered (for this page, until the tab is closed) and is never changed by a redraw. Printing always shows everything. */
(function () {
  "use strict";
  var HEAD = "H2,H3,H4", BOX = ".panel,.pr-card,.sc-card,.formgrp,section[data-s]";
  var SKIP = "dialog,[role=dialog],[role=alertdialog],.lv-pop,.side,.top,.tabs,.noprint-cx,[data-nocollapse]";
  var KEY = "arkcx:" + location.pathname, closed = {};
  try { closed = JSON.parse(sessionStorage.getItem(KEY) || "{}") || {}; } catch (e) { closed = {}; }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(closed)); } catch (e) { /* storage blocked: folds are simply not remembered */ } }
  var level = function (h) { return +h.tagName.charAt(1); };
  var isHead = function (n) { return n.nodeType === 1 && /^H[234]$/.test(n.tagName); };
  function nameOf(h, i) {            // a stable name for the section: its own text (without the button) and the position among equal names
    var c = h.cloneNode(true), b = c.querySelector(".cx-btn"); if (b) b.remove();
    var t = (c.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) || "section";
    return (h.closest("section[data-s]") ? h.closest("section[data-s]").getAttribute("data-s") : "") + "|" + t + "|" + i;
  }
  function range(h) {                // the elements this heading folds
    var out = [], n = h.nextElementSibling;
    while (n && !(isHead(n) && level(n) <= level(h))) { out.push(n); n = n.nextElementSibling; }
    return out;
  }
  function apply(h, shut) {
    h.classList.toggle("cx-shut", shut);
    var b = h.querySelector(".cx-btn");
    if (b) { b.setAttribute("aria-expanded", shut ? "false" : "true"); b.firstChild.nodeValue = shut ? "Show" : "Hide"; b.lastChild.textContent = shut ? "\u25B8" : "\u25BE"; }
    range(h).forEach(function (el) { if (shut) el.classList.add("cx-hid"); else if (!covered(el)) el.classList.remove("cx-hid"); });
  }
  function covered(el) {            // is el still under a folded heading? (walk back; a heading of the same or a higher level ends the range of the ones below it)
    var lim = 9, p = el.previousElementSibling;
    while (p) { if (isHead(p) && level(p) < lim) { if (p.classList.contains("cx-shut")) return true; lim = level(p); } p = p.previousElementSibling; }
    return false;
  }
  function decorate(root) {
    var heads = [].slice.call((root || document).querySelectorAll(".main " + HEAD.split(",").join(",.main ") + ",main " + HEAD.split(",").join(",main ")));
    var seen = {};
    heads.forEach(function (h) {
      if (h.closest(SKIP)) return;
      var par = h.parentElement; if (!par || !par.matches(BOX)) return;
      if (!h.nextElementSibling) return;                               // nothing under it to fold
      var nm = nameOf(h, 0); seen[nm] = (seen[nm] || 0) + 1; var key = nameOf(h, seen[nm] - 1);
      var had = h.querySelector(".cx-btn");
      if (!had) {
        var b = document.createElement("button"); b.type = "button"; b.className = "cx-btn noprint";
        b.appendChild(document.createTextNode("Hide")); var s = document.createElement("span"); s.setAttribute("aria-hidden", "true"); s.textContent = "\u25BE"; b.appendChild(s);
        b.title = "Show or hide this section"; h.appendChild(b); h.classList.add("cx-head");
      }
      h.dataset.cxKey = key;
      var want = !!closed[key], now = h.classList.contains("cx-shut");
      if (!had || want !== now) apply(h, want);
      else if (want) range(h).forEach(function (el) { el.classList.add("cx-hid"); });   // new content under a folded heading stays folded
    });
    bar();
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".cx-btn"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var h = b.closest(HEAD.toLowerCase().split(",").join(",")); if (!h) return;
    var shut = !h.classList.contains("cx-shut"); apply(h, shut);
    if (shut) closed[h.dataset.cxKey] = 1; else delete closed[h.dataset.cxKey]; save();
  }, true);
  function all(shut) {
    var hs = [].slice.call(document.querySelectorAll(".cx-head")).filter(function (h) { return !h.closest("[hidden]"); });   // only what this page shows now (not the other tabs)
    hs.forEach(function (h) { apply(h, shut); if (shut) closed[h.dataset.cxKey] = 1; else delete closed[h.dataset.cxKey]; });
    save();
  }
  function bar() {                   // one bar, above everything the page draws
    if (document.getElementById("cxBar")) return;
    var main = document.querySelector("main.main") || document.querySelector("main") || document.querySelector(".main"); if (!main) return;
    var d = document.createElement("div"); d.id = "cxBar"; d.className = "cx-bar noprint";
    d.innerHTML = '<span>Sections</span><button type="button" class="btn small" data-cx="open">Show all</button><button type="button" class="btn small" data-cx="shut">Hide all</button>';
    d.addEventListener("click", function (e) { var t = e.target.closest("[data-cx]"); if (t) all(t.dataset.cx === "shut"); });
    var anchor = main.querySelector(".tabs") || main.querySelector(".top") || main.firstElementChild;
    if (anchor && anchor.parentNode === main) anchor.insertAdjacentElement("afterend", d); else main.insertBefore(d, main.firstChild);
  }
  var timer = 0, busy = false;
  function later() { if (busy || timer) return; timer = setTimeout(function () { timer = 0; busy = true; try { decorate(); } finally { busy = false; } }, 60); }
  function start() { decorate(); new MutationObserver(function (m) { if (!busy && m.some(function (r) { return r.type === "childList" && [].some.call(r.addedNodes, function (n) { return n.nodeType === 1 && !(n.classList && n.classList.contains("cx-btn")); }); })) later(); }).observe(document.body, { childList: true, subtree: true }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
