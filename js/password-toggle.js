/* Adds a "Show / Hide" button to every password box on the page.
   Plain script (not a module): include with <script src="js/password-toggle.js"></script> */
(function () {
  function enhance(input) {
    if (input.dataset.pwToggle) return;
    input.dataset.pwToggle = "1";
    var wrap = document.createElement("span");
    wrap.className = "pw-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pw-toggle";
    btn.textContent = "Show";
    btn.setAttribute("aria-label", "Show password");
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", function () {
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Hide" : "Show";
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      btn.setAttribute("aria-pressed", String(show));
      input.focus();
    });
    wrap.appendChild(btn);
    /* always go back to hidden after the form is submitted */
    if (input.form) input.form.addEventListener("submit", function () {
      input.type = "password"; btn.textContent = "Show"; btn.setAttribute("aria-pressed", "false");
    });
  }
  function run() { document.querySelectorAll('input[type="password"]').forEach(enhance); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();
