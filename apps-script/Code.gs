/**
 * ARK Exam Portal - backend (Google Apps Script + Google Sheets)
 * -----------------------------------------------------------------------------
 * Replaces Firebase (Firestore + Authentication + Cloud Functions).
 *   - Every Firestore collection is one TAB of this spreadsheet (created on first use).
 *   - Accounts (Super Admin, IT Admin, teachers, registrar, finance, students) are created by the
 *     Super Admin / IT Admin and stored in the `users` tab; password hashes live in the `_auth` tab.
 *   - The website (GitHub Pages) NEVER touches the spreadsheet directly: it only calls this web app,
 *     which checks who is asking and applies the same rules that used to be in firestore.rules.
 * Setup: see README.md (menu "ARK Portal" appears in the spreadsheet after you reload it).
 */

/* ============================== settings ============================== */
var SESSION_MS = 12 * 3600 * 1000;      // a sign-in lasts 12 hours
var PW_ROUNDS = 1000;                   // password hashing rounds
var MAX_FAILS = 6, LOCK_MS = 5 * 60 * 1000;   // 6 wrong passwords -> that account waits 5 minutes
var RESET_MS = 60 * 60 * 1000;          // reset links last 1 hour
var COLS = ['id', 'schoolId', 'ownerUid', 'studentId', 'data', 'updatedAt'];
var AUTH_TAB = '_auth';
var AUTH_COLS = ['uid', 'keys', 'salt', 'hash', 'ver', 'resetHash', 'resetExp', 'fails', 'lockUntil'];
var CELL_MAX = 45000;                   // a cell holds 50,000 characters
var BLOB_MIN = 20000;                   // bigger text fields (module file pieces) go to Google Drive
var KNOWN = ['schools', 'users', 'auditLogs', 'systemSettings', 'counters', 'classCodes', 'enrollments', 'teacherLinks', 'students',
  'scanResults', 'modules', 'moduleChunks', 'examPapers', 'examKeys', 'examSubmissions', 'examAttempts', 'classes', 'registry',
  'enrollmentRecords', 'registrarSettings', 'registrarLog', 'payments', 'studentAccounts', 'financeSettings', 'financeLog',
  'examinations', 'answerKeys', 'answerSheets'];
var SCHOOL_COLLECTIONS = ['scanResults', 'examAttempts', 'examSubmissions', 'examKeys', 'examPapers', 'moduleChunks', 'modules',
  'examinations', 'answerKeys', 'answerSheets', 'enrollments', 'teacherLinks', 'classCodes', 'students', 'classes',
  'enrollmentRecords', 'registry', 'registrarSettings', 'payments', 'studentAccounts', 'financeSettings', 'financeLog', 'registrarLog'];

/* ============================== helpers ============================== */
function fail(code, message) { var e = new Error(message || code); e.code = code; throw e; }
var DENIED = 'You do not have permission for that action.';
function deny() { fail('permission-denied', DENIED); }
function prop(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function setProp(k, v) { PropertiesService.getScriptProperties().setProperty(k, v); }
function nowMs() { return Date.now(); }
function newId() { return Utilities.getUuid().replace(/-/g, '').slice(0, 20); }
function isStr(v) { return typeof v === 'string'; }
function jeq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function slug(s) { return String(s).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-'); }
function staffKey(school, emp) { return slug(school) + '.' + slug(emp); }
function studentKey(id) { return slug(id); }
function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim()); }
function defaultPassword(lastName, birthday) {
  var y = /^(\d{4})-/.exec(birthday || ''), l = String(lastName || '').trim()[0];
  return y && l ? y[1] + l.toUpperCase() : '';
}
function normPw(p) { p = String(p || ''); return /^\d{4}[a-z]$/i.test(p) ? p.slice(0, 4) + p.slice(4).toUpperCase() : p; }
function strongEnough(role, pw) {
  var min = role === 'student' ? 6 : 10;
  if (!isStr(pw) || pw.length < min) return false;
  return role === 'student' || (/[A-Za-z]/.test(pw) && /\d/.test(pw));
}
function keysOnly(o, list) { for (var k in o) if (list.indexOf(k) < 0) return false; return true; }
function diffKeys(a, b) {
  var out = {}; a = a || {}; b = b || {};
  for (var k in a) if (!jeq(a[k], b[k])) out[k] = 1;
  for (var k2 in b) if (!(k2 in a)) out[k2] = 1;
  return Object.keys(out);
}
function subset(list, allowed) { return list.every(function (k) { return allowed.indexOf(k) >= 0; }); }
function tsOf(v) { return v && typeof v === 'object' && '__ts' in v ? v.__ts : v; }
function getPath(o, path) { var p = String(path).split('.'); for (var i = 0; i < p.length; i++) { if (o == null) return undefined; o = o[p[i]]; } return o; }

/* ============================== crypto ============================== */
function b64(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); }
function hmac(msg) { return b64(Utilities.computeHmacSha256Signature(msg, prop('SECRET'))); }
function sha(s) { return b64(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s)); }
function hashPw(pw, salt) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, prop('PEPPER') + ':' + salt + ':' + pw);
  for (var i = 0; i < PW_ROUNDS; i++) d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, d.concat(Utilities.newBlob(salt).getBytes()));
  return b64(d);
}
function same(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; var r = 0; for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function makeToken(uid, ver) { var exp = nowMs() + SESSION_MS, body = uid + '.' + exp + '.' + ver; return { token: body + '.' + hmac(body), exp: exp }; }
function readToken(token) {
  var p = String(token || '').split('.');
  if (p.length !== 4) return null;
  var body = p[0] + '.' + p[1] + '.' + p[2];
  if (!same(hmac(body), p[3]) || +p[1] < nowMs()) return null;
  return { uid: p[0], ver: p[2] };
}

/* ============================== spreadsheet tables ============================== */
var _ss = null, _tabs = {}, _newBlobs = [], _oldBlobs = [];
function ss() { return _ss || (_ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(prop('SHEET_ID'))); }
function T(name) {
  if (_tabs[name]) return _tabs[name];
  var cols = name === AUTH_TAB ? AUTH_COLS : COLS, sh = ss().getSheetByName(name);
  if (!sh) {
    try {
      sh = ss().insertSheet(name);
      sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
      sh.setFrozenRows(1);
      sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    } catch (e) { sh = ss().getSheetByName(name); if (!sh) throw e; }   // another request created it first
  }
  var n = Math.max(0, sh.getLastRow() - 1);
  return (_tabs[name] = { name: name, sh: sh, cols: cols, n: n, nSheet: n, c: {}, idx: null, rows: {}, dirty: {}, dirtyN: 0, deleted: {}, delN: 0, pend: [], ecell: {} });
}
function colOf(t, k) {   // one column, loaded on demand (strings)
  if (!t.c[k]) {
    var a = t.nSheet ? t.sh.getRange(2, k + 1, t.nSheet, 1).getValues().map(function (r) { return String(r[0]); }) : [];
    t.pend.forEach(function (r) { a.push(r ? String(r[k]) : ''); });
    t.c[k] = a;
  }
  return t.c[k];
}
function indexOf(t) {
  if (!t.idx) { var a = colOf(t, 0), m = {}; for (var i = 0; i < a.length; i++) if (!t.deleted[i]) m[a[i]] = i; t.idx = m; }
  return t.idx;
}
function cellJson(t, i) {   // the data cell of row i
  if (t.ecell[i] !== undefined) return t.ecell[i];
  if (t.c[4]) return t.c[4][i];
  if (i >= t.nSheet) return String(t.pend[i - t.nSheet][4]);
  return (t.ecell[i] = String(t.sh.getRange(i + 2, 5).getValue()));
}
function tPut(t, id, row) {
  var m = indexOf(t), i = m[id];
  if (i === undefined) {
    i = t.n++; t.pend.push(row); m[id] = i;
    for (var k in t.c) t.c[k].push(String(row[k]));
  } else {
    if (i >= t.nSheet) t.pend[i - t.nSheet] = row; else { t.rows[i] = row; if (!t.dirty[i]) { t.dirty[i] = 1; t.dirtyN++; } }
    for (var k2 in t.c) t.c[k2][i] = String(row[k2]);
  }
  t.ecell[i] = String(row[4]);
}
function tDel(t, id) {
  var m = indexOf(t), i = m[id]; if (i === undefined) return;
  delete m[id]; t.deleted[i] = 1; t.delN++;
}
function ensureRows(t, upto) {
  var max = t.sh.getMaxRows();
  if (upto > max) t.sh.insertRowsAfter(max, upto - max + 500);
}
function flush(t) {
  if (!t.dirtyN && !t.delN && !t.pend.length) return;
  var sh = t.sh, nc = t.cols.length, i;
  if (t.delN > 10 || t.dirtyN > 15) {            // big change: rewrite the whole tab in one go
    var all = t.nSheet ? sh.getRange(2, 1, t.nSheet, nc).getValues().map(function (r) { return r.map(String); }) : [];
    for (i in t.rows) all[+i] = t.rows[i].map(String);
    t.pend.forEach(function (r) { all.push(r ? r.map(String) : null); });
    var keep = all.filter(function (r, j) { return r && !t.deleted[j]; });
    if (all.length) sh.getRange(2, 1, all.length, nc).clearContent();
    if (keep.length) { ensureRows(t, keep.length + 1); var rg = sh.getRange(2, 1, keep.length, nc); rg.setNumberFormat('@'); rg.setValues(keep); }
  } else {
    for (i in t.dirty) if (!t.deleted[i]) sh.getRange(+i + 2, 1, 1, nc).setValues([t.rows[i].map(String)]);
    var gone = Object.keys(t.deleted).map(Number).filter(function (j) { return j < t.nSheet; }).sort(function (a, b) { return b - a; });
    gone.forEach(function (j) { sh.deleteRow(j + 2); });
    var add = t.pend.filter(function (r, j) { return r && !t.deleted[t.nSheet + j]; }).map(function (r) { return r.map(String); });
    if (add.length) {
      var start = t.nSheet - gone.length + 2; ensureRows(t, start + add.length);
      var r2 = sh.getRange(start, 1, add.length, nc); r2.setNumberFormat('@'); r2.setValues(add);
    }
  }
  delete _tabs[t.name];
}
function flushAll() {
  Object.keys(_tabs).forEach(function (k) { if (_tabs[k]) flush(_tabs[k]); });
  _oldBlobs.forEach(trashBlob); _oldBlobs = []; _newBlobs = [];
}
function rollback() { _tabs = {}; _newBlobs.forEach(trashBlob); _newBlobs = []; _oldBlobs = []; }

/* ---------- big text goes to Drive ---------- */
function newBlob(text) {
  var f = DriveApp.getFolderById(prop('FOLDER_ID')).createFile(newId() + '.txt', text, MimeType.PLAIN_TEXT);
  _newBlobs.push(f.getId()); return f.getId();
}
function readBlob(id) { return DriveApp.getFileById(id).getBlob().getDataAsString(); }
function trashBlob(id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { } }
function blobsIn(json) { var out = [], re = /"__(?:blob|doc)":"([A-Za-z0-9_-]+)"/g, m; while ((m = re.exec(json))) out.push(m[1]); return out; }
function pack(data) {
  var d = {};
  for (var k in data) { var v = data[k]; d[k] = isStr(v) && v.length > BLOB_MIN ? { __blob: newBlob(v) } : v; }
  var js = JSON.stringify(d);
  if (js.length > CELL_MAX) js = JSON.stringify({ __doc: newBlob(JSON.stringify(data)) });
  return js;
}
function unpack(json) {
  var d = JSON.parse(json);
  if (d && d.__doc) return JSON.parse(readBlob(d.__doc));
  for (var k in d) if (d[k] && typeof d[k] === 'object' && d[k].__blob) d[k] = readBlob(d[k].__blob);
  return d;
}

/* ---------- documents ---------- */
function getDoc(coll, id) {
  var t = T(coll), i = indexOf(t)[id];
  return i === undefined ? null : unpack(cellJson(t, i));
}
function putDoc(coll, id, data) {
  var t = T(coll), i = indexOf(t)[id];
  if (i !== undefined) _oldBlobs = _oldBlobs.concat(blobsIn(cellJson(t, i)));
  tPut(t, id, [id, isStr(data.schoolId) ? data.schoolId : '', isStr(data.ownerUid) ? data.ownerUid : '', isStr(data.studentId) ? data.studentId : '', pack(data), nowMs()]);
}
function delDoc(coll, id) {
  var t = T(coll), i = indexOf(t)[id];
  if (i === undefined) return;
  _oldBlobs = _oldBlobs.concat(blobsIn(cellJson(t, i)));
  tDel(t, id);
}
/** All documents of a collection that pass `cheap` (indexed columns) - returns [{id, i}] */
function scan(coll, eq) {
  var t = T(coll), ids = colOf(t, 0), out = [], cols = { schoolId: 1, ownerUid: 2, studentId: 3 }, use = [];
  if (eq) for (var f in eq) if (cols[f]) use.push([colOf(t, cols[f]), eq[f]]);
  for (var i = 0; i < ids.length; i++) {
    if (t.deleted[i]) continue;
    var ok = true;
    for (var u = 0; u < use.length; u++) if (!(use[u][1].indexOf(use[u][0][i]) >= 0)) { ok = false; break; }
    if (ok) out.push({ id: ids[i], i: i });
  }
  return { t: t, hits: out };
}

/* ============================== accounts / sessions ============================== */
function authRow(uid) {
  var t = T(AUTH_TAB), i = indexOf(t)[uid]; if (i === undefined) return null;
  var r = t.rows[i] || (i >= t.nSheet ? t.pend[i - t.nSheet] : t.sh.getRange(i + 2, 1, 1, AUTH_COLS.length).getValues()[0]);
  var o = {}; AUTH_COLS.forEach(function (c, k) { o[c] = String(r[k]); }); return o;
}
function authPut(o) { var t = T(AUTH_TAB); tPut(t, o.uid, AUTH_COLS.map(function (c) { return o[c] === undefined ? '' : o[c]; })); }
function authFindByKey(key) {
  var t = T(AUTH_TAB), keys = colOf(t, 1), needle = '|' + key + '|';
  for (var i = 0; i < keys.length; i++) if (!t.deleted[i] && keys[i].indexOf(needle) >= 0) return authRow(colOf(t, 0)[i]);
  return null;
}
function keysString(keys) { return '|' + keys.join('|') + '|'; }
function authCreate(uid, keys, password) {
  var salt = newId();
  authPut({ uid: uid, keys: keysString(keys), salt: salt, hash: hashPw(password, salt), ver: '1', resetHash: '', resetExp: '', fails: '0', lockUntil: '0' });
}
function authSetPassword(uid, password) {
  var a = authRow(uid); if (!a) fail('not-found', 'That account was not found.');
  a.salt = newId(); a.hash = hashPw(password, a.salt); a.ver = String(+a.ver + 1); a.resetHash = ''; a.resetExp = ''; a.fails = '0'; a.lockUntil = '0';
  authPut(a); return a;
}
function dropActor(uid) { try { CacheService.getScriptCache().remove('a:' + uid); } catch (e) { } }

function loadActor(token) {
  var tk = readToken(token); if (!tk) fail('unauthenticated', 'Please sign in again.');
  var cache = CacheService.getScriptCache(), c = cache.get('a:' + tk.uid), a = c ? JSON.parse(c) : null;
  if (!a) {
    var me = getDoc('users', tk.uid), au = authRow(tk.uid);
    if (!me || !au) fail('unauthenticated', 'Please sign in again.');
    var sc = me.schoolId ? getDoc('schools', me.schoolId) : null;
    a = { me: me, schoolStatus: sc ? sc.status : '', ver: au.ver };
    cache.put('a:' + tk.uid, JSON.stringify(a), 20);
  }
  if (a.ver !== tk.ver) fail('unauthenticated', 'Please sign in again.');
  return { uid: tk.uid, me: a.me, schoolStatus: a.schoolStatus, ver: a.ver };
}

/* ============================== security rules (was firestore.rules) ============================== */
function makeS(actor, now) {
  var me = actor.me || {}, S = { uid: actor.uid, me: me, sid: me.schoolId, now: now || nowMs() };
  S.hasProfile = !!actor.me;
  S.schoolLive = me.role === 'superadmin' || (isStr(me.schoolId) && actor.schoolStatus === 'active');
  S.live = S.hasProfile && me.status === 'active' && me.mustChangePassword !== true && S.schoolLive;
  S.isSuper = S.live && me.role === 'superadmin'; S.isAdmin = S.live && me.role === 'admin';
  S.isTeacher = S.live && me.role === 'teacher'; S.isRegistrar = S.live && me.role === 'registrar';
  S.isFinance = S.live && me.role === 'finance'; S.isStaff = S.isAdmin || S.isTeacher; S.isStudent = S.live && me.role === 'student';
  S.get = function (c, id) { return isStr(id) && id ? getDoc(c, id) : null; };
  S.exists = function (c, id) { return !!S.get(c, id); };
  S.validAdviser = function (uid) { var u = S.get('users', uid); return !!u && u.role === 'teacher' && u.schoolId === S.sid; };
  S.studentRec = function (sid) { return S.get('students', sid) || {}; };
  S.myStudent = function () { return S.studentRec(me.studentId); };
  S.studentSees = function (ownerUid, classId) {
    if (!S.isStudent) return false;
    var ms = S.myStudent();
    return (ownerUid === ms.ownerUid && [ms.classId, ''].indexOf(classId) >= 0) ||
      (S.exists('teacherLinks', me.studentId + '_' + ownerUid) && (classId === '' || S.exists('enrollments', me.studentId + '_' + classId)));
  };
  S.sentToMe = function (d) { return S.isStudent && (d.studentId || '') === me.studentId; };
  S.mayRead = function (d) { return d.ownerUid === S.uid; };
  S.inMySchool = function (d) { return d.schoolId === S.sid; };
  return S;
}

var RULES = {
  schools: {
    read: function (S, d, id) { return S.hasProfile && (S.me.role === 'superadmin' || S.me.schoolId === id); },
    create: function (S, id, n) { return S.isSuper && keysOnly(n, ['name', 'code', 'adminEmail', 'status', 'createdAt', 'createdBy']) && n.code === id && n.status === 'active'; },
    update: function (S, id, o, n) {
      var df = diffKeys(o, n);
      if (S.isSuper && subset(df, ['status', 'updatedAt']) && ['active', 'suspended'].indexOf(n.status) >= 0) return true;
      return S.isAdmin && S.me.schoolId === id && subset(df, ['displayName', 'logo', 'adminEmail', 'updatedAt']) &&
        (!('adminEmail' in n) || n.adminEmail === S.me.email) &&
        (!('displayName' in n) || (isStr(n.displayName) && n.displayName.length <= 80)) &&
        (!('logo' in n) || (isStr(n.logo) && n.logo.length <= 900000));
    },
    del: function (S) { return S.isSuper; }
  },
  users: {
    read: function (S, d, id) { return (S.hasProfile && S.uid === id) || S.isSuper || (S.isAdmin && S.inMySchool(d)) || (S.isRegistrar && d.role === 'teacher' && S.inMySchool(d)); },
    create: function () { return false; },     // accounts are made by the createAccount action only
    update: function (S, id, o, n) {
      var df = diffKeys(o, n);
      return (S.isAdmin && ['teacher', 'registrar', 'finance', 'student'].indexOf(o.role) >= 0 && S.inMySchool(o) && subset(df, ['status', 'updatedAt']) && ['active', 'suspended'].indexOf(n.status) >= 0) ||
        (S.isSuper && o.role === 'admin' && subset(df, ['status', 'updatedAt']) && ['active', 'suspended'].indexOf(n.status) >= 0);
    },
    del: function (S, id, o) {
      return (S.isAdmin && ['teacher', 'registrar', 'finance', 'student'].indexOf(o.role) >= 0 && S.inMySchool(o)) ||
        (S.isSuper && ['admin', 'teacher', 'registrar', 'finance', 'student'].indexOf(o.role) >= 0) ||
        (S.isStaff && o.role === 'student' && S.studentRec(o.studentId).ownerUid === S.uid);
    }
  },
  auditLogs: {
    read: function (S, d) { return S.isSuper || (S.isAdmin && S.inMySchool(d)); },
    create: function (S, id, n) { return (S.isSuper || (S.isAdmin && n.schoolId === S.sid)) && n.actorUid === S.uid; },
    update: function () { return false; },
    del: function (S) { return S.isSuper; }
  },
  systemSettings: { read: function (S) { return S.live; }, create: function (S) { return S.isSuper; }, update: function (S) { return S.isSuper; }, del: function (S) { return S.isSuper; } },
  counters: { read: function (S) { return S.isStaff; }, create: function (S) { return S.isStaff; }, update: function (S) { return S.isStaff; }, del: function (S) { return S.isStaff; } },
  classCodes: {
    read: function (S, d, id, mode) { return mode === 'get' ? S.live : (S.isSuper || (S.isStaff && d.ownerUid === S.uid)); },
    create: function (S, id, n) { return S.isStaff && n.ownerUid === S.uid && n.schoolId === S.sid && n.code === id; },
    update: function (S, id, o) { return S.isStaff && o.ownerUid === S.uid; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper || (S.isRegistrar && S.inMySchool(o)); }
  },
  enrollments: {
    read: function (S, d) { return S.isSuper || (S.isStaff && d.ownerUid === S.uid) || (S.isStudent && d.studentId === S.me.studentId); },
    create: function (S, id, n) {
      if (!S.isStudent || !keysOnly(n, ['studentId', 'studentUid', 'studentName', 'studentNumber', 'classId', 'className', 'code', 'ownerUid', 'teacherName', 'schoolId', 'joinedAt'])) return false;
      var cc = S.get('classCodes', n.code) || {};
      return n.studentId === S.me.studentId && n.studentUid === S.uid && id === S.me.studentId + '_' + n.classId && n.schoolId === S.sid &&
        tsOf(n.joinedAt) === S.now && cc.classId === n.classId && cc.ownerUid === n.ownerUid && cc.schoolId === S.sid;
    },
    update: function () { return false; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || (S.isStudent && o.studentId === S.me.studentId) || S.isSuper; }
  },
  teacherLinks: {
    read: function (S, d) { return S.isSuper || (S.isStaff && d.ownerUid === S.uid) || (S.isStudent && d.studentId === S.me.studentId); },
    create: function (S, id, n) {
      if (!S.isStudent || !keysOnly(n, ['studentId', 'ownerUid', 'classId', 'schoolId', 'createdAt'])) return false;
      var en = S.get('enrollments', S.me.studentId + '_' + n.classId);
      return n.studentId === S.me.studentId && id === S.me.studentId + '_' + n.ownerUid && n.schoolId === S.sid && tsOf(n.createdAt) === S.now && !!en && en.ownerUid === n.ownerUid;
    },
    update: function () { return false; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || (S.isStudent && o.studentId === S.me.studentId) || S.isSuper; }
  },
  students: {
    read: function (S, d, id) { return S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isAdmin && S.inMySchool(d)) || (S.isRegistrar && S.inMySchool(d)) || (S.isStudent && S.me.studentId === id); },
    create: function (S, id, n) {
      return (S.isStaff && n.ownerUid === S.uid && n.schoolId === S.sid && n.number === id) ||
        (S.isRegistrar && n.schoolId === S.sid && n.number === id && S.validAdviser(n.ownerUid));
    },
    update: function (S, id, o, n) {
      return (S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid) ||
        (S.isRegistrar && S.inMySchool(o) && n.schoolId === S.sid && n.number === id && (n.ownerUid === o.ownerUid || S.validAdviser(n.ownerUid))) ||
        (S.isStudent && S.me.studentId === id && jeq(diffKeys(o, n), ['accountUid']) && n.accountUid === S.uid);
    },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper || (S.isRegistrar && S.inMySchool(o) && !('accountUid' in o)); }
  },
  scanResults: {
    read: function (S, d) { return S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isAdmin && S.inMySchool(d)) || (S.isStudent && d.studentId === S.me.studentId); },
    create: function (S, id, n) {
      if (S.isStaff && n.ownerUid === S.uid && n.schoolId === S.sid) return true;
      if (!S.isStudent) return false;
      if (!keysOnly(n, ['ownerUid', 'schoolId', 'examId', 'studentId', 'studentName', 'studentNumber', 'classId', 'className', 'answers', 'correct', 'wrong', 'blank', 'multi', 'pending', 'total', 'points', 'maxPoints', 'pct', 'final', 'pass', 'teacherName', 'examTitle', 'subject', 'term', 'passingPct', 'missedList', 'via', 'startedAt', 'submittedAt', 'scannedAt', 'reviewedFlags'])) return false;
      var sub = S.get('examSubmissions', id) || {}, att = S.get('examAttempts', id) || {};
      return n.via === 'online' && n.studentId === S.me.studentId && id === n.examId + '_' + S.me.studentId && n.schoolId === S.sid &&
        n.ownerUid === sub.ownerUid && jeq(n.answers, sub.answers) && jeq(n.submittedAt, sub.submittedAt) && jeq(n.startedAt, att.startedAt) && tsOf(n.scannedAt) === S.now;
    },
    update: function (S, id, o, n) { return S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  modules: {
    read: function (S, d) { return S.isSuper || (S.isStaff && S.mayRead(d)) || S.studentSees(d.ownerUid, d.classId) || S.sentToMe(d); },
    create: function (S, id, n) { return S.isStaff && n.ownerUid === S.uid && (!('studentId' in n) || (isStr(n.studentId) && S.studentRec(n.studentId).schoolId === S.sid)); },
    update: function (S, id, o, n) { return S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  moduleChunks: {
    read: function (S, d) {
      if (S.isSuper || (S.isStaff && S.mayRead(d))) return true;
      var m = S.get('modules', d.moduleId); return !!m && (S.studentSees(m.ownerUid, m.classId) || S.sentToMe(m));
    },
    create: function (S, id, n) { return S.isStaff && n.ownerUid === S.uid; },
    update: function (S, id, o, n) { return S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  examPapers: {
    read: function (S, d) { return S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isAdmin && S.inMySchool(d)) || (S.studentSees(d.ownerUid, d.classId) && d.open === true); },
    create: function (S, id, n) { return S.isStaff && n.ownerUid === S.uid && n.schoolId === S.sid; },
    update: function (S, id, o, n) { return S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  examKeys: {
    read: function (S, d, id) { return S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isStudent && S.exists('examSubmissions', id + '_' + S.me.studentId)); },
    create: function (S, id, n) { return S.isStaff && n.ownerUid === S.uid && n.schoolId === S.sid; },
    update: function (S, id, o, n) { return S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  examSubmissions: {
    read: function (S, d) { return S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isStudent && d.studentId === S.me.studentId); },
    create: function (S, id, n) {
      if (!S.isStudent || !keysOnly(n, ['examId', 'studentId', 'studentUid', 'ownerUid', 'schoolId', 'answers', 'submittedAt'])) return false;
      var p = S.get('examPapers', n.examId) || {};
      return n.studentId === S.me.studentId && n.studentUid === S.uid && id === n.examId + '_' + S.me.studentId && n.schoolId === S.sid &&
        tsOf(n.submittedAt) === S.now && Array.isArray(n.answers) && n.answers.length <= 100 && p.open === true && p.ownerUid === n.ownerUid &&
        S.studentSees(n.ownerUid, p.classId) && S.exists('examAttempts', id);
    },
    update: function () { return false; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  examAttempts: {
    read: function (S, d) { return S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isStudent && d.studentId === S.me.studentId); },
    create: function (S, id, n) {
      if (!S.isStudent || !keysOnly(n, ['examId', 'studentId', 'studentUid', 'ownerUid', 'schoolId', 'startedAt'])) return false;
      var p = S.get('examPapers', n.examId) || {};
      return n.studentId === S.me.studentId && n.studentUid === S.uid && id === n.examId + '_' + S.me.studentId && n.schoolId === S.sid &&
        tsOf(n.startedAt) === S.now && p.open === true && p.ownerUid === n.ownerUid && S.studentSees(n.ownerUid, p.classId);
    },
    update: function () { return false; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  classes: {   // registrar-made sections, or the teacher's own
    read: function (S, d) { return (S.isRegistrar && S.inMySchool(d)) || S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isAdmin && S.inMySchool(d)); },
    create: function (S, id, n) { return (S.isRegistrar && n.schoolId === S.sid && S.validAdviser(n.ownerUid)) || (S.isStaff && n.ownerUid === S.uid && n.schoolId === S.sid); },
    update: function (S, id, o, n) { return (S.isRegistrar && S.inMySchool(o) && n.schoolId === S.sid && S.validAdviser(n.ownerUid)) || (S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid); },
    del: function (S, id, o) { return (S.isRegistrar && S.inMySchool(o)) || (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  },
  registry: {
    read: function (S, d) { return ((S.isRegistrar || S.isAdmin || S.isFinance) && S.inMySchool(d)) || S.isSuper; },
    create: function (S, id, n) { return S.isRegistrar && n.schoolId === S.sid && n.createdBy === S.uid; },
    update: function (S, id, o, n) { return S.isRegistrar && S.inMySchool(o) && n.schoolId === S.sid; },
    del: function (S, id, o) { return (S.isRegistrar && S.inMySchool(o)) || S.isSuper; }
  },
  enrollmentRecords: {
    read: function (S, d) { return ((S.isRegistrar || S.isAdmin || S.isFinance) && S.inMySchool(d)) || S.isSuper; },
    create: function (S, id, n) { return S.isRegistrar && n.schoolId === S.sid && S.validAdviser(n.adviserUid); },
    update: function (S, id, o, n) { return S.isRegistrar && S.inMySchool(o) && n.schoolId === S.sid && S.validAdviser(n.adviserUid); },
    del: function (S, id, o) { return (S.isRegistrar && S.inMySchool(o)) || S.isSuper; }
  },
  registrarSettings: {
    read: function (S, d, id) { return ((S.isRegistrar || S.isAdmin || S.isFinance) && id === S.sid) || S.isSuper; },
    create: function (S, id, n) { return S.isRegistrar && id === S.sid && n.schoolId === S.sid; },
    update: function (S, id, o, n) { return S.isRegistrar && id === S.sid && n.schoolId === S.sid; },
    del: function (S) { return S.isSuper; }
  },
  registrarLog: {
    read: function (S, d) { return ((S.isRegistrar || S.isAdmin) && S.inMySchool(d)) || S.isSuper; },
    create: function (S, id, n) { return S.isRegistrar && n.schoolId === S.sid && n.byUid === S.uid; },
    update: function () { return false; },
    del: function (S) { return S.isSuper; }
  },
  payments: {
    read: function (S, d) { return ((S.isFinance || S.isAdmin) && S.inMySchool(d)) || S.isSuper || (S.isStudent && d.studentId === S.me.studentId); },
    create: function (S, id, n) { return S.isFinance && n.schoolId === S.sid && n.createdBy === S.uid && typeof n.amount === 'number' && n.amount > 0; },
    update: function (S, id, o, n) { return S.isFinance && S.inMySchool(o) && n.schoolId === S.sid && subset(diffKeys(o, n), ['status', 'voidReason', 'voidedAt', 'voidedBy', 'voidedByName']); },
    del: function (S) { return S.isSuper; }
  },
  studentAccounts: {
    read: function (S, d) { return ((S.isFinance || S.isAdmin) && S.inMySchool(d)) || S.isSuper || (S.isStudent && d.studentId === S.me.studentId); },
    create: function (S, id, n) { return S.isFinance && n.schoolId === S.sid; },
    update: function (S, id, o, n) { return S.isFinance && S.inMySchool(o) && n.schoolId === S.sid; },
    del: function (S, id, o) { return (S.isFinance && S.inMySchool(o)) || S.isSuper; }
  },
  financeSettings: {
    read: function (S, d, id) { return ((S.isFinance || S.isAdmin) && id === S.sid) || S.isSuper; },
    create: function (S, id, n) { return S.isFinance && id === S.sid && n.schoolId === S.sid; },
    update: function (S, id, o, n) { return S.isFinance && id === S.sid && n.schoolId === S.sid; },
    del: function (S) { return S.isSuper; }
  },
  financeLog: {
    read: function (S, d) { return ((S.isFinance || S.isAdmin) && S.inMySchool(d)) || S.isSuper; },
    create: function (S, id, n) { return S.isFinance && n.schoolId === S.sid && n.byUid === S.uid; },
    update: function () { return false; },
    del: function (S) { return S.isSuper; }
  }
};
['examinations', 'answerKeys', 'answerSheets'].forEach(function (c) {
  RULES[c] = {
    read: function (S, d) { return S.isSuper || (S.isStaff && S.mayRead(d)) || (S.isAdmin && S.inMySchool(d)); },
    create: function (S, id, n) { return S.isStaff && n.ownerUid === S.uid && n.schoolId === S.sid; },
    update: function (S, id, o, n) { return S.isStaff && o.ownerUid === S.uid && n.ownerUid === o.ownerUid; },
    del: function (S, id, o) { return (S.isStaff && o.ownerUid === S.uid) || S.isSuper; }
  };
});
function rulesOf(coll) { if (KNOWN.indexOf(coll) < 0) deny(); return RULES[coll]; }

/* ============================== reading and writing documents ============================== */
function resolveSV(v, now) {
  if (Array.isArray(v)) return v.map(function (x) { return resolveSV(x, now); });
  if (v && typeof v === 'object') {
    if (v.__sv === 'ts') return { __ts: now };
    var o = {}; for (var k in v) o[k] = resolveSV(v[k], now); return o;
  }
  return v;
}
function opGet(S, p) {
  var rules = rulesOf(p.coll), d = getDoc(p.coll, p.id);
  if (!d) { if (!S.live && !(S.hasProfile && p.coll === 'users' && p.id === S.uid)) deny(); return { exists: false }; }
  if (!rules.read(S, d, p.id, 'get')) deny();
  return { exists: true, data: d };
}
function matchWhere(d, w) {
  var x = getPath(d, w[0]), op = w[1], v = w[2];
  x = tsOf(x);
  switch (op) {
    case '==': return jeq(x, v);
    case '!=': return !jeq(x, v);
    case '<': return x < v; case '<=': return x <= v; case '>': return x > v; case '>=': return x >= v;
    case 'in': return Array.isArray(v) && v.some(function (y) { return jeq(x, y); });
    case 'array-contains': return Array.isArray(x) && x.some(function (y) { return jeq(y, v); });
    case 'array-contains-any': return Array.isArray(x) && Array.isArray(v) && x.some(function (y) { return v.some(function (z) { return jeq(y, z); }); });
    case 'not-in': return Array.isArray(v) && !v.some(function (y) { return jeq(x, y); });
  }
  return false;
}
function listDocs(S, p) {
  var rules = rulesOf(p.coll), wheres = p.wheres || [], eq = {};
  wheres.forEach(function (w) {   // use the indexed columns to skip most rows without parsing them
    if (['schoolId', 'ownerUid', 'studentId'].indexOf(w[0]) >= 0) {
      if (w[1] === '==') eq[w[0]] = [String(w[2])]; else if (w[1] === 'in' && Array.isArray(w[2])) eq[w[0]] = w[2].map(String);
    }
  });
  var s = scan(p.coll, eq), t = s.t, hits = s.hits, ids = colOf(t, 0);
  if (hits.length > 12 && t.c[4] === undefined) colOf(t, 4);   // many rows: one column read is cheaper than many cell reads
  var out = [];
  for (var h = 0; h < hits.length; h++) {
    var d = unpack(cellJson(t, hits[h].i));
    if (!wheres.every(function (w) { return matchWhere(d, w); })) continue;
    if (!rules.read(S, d, ids[hits[h].i], 'list')) continue;
    out.push({ id: ids[hits[h].i], data: d });
  }
  (p.orders || []).slice().reverse().forEach(function (o) {
    out.sort(function (a, b) {
      var x = tsOf(getPath(a.data, o[0])), y = tsOf(getPath(b.data, o[0]));
      var c = x < y ? -1 : x > y ? 1 : 0; return o[1] === 'desc' ? -c : c;
    });
  });
  return out;
}
function opList(S, p) { var out = listDocs(S, p); if (p.limit) out = out.slice(0, p.limit); return { docs: out }; }
function opCount(S, p) { return { count: listDocs(S, p).length }; }

function applyWrite(S, op) {
  var coll = op.coll, id = op.id, rules = rulesOf(coll);
  if (!isStr(id) || !id || id.indexOf('/') >= 0) fail('invalid-argument', 'Bad document id.');
  var cur = getDoc(coll, id), data;
  if (op.op === 'delete') {
    if (!cur) return;
    if (!rules.del(S, id, cur)) deny();
    delDoc(coll, id);
    if (coll === 'users') { var t = T(AUTH_TAB); tDel(t, id); S.touched.push(id); }
    return;
  }
  if (op.op === 'set' && !op.merge) data = resolveSV(op.data, S.now);
  else {
    if (!cur) { if (op.op === 'update') fail('not-found', 'No document to update.'); cur = null; }
    data = JSON.parse(JSON.stringify(cur || {}));
    for (var k in op.data) {
      var v = op.data[k];
      if (v && typeof v === 'object' && v.__sv === 'del') delete data[k]; else data[k] = resolveSV(v, S.now);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('invalid-argument', 'Bad data.');
  var existing = getDoc(coll, id);
  if (!existing) { if (!rules.create(S, id, data)) deny(); }
  else if (!rules.update(S, id, existing, data)) deny();
  putDoc(coll, id, data);
  if (coll === 'users' || coll === 'schools') S.touched.push(coll === 'users' ? id : '*');
}
function commit(actor, ops) {
  var S = makeS(actor); S.touched = [];
  try { ops.forEach(function (op) { applyWrite(S, op); }); flushAll(); }
  catch (e) { rollback(); throw e; }
  S.touched.forEach(function (u) { if (u !== '*') dropActor(u); });
  return { ok: true };
}

/* ============================== actions ============================== */
function meInfo(actor) {
  var sc = actor.me.schoolId ? getDoc('schools', actor.me.schoolId) : null;
  return { profile: actor.me, school: sc ? Object.assign({ id: actor.me.schoolId }, sc) : null };
}
function logAudit(actorUid, schoolId, action, targetUid, details) {
  putDoc('auditLogs', newId(), { actorUid: actorUid, schoolId: schoolId || '', action: action, targetUid: targetUid || '', details: details || {}, createdAt: { __ts: nowMs() } });
}
function loginKeyFor(p) {
  var who = String(p.who || '').trim();
  if (!who) fail('auth/invalid-credential', 'Enter your username and password.');
  return who.indexOf('@') >= 0 ? who.toLowerCase() : (String(p.school || '').trim() ? staffKey(p.school, who) : studentKey(who));
}
function actLogin(p) {
  var key = loginKeyFor(p), pw = normPw(p.password), a = authFindByKey(key);
  if (!a) fail('auth/invalid-credential');
  if (+a.lockUntil > nowMs()) fail('auth/too-many-requests');
  var ok = same(hashPw(pw, a.salt), a.hash);
  if (!ok) {
    var lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      a = authRow(a.uid); a.fails = String(+a.fails + 1);
      if (+a.fails >= MAX_FAILS) { a.lockUntil = String(nowMs() + LOCK_MS); a.fails = '0'; }
      authPut(a); flushAll();
    } finally { lock.releaseLock(); }
    fail('auth/invalid-credential');
  }
  if (+a.fails > 0) {
    var lk = LockService.getScriptLock(); lk.waitLock(20000);
    try { a = authRow(a.uid); a.fails = '0'; a.lockUntil = '0'; authPut(a); flushAll(); } finally { lk.releaseLock(); }
  }
  var me = getDoc('users', a.uid); if (!me) fail('auth/invalid-credential');
  var tk = makeToken(a.uid, a.ver), sc = me.schoolId ? getDoc('schools', me.schoolId) : null;
  return { token: tk.token, exp: tk.exp, uid: a.uid, profile: me, school: sc ? Object.assign({ id: me.schoolId }, sc) : null };
}
function actChangePassword(actor, p) {
  var role = actor.me.role, pw = String(p.newPassword || '');
  var min = role === 'student' ? 8 : 10;
  if (pw.length < min || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) fail('auth/weak-password', 'Use at least ' + min + ' characters with a letter and a number.');
  var a = authSetPassword(actor.uid, pw), me = getDoc('users', actor.uid);
  me.mustChangePassword = false; me.passwordChangedAt = { __ts: nowMs() };
  putDoc('users', actor.uid, me); flushAll(); dropActor(actor.uid);
  var tk = makeToken(actor.uid, a.ver);
  return { token: tk.token, exp: tk.exp };
}
function siteUrl() { var u = prop('SITE_URL') || ''; return u.replace(/\/+$/, ''); }
function sendResetMail(uid, email, name) {
  var a = authRow(uid); if (!a) return;
  var raw = newId() + newId(); a.resetHash = sha(raw); a.resetExp = String(nowMs() + RESET_MS); authPut(a); flushAll();
  var base = siteUrl(); if (!base) fail('failed-precondition', 'The website address is not set (menu ARK Portal > Set website address).');
  var link = base + '/login.html?reset=' + raw + '&u=' + uid;
  MailApp.sendEmail({ to: email, subject: 'Reset your Exam Portal password', name: 'Exam Portal',
    body: 'Hello ' + (name || '') + ',\n\nOpen this link to choose a new password (valid for 1 hour):\n' + link + '\n\nIf you did not ask for this, ignore this email.' });
}
function actResetRequest(p) {
  var who = String(p.who || '').trim(); if (!who) return { result: 'noemail' };
  var a = authFindByKey(loginKeyFor(p)); if (!a) return { result: 'noemail' };
  var me = getDoc('users', a.uid);
  if (!me || me.status !== 'active' || !me.hasRealEmail || !isEmail(me.email)) return { result: 'noemail' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { sendResetMail(a.uid, me.email, me.displayName); } finally { lock.releaseLock(); }
  return { result: 'sent' };
}
function actResetConfirm(p) {
  var a = authRow(String(p.uid || '')), pw = String(p.password || '');
  if (!a || !a.resetHash || +a.resetExp < nowMs() || !same(sha(String(p.token || '')), a.resetHash)) fail('invalid-argument', 'This reset link is invalid or has expired. Ask for a new one.');
  var me = getDoc('users', a.uid); if (!me) fail('invalid-argument', 'Account not found.');
  var min = me.role === 'student' ? 8 : 10;
  if (pw.length < min || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) fail('auth/weak-password', 'Use at least ' + min + ' characters with a letter and a number.');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    authSetPassword(a.uid, pw); me.mustChangePassword = false; me.passwordChangedAt = { __ts: nowMs() }; putDoc('users', a.uid, me); flushAll(); dropActor(a.uid);
  } finally { lock.releaseLock(); }
  return { ok: true };
}

/* ---- create an account (Super Admin -> IT Admin; IT Admin -> teacher / registrar / finance; staff -> own student) ---- */
function actCreateAccount(actor, p) {
  var S = makeS(actor), role = String(p.role || ''), now = S.now, me = actor.me, doc, keys = [], pw, school = null;
  var real = isEmail(p.realEmail) ? String(p.realEmail).trim().toLowerCase() : '';
  if (role === 'admin') {
    if (!S.isSuper) deny();
    var sp = p.school || {}, code = String(sp.code || '').toUpperCase(), name = String(sp.name || '').trim();
    if (!/^[A-Z0-9-]{3,20}$/.test(code) || name.length < 3) fail('invalid-argument', 'Enter a school name and a code (3-20 letters, numbers or hyphens).');
    if (getDoc('schools', code)) fail('invalid-argument', 'That school code is already used. Choose another.');
    var email = String(p.email || '').trim().toLowerCase(); if (!isEmail(email)) fail('auth/invalid-email');
    pw = String(p.password || ''); if (!strongEnough('admin', pw)) fail('auth/weak-password');
    keys = [email];
    doc = { uid: '', role: 'admin', displayName: String(p.displayName || '').trim(), email: email, schoolId: code, schoolName: name, status: 'active', mustChangePassword: true, createdAt: { __ts: now }, createdBy: actor.uid };
    school = { name: name, code: code, adminEmail: email, status: 'active', createdAt: { __ts: now }, createdBy: actor.uid };
  } else if (['teacher', 'registrar', 'finance'].indexOf(role) >= 0) {
    if (!S.isAdmin) deny();
    var emp = String(p.employeeId || '').trim(), sc = getDoc('schools', S.sid) || {};
    if (!emp) fail('invalid-argument', 'Enter the Employee No.');
    pw = defaultPassword(p.lastName, p.birthday); if (!pw) fail('invalid-argument', 'The birthday is not valid.');
    keys = [staffKey(S.sid, emp)]; if (real) keys.push(real);
    doc = { uid: '', role: role, displayName: String(p.displayName || ''), lastName: String(p.lastName || ''), firstName: String(p.firstName || ''), middleInitial: String(p.middleInitial || '').slice(0, 1),
      email: real || String(p.email || ''), employeeId: emp, birthday: String(p.birthday || ''), schoolId: S.sid, schoolName: sc.name || '', status: 'active', mustChangePassword: true, createdAt: { __ts: now }, createdBy: actor.uid };
    if (real) doc.hasRealEmail = true;
  } else if (role === 'student') {
    if (!S.isStaff) deny();
    var st = getDoc('students', String(p.studentId || ''));
    if (!st || st.ownerUid !== actor.uid || st.schoolId !== S.sid) deny();
    if (st.accountUid) fail('auth/email-already-in-use', 'That student already has an account.');
    pw = defaultPassword(st.lastName, st.birthday); if (!pw) fail('invalid-argument', 'Add the birthday and last name first.');
    keys = [studentKey(st.number)]; if (real) keys.push(real);
    doc = { uid: '', role: 'student', displayName: st.name, email: real || String(p.email || ''), studentId: st.number, birthday: st.birthday, schoolId: S.sid, schoolName: me.schoolName || '', status: 'active', mustChangePassword: true, createdAt: { __ts: now }, createdBy: actor.uid };
    if (real) doc.hasRealEmail = true;
  } else fail('invalid-argument', 'Unknown account type.');
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    if (role === 'admin' && getDoc('schools', school.code)) fail('invalid-argument', 'That school code is already used. Choose another.');
    keys.forEach(function (k) { if (authFindByKey(k)) fail('auth/email-already-in-use', 'That account already exists (same school code and Employee No., or same email).'); });
    var uid = newId(); doc.uid = uid;
    if (school) putDoc('schools', school.code, school);
    putDoc('users', uid, doc);
    authCreate(uid, keys, pw);
    if (role === 'student') { var s2 = getDoc('students', doc.studentId); s2.accountUid = uid; if (real) s2.email = real; putDoc('students', doc.studentId, s2); }
    logAudit(actor.uid, doc.schoolId, role + '.create', uid, { username: doc.employeeId || doc.studentId || doc.email });
    flushAll();
    return { uid: uid, password: pw };
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
}
function canManage(actor, t) {
  var me = actor.me;
  if (me.role === 'superadmin') return t.role === 'admin';
  if (me.role === 'admin') return ['teacher', 'registrar', 'finance', 'student'].indexOf(t.role) >= 0 && t.schoolId === me.schoolId;
  return false;
}
function actSetPassword(actor, p) {
  var S = makeS(actor); if (!S.isSuper && !S.isAdmin) deny();
  var t = getDoc('users', String(p.uid || '')); if (!t || ['admin', 'teacher', 'registrar', 'finance', 'student'].indexOf(t.role) < 0) fail('not-found', 'That account was not found.');
  if (!canManage(actor, t)) fail('permission-denied', 'You cannot reset that account.');
  var pw = p.password;
  if (p.useDefault) {
    var st = t.role === 'student' ? (getDoc('students', t.studentId) || {}) : t;
    pw = defaultPassword(st.lastName || String(t.displayName || '').split(',')[0], st.birthday || t.birthday);
    if (!pw) fail('failed-precondition', 'This account needs a birthday and last name first.');
  } else if (!strongEnough(t.role, pw)) fail('auth/weak-password', 'The password is too weak.');
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    authSetPassword(t.uid, pw); t.mustChangePassword = true; t.passwordResetAt = { __ts: nowMs() }; t.updatedAt = { __ts: nowMs() };
    putDoc('users', t.uid, t); logAudit(actor.uid, t.schoolId || actor.me.schoolId, t.role + '.temp_password_set', t.uid, { username: t.employeeId || t.studentId || t.email });
    flushAll(); dropActor(t.uid);
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
  return { ok: true };
}
function actSendReset(actor, p) {
  var S = makeS(actor); if (!S.isAdmin) deny();
  var t = getDoc('users', String(p.uid || '')); if (!t || !canManage(actor, t)) deny();
  if (!t.hasRealEmail || !isEmail(t.email)) fail('failed-precondition', 'This account has no email.');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { sendResetMail(t.uid, t.email, t.displayName); logAudit(actor.uid, t.schoolId, t.role + '.reset_email_sent', t.uid, {}); flushAll(); } finally { lock.releaseLock(); }
  return { ok: true };
}
function purgeWhere(coll, field, values) {
  var s = scan(coll, (function () { var o = {}; o[field] = values; return o; })()), t = s.t, ids = colOf(t, 0), n = 0;
  s.hits.forEach(function (h) { delDoc(coll, ids[h.i]); n++; });
  return n;
}
function dropAccount(uid) { delDoc('users', uid); tDel(T(AUTH_TAB), uid); dropActor(uid); }
function actDeleteUser(actor, p) {
  var S = makeS(actor); if (!S.isSuper && !S.isAdmin) fail('permission-denied', 'Only an administrator can remove accounts.');
  var uid = String(p.uid || ''); if (!uid || uid === actor.uid) fail('invalid-argument', 'Invalid account.');
  var t = getDoc('users', uid); if (!t) { var l0 = LockService.getScriptLock(); l0.waitLock(20000); try { tDel(T(AUTH_TAB), uid); flushAll(); } finally { l0.releaseLock(); } return { ok: true }; }
  if (t.role === 'superadmin') fail('permission-denied', 'That account cannot be removed here.');
  if (!canManage(actor, t)) fail('permission-denied', 'You cannot remove that account.');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    if (t.role === 'teacher') {
      var studs = scan('students', { ownerUid: [uid] }), ids = colOf(studs.t, 0);
      studs.hits.forEach(function (h) { var a = unpack(cellJson(studs.t, h.i)).accountUid; if (a) dropAccount(a); });
      var mods = scan('modules', { ownerUid: [uid] }); var mids = mods.hits.map(function (h) { return colOf(mods.t, 0)[h.i]; });
      ['scanResults', 'examAttempts', 'examSubmissions', 'examKeys', 'examPapers', 'moduleChunks', 'modules', 'examinations', 'answerKeys', 'answerSheets', 'enrollments', 'teacherLinks', 'classCodes', 'students', 'classes'].forEach(function (c) { purgeWhere(c, 'ownerUid', [uid]); });
    } else if (t.role === 'student' && t.studentId) {
      var st = getDoc('students', t.studentId); if (st) { delete st.accountUid; putDoc('students', t.studentId, st); }
      ['enrollments', 'teacherLinks', 'examAttempts', 'examSubmissions'].forEach(function (c) { purgeWhere(c, 'studentId', [t.studentId]); });
    }
    dropAccount(uid);
    logAudit(actor.uid, t.schoolId || '', t.role + '.deleted', uid, { username: t.employeeId || t.studentId || t.email });
    flushAll();
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
  return { ok: true };
}
/* Registrar: delete the login account of one student of the registrar's own school (even if it is already created).
   The registration / enrollment records are NOT touched here; the web page removes or marks them afterwards. */
function actRegistrarDropStudentAccount(actor, p) {
  var S = makeS(actor); if (!S.isRegistrar) fail('permission-denied', 'Only the registrar can remove a student account here.');
  var reg = getDoc('registry', String(p.registryId || ''));
  if (!reg || reg.schoolId !== S.sid) fail('not-found', 'That student was not found.');
  var examNo = String(reg.examNo || ''); if (!examNo) return { ok: true, removed: false };
  var st = getDoc('students', examNo); if (!st || st.schoolId !== S.sid || !st.accountUid) return { ok: true, removed: false };
  var uid = st.accountUid, lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    ['enrollments', 'teacherLinks', 'examAttempts', 'examSubmissions'].forEach(function (c) { purgeWhere(c, 'studentId', [examNo]); });
    delete st.accountUid; delete st.email; putDoc('students', examNo, st);
    dropAccount(uid);
    logAudit(actor.uid, S.sid, 'student.account_deleted_by_registrar', uid, { username: examNo });
    flushAll();
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
  return { ok: true, removed: true };
}
function purgeSchool(schoolId, removeAdmins) {
  var us = scan('users', { schoolId: [schoolId] }), uids = colOf(us.t, 0), people = [];
  us.hits.forEach(function (h) { var d = unpack(cellJson(us.t, h.i)); d.uid = uids[h.i]; if (d.role !== 'superadmin') people.push(d); });
  var doomed = people.filter(function (p) { return removeAdmins || p.role !== 'admin'; });
  var owners = people.filter(function (p) { return p.role === 'teacher' || p.role === 'admin'; }).map(function (p) { return p.uid; });
  var gone = {}; doomed.forEach(function (p) { gone[p.uid] = 1; });
  var n = 0;
  SCHOOL_COLLECTIONS.forEach(function (c) { if (owners.length) n += purgeWhere(c, 'ownerUid', owners); n += purgeWhere(c, 'schoolId', [schoolId]); });
  n += purgeWhere('auditLogs', 'schoolId', [schoolId]);
  Object.keys(gone).forEach(function (u) { dropAccount(u); });
  return { deleted: n + Object.keys(gone).length, accounts: Object.keys(gone).length };
}
function actEraseSchool(actor, p, removeSchool) {
  var S = makeS(actor); if (!S.isSuper) fail('permission-denied', 'Only the Super Admin can do that.');
  var sid = String(p.schoolId || ''), sc = getDoc('schools', sid); if (!sc) fail('not-found', 'That school was not found.');
  var lock = LockService.getScriptLock(), r; lock.waitLock(30000);
  try {
    r = purgeSchool(sid, removeSchool);
    if (removeSchool) delDoc('schools', sid);
    logAudit(actor.uid, removeSchool ? '' : sid, removeSchool ? 'school.deleted' : 'school.data_cleared', sid, { name: sc.name, code: sc.code, deleted: r.deleted, accounts: r.accounts });
    flushAll();
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
  return { ok: true, deleted: r.deleted, accounts: r.accounts };
}
function actAllocIds(actor, p) {
  var S = makeS(actor); if (!S.isStaff) deny();
  var year = Math.floor(+p.year), n = Math.floor(+p.n);
  if (!(year > 2000 && year < 3000) || !(n >= 1 && n <= 5000)) fail('invalid-argument', 'Bad request.');
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var id = 'students-' + year, c = getDoc('counters', id), cur = c ? +c.last : 0;
    putDoc('counters', id, { last: cur + n }); flushAll(); return { start: cur };
  } catch (e) { rollback(); throw e; } finally { lock.releaseLock(); }
}

/* ============================== web app entry ============================== */
function runCall(actor, c) {
  switch (c.k) {
    case 'me': return meInfo(actor);
    case 'get': return opGet(makeS(actor), c);
    case 'list': return opList(makeS(actor), c);
    case 'count': return opCount(makeS(actor), c);
    case 'batch': {
      if (!Array.isArray(c.ops) || c.ops.length > 500) fail('invalid-argument', 'Too many changes at once.');
      var lock = LockService.getScriptLock(); lock.waitLock(25000);
      try { return commit(actor, c.ops); } finally { lock.releaseLock(); }
    }
    case 'fn':
      switch (c.name) {
        case 'changePassword': return actChangePassword(actor, c.data || {});
        case 'createAccount': return actCreateAccount(actor, c.data || {});
        case 'adminSetTempPassword': return actSetPassword(actor, c.data || {});
        case 'adminSendReset': return actSendReset(actor, c.data || {});
        case 'adminDeleteUser': return actDeleteUser(actor, c.data || {});
        case 'registrarDropStudentAccount': return actRegistrarDropStudentAccount(actor, c.data || {});
        case 'superClearSchoolData': return actEraseSchool(actor, c.data || {}, false);
        case 'superDeleteSchool': return actEraseSchool(actor, c.data || {}, true);
        case 'allocIds': return actAllocIds(actor, c.data || {});
      }
  }
  fail('invalid-argument', 'Unknown request.');
}
function handle(req) {
  switch (req.action) {
    case 'login': return { ok: true, data: actLogin(req) };
    case 'resetRequest': return { ok: true, data: actResetRequest(req) };
    case 'resetConfirm': return { ok: true, data: actResetConfirm(req) };
    case 'ping': return { ok: true, data: { time: nowMs() } };
    case 'multi': {
      var actor = loadActor(req.token), results = [];
      (req.calls || []).forEach(function (c) {
        try { results.push({ ok: true, data: runCall(actor, c) }); }
        catch (e) { _tabs = {}; results.push({ ok: false, error: { code: e.code || 'internal', message: e.code ? e.message : 'Something went wrong. Please try again.' } }); }
      });
      return { ok: true, results: results };
    }
  }
  fail('invalid-argument', 'Unknown request.');
}
function doPost(e) {
  var out;
  try { out = handle(JSON.parse(e.postData.contents)); }
  catch (err) { _tabs = {}; out = { ok: false, error: { code: err.code || 'internal', message: err.code ? err.message : 'Something went wrong. Please try again.' } }; if (!err.code) console.error(err && err.stack || err); }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() { return ContentService.createTextOutput('ARK Exam Portal API is running.'); }

/* ============================== spreadsheet menu: first-time setup ============================== */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('ARK Portal')
    .addItem('1. First-time setup', 'menuSetup')
    .addItem('2. Create / reset the Super Admin', 'menuSuper')
    .addItem('3. Set the website address (for password-reset emails)', 'menuSite')
    .addToUi();
}
function menuSetup() {
  var ui = SpreadsheetApp.getUi();
  if (!prop('SECRET')) { setProp('SECRET', newId() + newId() + newId()); setProp('PEPPER', newId() + newId()); }
  setProp('SHEET_ID', SpreadsheetApp.getActiveSpreadsheet().getId());
  if (!prop('FOLDER_ID')) setProp('FOLDER_ID', DriveApp.createFolder('ARK Exam Portal files (do not delete)').getId());
  ['users', 'schools', AUTH_TAB].forEach(function (n) { T(n); });
  _tabs = {};
  ui.alert('Setup done', 'Next: ARK Portal > "2. Create / reset the Super Admin". Then deploy this script as a Web app (see README).', ui.ButtonSet.OK);
}
function menuSuper() {
  var ui = SpreadsheetApp.getUi();
  if (!prop('SECRET')) { ui.alert('Run "1. First-time setup" first.'); return; }
  var e = ui.prompt('Super Admin email', 'This is the Super Admin sign-in (no school code).', ui.ButtonSet.OK_CANCEL); if (e.getSelectedButton() !== ui.Button.OK) return;
  var n = ui.prompt('Super Admin name', 'Shown at the top of the page.', ui.ButtonSet.OK_CANCEL); if (n.getSelectedButton() !== ui.Button.OK) return;
  var p = ui.prompt('Password', 'At least 10 characters, with a letter and a number. You can change it later.', ui.ButtonSet.OK_CANCEL); if (p.getSelectedButton() !== ui.Button.OK) return;
  var email = e.getResponseText().trim().toLowerCase(), pw = p.getResponseText();
  if (!isEmail(email) || !strongEnough('superadmin', pw)) { ui.alert('Enter a valid email and a password of at least 10 characters with a letter and a number.'); return; }
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var a = authFindByKey(email), uid = a ? a.uid : newId(), old = a ? getDoc('users', uid) : null;
    putDoc('users', uid, Object.assign(old || {}, { uid: uid, role: 'superadmin', displayName: n.getResponseText().trim() || 'Super Admin', email: email, status: 'active', mustChangePassword: false, createdAt: (old && old.createdAt) || { __ts: nowMs() } }));
    if (a) authSetPassword(uid, pw); else authCreate(uid, [email], pw);
    flushAll();
  } catch (err) { rollback(); throw err; } finally { lock.releaseLock(); }
  ui.alert('Super Admin ready', 'Sign in with ' + email + ' (leave the school code blank).', ui.ButtonSet.OK);
}
function menuSite() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Website address', 'The address of your site WITHOUT the page name, for example https://yourname.github.io/ARK-Exam-Portal', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var u = r.getResponseText().trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s]+$/.test(u)) { ui.alert('Enter a full address starting with https://'); return; }
  setProp('SITE_URL', u); ui.alert('Saved', u, ui.ButtonSet.OK);
}
