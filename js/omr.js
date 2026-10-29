// Pure helpers shared by the answer-sheet printer, the scanner and the results page.
// No DOM and no Firebase in here, so it can be tested in Node.

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- item types ---------- */
export const TYPES = {
  mc: "Multiple choice (A-E)",
  tf: "True or False",
  ident: "Identification (teacher checks)",
  essay: "Essay (teacher checks)",
};
export const TYPE_SHORT = { mc: "Multiple choice", tf: "True/False", ident: "Identification", essay: "Essay" };
/** Multiple choice and True/False are read by the scanner. Identification and essay are checked by the teacher. */
export const isAuto = (t) => t === "mc" || t === "tf";

/** Exams made before this version only had a `key` array: treat them as all multiple choice. */
export function itemsOf(ex) {
  if (Array.isArray(ex.items) && ex.items.length)
    return ex.items.map((x) => ({ type: x.type || "mc", key: x.key || "", pts: +x.pts > 0 ? +x.pts : 1, q: x.q || "", opts: Array.isArray(x.opts) ? x.opts : [] }));
  return (ex.key || []).map((k) => ({ type: "mc", key: k, pts: 1, q: "", opts: [] }));
}
/** The bubbles an item has, in print order. */
export const lettersOf = (item, ex) =>
  item.type === "tf" ? ["T", "F"] : "ABCDE".slice(0, +ex.choices || 5).split("");

/* ---------- sheet geometry ----------
   One sheet is HALF of an 8.5 x 13 in landscape page: 6.5 x 8.5 in portrait (165.1 x 215.9 mm).
   Units below are millimetres. Printing and scanning both use these numbers. */
export const PAGE = { w: 165.1, h: 215.9 };
export const G = {
  mk: [[9, 9], [156.1, 9], [9, 206.9], [156.1, 206.9]], // corner squares: TL, TR, BL, BR (centres)
  mkSize: 8,
};
export const MAX_ITEMS = 100;

/** The bubble grid FITS THE PAPER: bubble size, spacing and number of columns are chosen from the number of items.
 *  Few items = big, easy-to-see bubbles. Many items = smaller bubbles in more columns. Printing and scanning both call this. */
export function layout(n) {
  const top = 72, bottom = 201, left = 14, right = 151, labelW = 7;
  let best = null;
  for (let cols = 1; cols <= 5; cols++) {
    const rows = Math.max(1, Math.ceil(n / cols)), colW = (right - left) / cols, rowMax = (bottom - top) / rows;
    const r = Math.min(rowMax / 2.5, (colW - labelW - 2) / 14, 3.4);
    if (!best || r > best.r + 0.05) best = { cols, rows, colW, r, rowMax };
  }
  const { cols, rows, colW, r, rowMax } = best, pitch = 3 * r, rowH = Math.min(rowMax, r * 3.6);
  return { cols, rows, colW, r, pitch, rowH, left, top, labelW,
    pos: (i, j) => [left + Math.floor(i / rows) * colW + labelW + r + j * pitch, top + (i % rows) * rowH] };
}

/* ---------- grading periods ---------- */
export const TERMS = ["1st Quarter", "2nd Quarter", "3rd Quarter", "4th Quarter", "1st Term", "2nd Term", "3rd Term"];
export const termRank = (t) => { const i = TERMS.indexOf(t); return i < 0 ? 99 : i; };

/** One answer sheet as SVG. `o.student` = {name, number, className} prints a named sheet. */
export function sheetSVG(ex, o = {}) {
  const items = itemsOf(ex), st = o.student, cx = PAGE.w / 2;
  const total = items.reduce((a, b) => a + b.pts, 0);
  const T = (x, y, s, t, a = "start", w = 400, fill = "#000") =>
    `<text x="${x}" y="${y}" font-size="${s}" text-anchor="${a}" font-weight="${w}" fill="${fill}">${esc(t)}</text>`;
  const Ln = (x1, y1, x2, y2, w = 0.3) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="${w}"/>`;
  let s = `<svg viewBox="0 0 ${PAGE.w} ${PAGE.h}" xmlns="http://www.w3.org/2000/svg" font-family="Arial,Helvetica,sans-serif"><rect width="${PAGE.w}" height="${PAGE.h}" fill="#fff"/>`;
  G.mk.forEach(([x, y]) => (s += `<rect x="${x - G.mkSize / 2}" y="${y - G.mkSize / 2}" width="${G.mkSize}" height="${G.mkSize}"/>`));

  s += T(cx, 17, 5, o.school || "School name", "middle", 700) + T(cx, 23, 3.8, ex.title, "middle", 700);
  s += T(14, 31, 3, "Subject: " + (ex.subject || "")) + T(88, 31, 3, "Date: " + (ex.date || "____________"));
  // Name (pre-printed for named sheets)
  s += T(14, 39, 3, "Name:") + Ln(26, 39.6, 84, 39.6);
  if (st) s += T(27, 38.6, st.name.length > 30 ? 2.8 : 3.6, st.name, "start", 700);
  // Exam ID No. box
  s += T(88, 39, 3, "Exam ID No.:") + `<rect x="112" y="34.4" width="39" height="7" fill="none" stroke="#000" stroke-width=".35"/>`;
  if (st) s += T(131.5, 39.4, 3.8, st.number, "middle", 700);
  // Section and teacher
  const sec = st ? st.className : ex.className && ex.className !== "All sections" ? ex.className : "";
  s += T(14, 47, 3, "Section:") + (sec ? T(30, 47, 3.2, sec, "start", 700) : Ln(30, 47.6, 84, 47.6));
  s += T(88, 47, 3, "Teacher:") + (o.teacher ? T(103, 47, 3.2, o.teacher, "start", 700) : Ln(103, 47.6, 151, 47.6));
  s += T(14, 54, 3, `Items: ${items.length}    Total points: ${total}`) + T(88, 54, 3, `Score: ________ / ${total}`);
  s += T(14, 59.5, 2.3, "Shade ONE bubble completely for each number. Do not fold, stain or write on the black squares.", "start", 400, "#333");
  s += T(14, 63, 2.3, "Identification: write the answer on the line.  Essay: write on separate paper. Your teacher checks these.", "start", 400, "#333");
  s += Ln(14, 66, 151, 66, 0.2);

  const lay = layout(items.length), nf = Math.min(4, Math.max(2.4, lay.r * 1.3)), lf = Math.max(1.6, lay.r * 0.95);
  items.forEach((it, i) => {
    const [x1, y] = lay.pos(i, 0), colEnd = lay.left + (Math.floor(i / lay.rows) + 1) * lay.colW - 3;
    s += T(x1 - lay.r - 1.2, y + nf * 0.35, nf, i + 1, "end");
    if (it.type === "mc" || it.type === "tf") {
      lettersOf(it, ex).forEach((l, j) => {
        const [x] = lay.pos(i, j);
        s += `<circle cx="${x}" cy="${y}" r="${lay.r}" fill="none" stroke="#000" stroke-width=".3"/>` + T(x, y + lf * 0.35, lf, l, "middle", 400, "#777");
      });
    } else if (it.type === "ident") s += Ln(x1 - lay.r, y + lay.r * 0.7, colEnd, y + lay.r * 0.7);
    else s += T(x1 - lay.r, y + lf * 0.35, Math.min(2.3, lf + 0.4), "Essay - separate paper", "start", 400, "#555");
  });
  return s + "</svg>";
}

/* ---------- scanner ---------- */
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const EXPECT = (G.mk[2][1] - G.mk[0][1]) / (G.mk[1][0] - G.mk[0][0]); // sheet height / width, measured between the corner squares

/** Finds the four black corner squares ANYWHERE in the picture (the sheet no longer has to fill the frame).
 *  g = grayscale pixels, w x h. Returns { pts: [TL, TR, BL, BR] (pixel centres), cover } or { err, seen } where
 *  `seen` = how many square-looking blobs were found (used for the on-screen hint).
 *  Uses a LOCAL threshold, so shadows and uneven light on the paper do not hide the squares. */
export function findCorners(g, w, h) {
  const big = Math.max(w, h), half = Math.max(8, Math.round(big * 0.05));
  // integral image -> local mean in a (2*half+1) square window
  const W1 = w + 1, I = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row; } }
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(h, y + half + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(w, x + half + 1);
      const m = (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0)), v = g[y * w + x];
      if (v < m * 0.72 && m - v > 24) mask[y * w + x] = 1;
    }
  }
  // connected dark blobs that look like a solid square
  const seen = new Uint8Array(w * h), stack = new Int32Array(w * h), cand = [];
  const maxSide = big * 0.2, minSide = Math.max(5, big * 0.008);
  for (let i0 = 0; i0 < w * h; i0++) {
    if (!mask[i0] || seen[i0]) continue;
    let sp = 0, a = 0, sx = 0, sy = 0, mnx = w, mxx = 0, mny = h, mxy = 0;
    stack[sp++] = i0; seen[i0] = 1;
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i - x) / w; a++; sx += x; sy += y;
      if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[sp++] = i - w; }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[sp++] = i + w; }
    }
    const bw = mxx - mnx + 1, bh = mxy - mny + 1;
    if (bw < minSide || bh < minSide || bw > maxSide || bh > maxSide) continue;
    if (mnx === 0 || mny === 0 || mxx === w - 1 || mxy === h - 1) continue;      // cut off by the edge of the picture
    if (bw / bh < 0.6 || bw / bh > 1.67 || a / (bw * bh) < 0.85) continue;        // not a solid square (a shaded bubble is a circle: about 0.78)
    cand.push({ x: sx / a, y: sy / a, a });
  }
  cand.sort((p, q) => q.a - p.a); cand.length = Math.min(cand.length, 36);
  // choose the 4 that form a sheet-shaped rectangle: TL, TR, BL, then BR where it should be
  let best = null;
  for (const A of cand) for (const B of cand) {
    const dx = B.x - A.x; if (dx < big * 0.08 || Math.abs(B.y - A.y) > 0.35 * dx) continue;
    for (const C of cand) {
      if (C === A || C === B) continue;
      const dy = C.y - A.y; if (dy <= 0 || Math.abs(C.x - A.x) > 0.35 * dy) continue;
      const ab = Math.hypot(dx, B.y - A.y), ac = Math.hypot(C.x - A.x, dy), r = ac / ab;
      if (r < EXPECT * 0.78 || r > EXPECT * 1.28) continue;
      const px = B.x + C.x - A.x, py = B.y + C.y - A.y;
      for (const D of cand) {
        if (D === A || D === B || D === C) continue;
        const err = Math.hypot(D.x - px, D.y - py) / ab; if (err > 0.22) continue;
        const aMin = Math.min(A.a, B.a, C.a, D.a), aMax = Math.max(A.a, B.a, C.a, D.a); if (aMax > aMin * 3.2) continue;
        // the squares must be the size they are printed at (8 mm) relative to the sheet: this rejects shaded bubbles and stray dark objects
        const side = Math.sqrt((A.a + B.a + C.a + D.a) / 4), want = G.mkSize * ab / (G.mk[1][0] - G.mk[0][0]);
        if (side < want * 0.65 || side > want * 1.4) continue;
        const area = ab * ac, score = -area * (1 - 2.5 * err);   // the biggest well-formed rectangle wins
        if (!best || score < best.score) best = { score, pts: [[A.x, A.y], [B.x, B.y], [C.x, C.y], [D.x, D.y]], area };
      }
    }
  }
  if (!best) return { err: "Could not find all 4 corner squares. Keep the whole sheet in view (one sheet only), flat, upright and well lit.", seen: cand.length };
  return { pts: best.pts, cover: best.area / (w * h) };
}

/** Decides WHEN to take the picture. Feed it one detection per camera frame (findCorners result or null).
 *  It says "ready" once the whole sheet has been in view, big enough and holding still for `holdMs`. Pure (no DOM), so it can be tested. */
export class SheetTracker {
  constructor({ holdMs = 800, minFrames = 4, minCover = 0.25, tol = 0.015 } = {}) { Object.assign(this, { holdMs, minFrames, minCover, tol }); this.reset(); }
  reset() { this.anchor = null; this.since = 0; this.frames = 0; }
  /** state: none (no sheet) | far (sheet found but too small) | moving | steady (counting down) | ready */
  update(det, w, h, now) {
    if (!det || !det.pts) { this.reset(); return { state: "none", progress: 0, seen: det?.seen || 0 }; }
    const pts = det.pts, diag = Math.hypot(w, h);
    if (det.cover < this.minCover) { this.reset(); return { state: "far", progress: 0, pts }; }
    const drift = this.anchor ? Math.max(...pts.map((p, i) => dist(p, this.anchor[i]))) / diag : 1;
    if (drift > this.tol) { this.anchor = pts; this.since = now; this.frames = 1; return { state: "moving", progress: 0, pts }; }
    this.frames++;
    const progress = Math.min(1, (now - this.since) / this.holdMs, this.frames / this.minFrames);
    return { state: progress >= 1 ? "ready" : "steady", progress, pts };
  }
}

/** g = grayscale pixels, w x h. ctx (optional) gets red debug circles. Returns {answers, flags} or {err}. */
export function scanSheet(g, w, h, ex, ctx) {
  const items = itemsOf(ex), lay = layout(items.length);
  const found = findCorners(g, w, h);
  if (found.err) return { err: found.err };
  const pts = found.pts;
  const exp = EXPECT, ratio = dist(pts[0], pts[2]) / dist(pts[0], pts[1]);
  if (ratio < exp * 0.8 || ratio > exp * 1.25) return { err: "The sheet looks rotated or badly angled. Hold it upright (portrait) and try again." };

  // Homography: sheet millimetres -> image pixels
  const A = [];
  G.mk.forEach(([sx, sy], i) => { const [ix, iy] = pts[i];
    A.push([sx, sy, 1, 0, 0, 0, -ix * sx, -ix * sy, ix], [0, 0, 0, sx, sy, 1, -iy * sx, -iy * sy, iy]); });
  for (let c = 0; c < 8; c++) {
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r; [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k]; }
  }
  const H = A.map((r, i) => r[8] / r[i]);
  const map = (x, y) => { const q = H[6] * x + H[7] * y + 1; return [(H[0] * x + H[1] * y + H[2]) / q, (H[3] * x + H[4] * y + H[5]) / q]; };
  const sc = dist(pts[0], pts[1]) / (G.mk[1][0] - G.mk[0][0]); // pixels per mm
  const mean = (x, y, r) => {
    let s = 0, n = 0;
    for (let yy = Math.floor(y - r); yy <= y + r; yy++) for (let xx = Math.floor(x - r); xx <= x + r; xx++)
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && (xx - x) ** 2 + (yy - y) ** 2 <= r * r) { s += g[yy * w + xx]; n++; }
    return n ? s / n : 255;
  };
  const black = pts.reduce((s, p) => s + mean(p[0], p[1], 2), 0) / 4;
  if (ctx) { ctx.strokeStyle = "#e11"; ctx.lineWidth = 1; }
  const answers = [], flags = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.type !== "mc" && it.type !== "tf") { answers.push(""); flags.push(false); continue; } // teacher checks these
    const letters = lettersOf(it, ex), xy = letters.map((_, j) => lay.pos(i, j));
    const gaps = xy.slice(0, -1).map(([x, y]) => mean(...map(x + lay.pitch / 2, y), Math.min(1.0, 0.4 * lay.r) * sc));
    const paper = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (paper - black < 40) return { err: "Not enough contrast. Use better, even lighting and a darker pencil or pen." };
    const rd = Math.min(1.5, lay.r * 0.62);
    const raw = xy.map(([x, y]) => {
      const [px, py] = map(x, y);
      if (ctx) { ctx.beginPath(); ctx.arc(px, py, rd * sc, 0, 7); ctx.stroke(); }
      return Math.min(1, Math.max(0, (paper - mean(px, py, rd * sc)) / (paper - black)));
    });
    // The small printed letter inside each bubble adds a little ink to every bubble: remove that common baseline.
    const base = Math.min(Math.min(...raw), 0.3), fill = raw.map((v) => Math.max(0, (v - base) / (1 - base)));
    const on = fill.map((v, j) => (v > 0.5 ? j : -1)).filter((j) => j >= 0);
    answers.push(on.length === 0 ? "" : on.length > 1 ? "*" : letters[on[0]]);
    flags.push(on.length > 1 || fill.some((v) => v > 0.25 && v <= 0.5));
  }
  return { answers, flags };
}

/** Identification answers: ignore case, accents, punctuation and extra spaces. The teacher may list several accepted answers separated by | . */
export const normText = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
export const identMatches = (item, text) => !!(item.type === "ident" && item.key && normText(text) && String(item.key).split("|").some((k) => normText(k) && normText(k) === normText(text)));

/* ---------- scoring ----------
   answers[i]: "" blank, "*" more than one bubble, or the letter.
   manual[i]: points awarded by the teacher for identification/essay items, or null = not checked yet. */
export function score(ex, answers = [], manual = []) {
  const items = itemsOf(ex);
  let points = 0, max = 0, correct = 0, wrong = 0, blank = 0, multi = 0, pending = 0; const missed = [];
  items.forEach((it, i) => {
    const p = it.pts; max += p; const a = answers[i] ?? "";
    if (it.type === "mc" || it.type === "tf") {
      if (a === it.key) { points += p; correct++; return; }
      if (a === "") blank++; else if (a === "*") multi++; else wrong++;
      missed.push({ i, type: it.type, given: a, key: it.key, pts: p, awarded: 0 });
    } else {
      const m = manual[i];
      if (m === null || m === undefined || m === "") { pending++; return; }
      const v = Math.min(p, Math.max(0, +m)); points += v;
      if (v >= p) correct++; else { wrong++; missed.push({ i, type: it.type, given: "", key: "", pts: p, awarded: v }); }
    }
  });
  const pct = max ? Math.round((points / max) * 1000) / 10 : 0;
  return { correct, wrong, blank, multi, pending, total: items.length, points, maxPoints: max, pct, final: pending === 0, pass: pending === 0 && pct >= (ex.passing || 75), missed };
}
/** Short text for one missed item, e.g. "#3 B>C", "#7 blank>A", "#21 0/2". */
export function missedText(m, hideKey) {
  if (m.type === "mc" || m.type === "tf") return hideKey ? `#${m.i + 1}` : `#${m.i + 1} ${m.given === "" ? "blank" : m.given === "*" ? "multi" : m.given} → ${m.key}`;
  return `#${m.i + 1} ${m.awarded}/${m.pts}`;
}
