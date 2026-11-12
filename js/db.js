/* Database + sign-in client for the Google Sheets backend (Apps Script).
   It offers the same calls the pages used with Firestore (doc, collection, query, where, getDoc, getDocs,
   setDoc, updateDoc, deleteDoc, addDoc, writeBatch, serverTimestamp, deleteField, getCountFromServer),
   so the page code stays almost unchanged. Every call is sent to the Apps Script web app, which checks
   the signed-in person and the security rules before touching the spreadsheet. */
import { API_URL } from "./config.js";

/* ---------- session (kept in this browser only) ---------- */
const SKEY = "ark.session";
export const getSession = () => { try { const s = JSON.parse(localStorage.getItem(SKEY) || "null"); if (s && s.token && s.exp > Date.now()) return s; } catch { } return null; };
export const setSession = (s) => { try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch { } };
export const clearSession = () => { try { localStorage.removeItem(SKEY); sessionStorage.removeItem("ark.me"); } catch { } try { memo.clear(); } catch { } };

/* ---------- values ---------- */
export class Timestamp {
  constructor(ms) { this._ms = ms; }
  get seconds() { return Math.floor(this._ms / 1000); }
  get nanoseconds() { return (this._ms % 1000) * 1e6; }
  toDate() { return new Date(this._ms); }
  toMillis() { return this._ms; }
  static now() { return new Timestamp(Date.now()); }
  static fromMillis(ms) { return new Timestamp(ms); }
  static fromDate(d) { return new Timestamp(d.getTime()); }
}
export const serverTimestamp = () => ({ __sv: "ts" });
export const deleteField = () => ({ __sv: "del" });
const encode = (v) => {
  if (v instanceof Timestamp) return { __ts: v._ms };
  if (v instanceof Date) return { __ts: v.getTime() };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = encode(v[k]); return o; }
  return v;
};
export const decode = (v) => {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === "object") {
    if (typeof v.__ts === "number" && Object.keys(v).length === 1) return new Timestamp(v.__ts);
    const o = {}; for (const k of Object.keys(v)) o[k] = decode(v[k]); return o;
  }
  return v;
};

/* ---------- transport ---------- */
const err = (e) => Object.assign(new Error((e && e.message) || "Something went wrong."), { code: (e && e.code) || "internal" });
async function post(obj) {
  if (!API_URL || API_URL.startsWith("PASTE_")) throw err({ code: "config", message: "The site is not connected yet: open js/config.js and paste your Apps Script Web app URL." });
  let text;
  try {
    const r = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(obj), redirect: "follow" });
    text = await r.text();
  } catch { throw err({ code: "auth/network-request-failed", message: "No connection. Check your internet and try again." }); }
  try { return JSON.parse(text); } catch { throw err({ code: "unavailable", message: "The server is busy. Please try again in a moment." }); }
}

/* ---------- loading / saving animation ----------
   A thin moving bar at the top shows while anything is loading. While something is being SAVED (or an account action runs) a centered
   "Saving..." card with a spinner also appears, so nobody presses the button twice. Short requests (under 0.25 s) show nothing at all. */
const BUSY = { read: 0, write: 0, tRead: null, tWrite: null, el: null };
function busyUI() {
  if (BUSY.el || typeof document === "undefined" || !document.body) return BUSY.el;
  const el = document.createElement("div"); el.id = "ark-busy"; el.setAttribute("aria-live", "polite");
  el.innerHTML = '<div class="ab-bar"></div><div class="ab-chip" hidden><i class="ab-spin"></i><span>Loading...</span></div><div class="ab-veil" hidden><div class="ab-card"><i class="ab-spin big"></i><b>Saving...</b><small>Please wait, do not close this page.</small></div></div>';
  document.body.append(el); return (BUSY.el = el);
}
function busyShow() {
  const el = busyUI(); if (!el) return;
  const bar = el.querySelector(".ab-bar"), chip = el.querySelector(".ab-chip"), veil = el.querySelector(".ab-veil");
  bar.classList.toggle("on", BUSY.read + BUSY.write > 0);
  chip.hidden = !(BUSY.read > 0 && BUSY.write === 0 && BUSY.chipOn);
  veil.hidden = !(BUSY.write > 0 && BUSY.veilOn);
}
function busyStart(kind) {
  if (kind === "write") { BUSY.write++; if (!BUSY.tWrite) BUSY.tWrite = setTimeout(() => { BUSY.veilOn = true; busyShow(); }, 250); }
  else { BUSY.read++; if (!BUSY.tRead) BUSY.tRead = setTimeout(() => { BUSY.chipOn = true; busyShow(); }, 400); }
  busyShow();
}
function busyEnd(kind) {
  if (kind === "write") { BUSY.write = Math.max(0, BUSY.write - 1); if (!BUSY.write) { clearTimeout(BUSY.tWrite); BUSY.tWrite = null; BUSY.veilOn = false; } }
  else { BUSY.read = Math.max(0, BUSY.read - 1); if (!BUSY.read) { clearTimeout(BUSY.tRead); BUSY.tRead = null; BUSY.chipOn = false; } }
  busyShow();
}
const busyKind = (c) => (c && (c.k === "batch" || c.k === "fn") ? "write" : "read");
const track = (kind, p) => { busyStart(kind); return p.finally(() => busyEnd(kind)); };

/** Calls that do not need a sign-in (login, password reset). */
export async function rpc(action, payload = {}) {
  const r = await track("read", post({ action, ...payload }));
  if (!r.ok) throw err(r.error);
  return r.data;
}
/* Calls made in the same moment are sent together in ONE request (fewer round trips = faster pages). */
let queue = [], timer = null;
const enqueue = (call) => track(busyKind(call), new Promise((resolve, reject) => { queue.push({ call, resolve, reject }); if (!timer) timer = setTimeout(flush, 6); }));
async function flush() {
  const batch = queue; queue = []; timer = null;
  const s = getSession();
  const readOnly = batch.every((b) => ["get", "list", "count", "me"].includes(b.call.k));
  let res;
  try {
    try { res = await post({ action: "multi", token: s && s.token, calls: batch.map((b) => b.call) }); }
    catch (e) { if (!readOnly || e.code === "config") throw e; res = await post({ action: "multi", token: s && s.token, calls: batch.map((b) => b.call) }); }
  } catch (e) { batch.forEach((b) => b.reject(e)); return; }
  if (!res.ok) {
    if (res.error && res.error.code === "unauthenticated") { clearSession(); if (!/\/login(\.html)?\/?$/.test(location.pathname)) location.href = "login"; }
    batch.forEach((b) => b.reject(err(res.error))); return;
  }
  res.results.forEach((r, i) => (r.ok ? batch[i].resolve(r.data) : batch[i].reject(err(r.error))));
}
/* ---------- faster pages: remember reads for a few seconds ----------
   The same list asked twice within READ_TTL (switching tabs, re-opening a screen) is answered from memory instead of a new 1-3 second trip to Google.
   Any save made from THIS browser forgets the remembered lists of the collections it touched (everything, for account actions), so what you just saved is always shown.
   Answers are kept as plain data and decoded for every caller, so a page can change what it receives without affecting anyone else. */
const READ_TTL = 90000, READS = { get: 1, list: 1, count: 1 };   // long is safe now: live updates (below) drop a remembered list the moment anybody changes it
const memo = new Map();                       // key -> { exp, coll, p }
export const forgetReads = (coll) => { if (!coll) memo.clear(); else for (const [k, v] of memo) if (v.coll === coll) memo.delete(k); };
export const call = (c) => {
  if (c.k === "batch") { const colls = new Set((c.ops || []).map((o) => o.coll)); colls.forEach(forgetReads); return enqueue(c).then((r) => { if (r && r.v) absorbVersions(r.v); return r; }).finally(() => colls.forEach(forgetReads)); }
  if (c.k === "fn") return enqueue(c).finally(() => forgetReads());
  if (!READS[c.k]) return enqueue(c);
  const key = JSON.stringify(c), hit = memo.get(key);
  if (hit && hit.exp > Date.now()) return hit.p;
  const p = enqueue(c); memo.set(key, { exp: Date.now() + READ_TTL, coll: c.coll, p });
  p.catch(() => memo.delete(key));
  return p;
};
/** Wakes the server up (Google puts an idle script to sleep; the first request after a pause is the slow one). Called while the sign-in form is still being filled in. */
export const warmUp = () => { try { post({ action: "ping" }).catch(() => {}); } catch { } };
/** Server-side actions (create an account, set a password, delete a school ...). */
export const callFn = (name, data) => enqueue({ k: "fn", name, data: data || {} });
// Same shape as the Cloud Functions the pages used before.
export const getFunctions = () => ({});
export const httpsCallable = (_f, name) => (data) => callFn(name, data).then((d) => ({ data: d }));

/* ---------- Firestore-style API ---------- */
export const db = { __sheets: true };
const autoId = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), (n) => "abcdefghijklmnopqrstuvwxyz0123456789"[n % 36]).join("");
export const collection = (_db, name) => ({ type: "col", coll: name, path: name });
export function doc(a, b, c) {
  if (a && a.type === "col") { const id = b || autoId(); return { type: "doc", coll: a.coll, id, path: a.coll + "/" + id }; }
  return { type: "doc", coll: b, id: c, path: b + "/" + c };
}
export const where = (field, op, value) => ({ t: "where", field, op, value });
export const orderBy = (field, dir = "asc") => ({ t: "order", field, dir });
export const limit = (n) => ({ t: "limit", n });
export const query = (col, ...cs) => ({ type: "query", coll: col.coll, cs });
const qpart = (q) => {
  const cs = q.cs || [];
  return {
    coll: q.coll,
    wheres: cs.filter((c) => c.t === "where").map((c) => [c.field, c.op, encode(c.value)]),
    orders: cs.filter((c) => c.t === "order").map((c) => [c.field, c.dir]),
    limit: (cs.find((c) => c.t === "limit") || {}).n || 0,
  };
};
class DocSnap {
  constructor(coll, id, data) { this.id = id; this._d = data; this.ref = { type: "doc", coll, id, path: coll + "/" + id }; }
  exists() { return this._d !== undefined; }
  data() { return this._d; }
  get(f) { return this._d ? this._d[f] : undefined; }
}
class QuerySnap {
  constructor(docs) { this.docs = docs; this.size = docs.length; this.empty = !docs.length; }
  forEach(fn) { this.docs.forEach(fn); }
}
export async function getDoc(ref) {
  const r = await call({ k: "get", coll: ref.coll, id: ref.id });
  return new DocSnap(ref.coll, ref.id, r.exists ? decode(r.data) : undefined);
}
export async function getDocs(q) {
  const col = q.type === "col" ? { coll: q.coll, cs: [] } : q;
  const r = await call({ k: "list", ...qpart(col) });
  return new QuerySnap(r.docs.map((d) => new DocSnap(col.coll, d.id, decode(d.data))));
}
export async function getCountFromServer(q) {
  const col = q.type === "col" ? { coll: q.coll, cs: [] } : q;
  const r = await call({ k: "count", ...qpart(col) });
  return { data: () => ({ count: r.count }) };
}
const write = (ops) => call({ k: "batch", ops });
export const setDoc = (ref, data, opts) => write([{ op: "set", coll: ref.coll, id: ref.id, data: encode(data), merge: !!(opts && opts.merge) }]).then(() => undefined);
export const updateDoc = (ref, data) => write([{ op: "update", coll: ref.coll, id: ref.id, data: encode(data) }]).then(() => undefined);
export const deleteDoc = (ref) => write([{ op: "delete", coll: ref.coll, id: ref.id }]).then(() => undefined);
export async function addDoc(col, data) { const ref = doc(col); await setDoc(ref, data); return ref; }
export function writeBatch() {
  const ops = [];
  const b = {
    set(ref, data, opts) { ops.push({ op: "set", coll: ref.coll, id: ref.id, data: encode(data), merge: !!(opts && opts.merge) }); return b; },
    update(ref, data) { ops.push({ op: "update", coll: ref.coll, id: ref.id, data: encode(data) }); return b; },
    delete(ref) { ops.push({ op: "delete", coll: ref.coll, id: ref.id }); return b; },
    commit() { return ops.length ? write(ops).then(() => undefined) : Promise.resolve(); },
  };
  return b;
}


/* ---------- live updates: what somebody else saved appears on every open page by itself ----------
   Every few seconds (only while the page is open on screen) a tiny request asks the server which lists changed (its answer is a handful of numbers).
   A list that changed is forgotten from memory and the page that shows it reloads it - unless the person is typing, then it waits.
   Pages subscribe with liveRefresh(["employees", ...], reloadFunction). Your own saves do not trigger a reload (the server tells us their number). */
const LIVE = { vers: null, subs: [], timer: null, running: false, fast: 0 };
function absorbVersions(v) { if (LIVE.vers) Object.assign(LIVE.vers, v); }
const typing = () => {
  if (typeof document === "undefined") return false;
  const a = document.activeElement; if (a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "file", "range"].includes(a.type)))) return true;
  return !!document.querySelector("dialog[open], .lv-pop, .ab-veil:not([hidden])");
};
export function liveRefresh(colls, fn) {
  const sub = { colls: new Set(colls), fn, pending: false, t: null };
  const run = () => { if (document.hidden) { sub.pending = true; return; } if (typing()) { clearTimeout(sub.t); sub.t = setTimeout(run, 3000); return; } sub.pending = false; try { Promise.resolve(fn()).catch(() => {}); } catch { } };
  sub.fire = () => { clearTimeout(sub.t); sub.t = setTimeout(run, 500); }; sub.run = run;
  LIVE.subs.push(sub); startLive(); return () => { LIVE.subs = LIVE.subs.filter((x) => x !== sub); };
}
async function pollOnce() {
  const s = getSession(); if (!s || LIVE.running || (typeof document !== "undefined" && document.hidden) || !navigator.onLine) return;
  LIVE.running = true;
  try {
    const res = await post({ action: "multi", token: s.token, calls: [{ k: "poll" }] });
    const r = res && res.ok && res.results && res.results[0]; if (!r || !r.ok) return;
    const now = r.data.v || {}, prev = LIVE.vers; LIVE.vers = now;
    if (!prev) return;
    const changed = Object.keys(now).filter((k) => prev[k] !== now[k]);
    if (!changed.length) return;
    changed.forEach(forgetReads);
    LIVE.subs.forEach((sub) => { if (changed.some((c) => sub.colls.has(c))) sub.fire(); });
  } catch { } finally { LIVE.running = false; }
}
export function startLive() {
  if (LIVE.timer || typeof document === "undefined") return;
  LIVE.act = Date.now();
  ["pointerdown", "keydown", "touchstart"].forEach((ev) => addEventListener(ev, () => (LIVE.act = Date.now()), { passive: true }));
  // every 15 s while somebody is using the page, every 45 s when nobody touched it for 2 minutes, nothing while the tab is hidden (keeps the server load small)
  const loop = async () => { await pollOnce(); LIVE.timer = setTimeout(loop, Date.now() - LIVE.act > 120000 ? 45000 : 15000); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { LIVE.act = Date.now(); pollOnce(); LIVE.subs.forEach((x) => x.pending && x.fire()); } });
  LIVE.timer = setTimeout(loop, 1500);
}
