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
export const clearSession = () => { try { localStorage.removeItem(SKEY); } catch { } };

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
/** Calls that do not need a sign-in (login, password reset). */
export async function rpc(action, payload = {}) {
  const r = await post({ action, ...payload });
  if (!r.ok) throw err(r.error);
  return r.data;
}
/* Calls made in the same moment are sent together in ONE request (fewer round trips = faster pages). */
let queue = [], timer = null;
const enqueue = (call) => new Promise((resolve, reject) => { queue.push({ call, resolve, reject }); if (!timer) timer = setTimeout(flush, 6); });
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
    if (res.error && res.error.code === "unauthenticated") { clearSession(); if (!/login\.html/.test(location.pathname)) location.href = "login.html"; }
    batch.forEach((b) => b.reject(err(res.error))); return;
  }
  res.results.forEach((r, i) => (r.ok ? batch[i].resolve(r.data) : batch[i].reject(err(r.error))));
}
export const call = (c) => enqueue(c);
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
