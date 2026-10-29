// Module files are stored in ~600 KB pieces; the server keeps the pieces in Google Drive.
import { doc, getDoc } from "./db.js";
export const CHUNK = 600 * 1024, MAX_BYTES = 8 * 1024 * 1024;
export const sizeText = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
export const b64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
export const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

/** Open a link module, or rebuild an uploaded file from its pieces and save it. */
export async function openModule(db, m) {
  if (m.kind === "link") { const u = safeUrl(m.url); if (u) window.open(u, "_blank", "noopener"); return; }
  // all pieces are asked for at once (the db layer sends them in one request)
  const snaps = await Promise.all(Array.from({ length: m.chunks }, (_, i) => getDoc(doc(db, "moduleChunks", `${m.id}_${i}`))));
  const parts = snaps.map((s) => {
    const bin = atob(s.data().data), a = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) a[k] = bin.charCodeAt(k);
    return a;
  });
  const url = URL.createObjectURL(new Blob(parts, { type: m.mime || "application/octet-stream" }));
  const a = document.createElement("a"); a.href = url; a.download = m.fileName || m.title; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
