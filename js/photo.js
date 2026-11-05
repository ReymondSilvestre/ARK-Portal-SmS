/* Shared 2x2 photo cropper (drag to centre the face, zoom, shrink to fit one spreadsheet cell). Resolves a data URL, or null when cancelled. */
export function squarePhoto(file) {
  return new Promise((ok, no) => {
    if (!/^image\//.test(file.type)) return no(new Error("Choose a picture file (JPG or PNG)."));
    const url = URL.createObjectURL(file), im = new Image();
    im.onerror = () => { URL.revokeObjectURL(url); no(new Error("That picture could not be read.")); };
    im.onload = () => {
      const V = 260, base = V / Math.min(im.width, im.height);   // the picture just covers the square at zoom 1
      let zoom = 1, x = 0, y = 0;                                  // x, y: where the picture's top-left corner sits in the square
      const sc = () => base * zoom;
      const clamp = () => { x = Math.min(0, Math.max(V - im.width * sc(), x)); y = Math.min(0, Math.max(V - im.height * sc(), y)); };
      const el = document.createElement("div"); el.className = "lv-pop"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
      el.innerHTML = `<div class="lv-pop-box"><h3>Position the photo</h3><p class="muted">Drag the picture to center the face inside the circle. Use the slider to zoom.</p>
        <div class="crop-view" id="cpView"><img id="cpImg" alt="" draggable="false"><div class="crop-ring"></div></div>
        <label>Zoom<input type="range" id="cpZoom" min="1" max="4" step="0.01" value="1"></label>
        <div class="lv-pop-btns"><button type="button" class="btn" id="cpCancel">Cancel</button><button type="button" class="btn" id="cpReset">Center</button><button type="button" class="btn primary" id="cpOk">Use photo</button></div></div>`;
      document.body.append(el);
      const img = el.querySelector("#cpImg"), view = el.querySelector("#cpView"), zr = el.querySelector("#cpZoom"); img.src = url;
      const draw = () => { clamp(); img.style.width = im.width * sc() + "px"; img.style.height = im.height * sc() + "px"; img.style.transform = `translate(${x}px,${y}px)`; };
      const center = () => { zoom = 1; zr.value = 1; x = (V - im.width * sc()) / 2; y = (V - im.height * sc()) / 2; draw(); };
      const setZoom = (z) => { const o = sc(), cx = (V / 2 - x) / o, cy = (V / 2 - y) / o; zoom = Math.min(4, Math.max(1, z)); zr.value = zoom; x = V / 2 - cx * sc(); y = V / 2 - cy * sc(); draw(); };
      let drag = null;
      view.addEventListener("pointerdown", (e) => { drag = { px: e.clientX, py: e.clientY, x, y }; view.setPointerCapture(e.pointerId); view.classList.add("grab"); });
      view.addEventListener("pointermove", (e) => { if (!drag) return; x = drag.x + e.clientX - drag.px; y = drag.y + e.clientY - drag.py; draw(); });
      const end = () => { drag = null; view.classList.remove("grab"); };
      view.addEventListener("pointerup", end); view.addEventListener("pointercancel", end);
      view.addEventListener("wheel", (e) => { e.preventDefault(); setZoom(zoom + (e.deltaY < 0 ? 0.1 : -0.1)); }, { passive: false });
      zr.oninput = () => setZoom(+zr.value);
      const close = (v) => { removeEventListener("keydown", key); el.remove(); URL.revokeObjectURL(url); ok(v); };
      const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(null); } };
      addEventListener("keydown", key);
      el.querySelector("#cpCancel").onclick = () => close(null);
      el.querySelector("#cpReset").onclick = center;
      el.querySelector("#cpOk").onclick = () => {
        const s0 = V / sc(), sx = -x / sc(), sy = -y / sc(), c = document.createElement("canvas"); let size = 240, q = 0.85, out = "";
        for (let i = 0; i < 12; i++) { c.width = c.height = size; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, size, size); g.drawImage(im, sx, sy, s0, s0, 0, 0, size, size); out = c.toDataURL("image/jpeg", q); if (out.length <= 18000) break; q > 0.5 ? (q -= 0.1) : (size = Math.round(size * 0.85)); }
        if (out.length > 19000) { el.remove(); URL.revokeObjectURL(url); return no(new Error("The picture is too detailed. Try another one.")); }
        close(out);
      };
      center(); el.querySelector("#cpOk").focus();
    };
    im.src = url;
  });
}
