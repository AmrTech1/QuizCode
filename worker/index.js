/**
 * QuizCode — Cloudflare Worker (الواجهة الخلفية)
 *
 * الأسرار (Worker Secrets): SETUP_TOKEN، TG_TOKEN (اختياري)، TG_CHAT (اختياري)
 * المتغيرات (wrangler.toml): ALLOWED_ORIGINS، PBKDF2_ITERATIONS، SESSION_HOURS، TIME_ZONE
 * ربط KV: QUIZCODE_KV
 *
 * تخطيط مفاتيح KV:
 *   admin:cred                 بيانات كلمة مرور الإدارة (ملح + هاش PBKDF2 + epoch)
 *   sess:<sha256(token)>       جلسة إدارية (تنتهي تلقائيًا بـ TTL)
 *   rl:<name>:<sha256(ip)>     عدّاد محاولات الدخول الفاشلة
 *   exam:<examId>              الامتحان كاملًا (الإعدادات + الأسئلة + الإجابات الصحيحة)، والبيانات المختصرة في metadata
 *   code:<CODE>                {examId} لتحويل الكود إلى امتحان
 *   att:<examId>:<attemptId>   المحاولة كاملة، وملخصها في metadata (لعرض القوائم بدون قراءة كل محاولة)
 *   ident:<examId>:<sha256>    عدّاد محاولات كود طالب معيّن
 */

const ENC = new TextEncoder();
const GRACE_MS = 30000; // مهلة قبول التسليم/الحفظ بعد انتهاء الوقت (لتأخر الشبكة)
const MAX_BODY_BYTES = 1000000;
const QTYPES = ['single', 'multi', 'tf', 'short', 'fill', 'order', 'image', 'essay'];
const IMG_SUBTYPES = ['single', 'multi', 'tf', 'short', 'essay'];
const ID_EXAM = /^[a-f0-9]{12}$/;
const ID_ATTEMPT = /^[a-f0-9]{16}$/;
const ID_TOKEN = /^[a-f0-9]{48}$/;

/* ───────────── أدوات عامة ───────────── */

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}
const fail = (status, code, message, extra) => { throw new HttpError(status, code, message, extra); };
const r2 = (n) => Math.round(n * 100) / 100;
const bytesToHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const hexToBytes = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
const randHex = (n = 16) => bytesToHex(crypto.getRandomValues(new Uint8Array(n)));
const sha256Hex = async (s) => bytesToHex(await crypto.subtle.digest('SHA-256', ENC.encode(s)));

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function safeEqualSecret(a, b) {
  return safeEqual(await sha256Hex(String(a)), await sha256Hex(String(b)));
}

function normalizeDigits(s) {
  return String(s ?? '')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}
const normalizeCode = (s) => normalizeDigits(s).normalize('NFKC').replace(/\s+/g, '').toUpperCase();
const normalizeIdent = (s) => normalizeDigits(s).normalize('NFKC').trim().toLowerCase();

function normText(s) {
  return normalizeDigits(s)
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // التشكيل والتطويل
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/* ───────────── التحقق من المدخلات ───────────── */

function vStr(v, label, min, max) {
  if (typeof v !== 'string') fail(400, 'VALIDATION', `${label}: قيمة غير صالحة`);
  const s = v.trim();
  if (s.length < min || s.length > max) fail(400, 'VALIDATION', `${label}: يجب أن يكون بين ${min} و${max} حرفًا`);
  return s;
}

function vOptStr(v, max, label) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') fail(400, 'VALIDATION', `${label}: قيمة غير صالحة`);
  const s = v.trim();
  if (s.length > max) fail(400, 'VALIDATION', `${label}: الحد الأقصى ${max} حرفًا`);
  return s;
}

function vInt(v, label, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    fail(400, 'VALIDATION', `${label}: رقم صحيح بين ${min} و${max}`);
  }
  return n;
}
const vOptInt = (v, label, min, max) => (v === null || v === undefined || v === '' ? null : vInt(v, label, min, max));

function vOptNum(v, label, min, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(400, 'VALIDATION', `${label}: رقم بين ${min} و${max}`);
  return r2(n);
}

function vOptTime(v, label) {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(t) || t < 0) fail(400, 'VALIDATION', `${label}: تاريخ غير صالح`);
  return Math.floor(t);
}

function vOptUrl(v, label) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > 1000) fail(400, 'VALIDATION', `${label}: رابط الصورة غير صالح`);
  let u;
  try { u = new URL(v.trim()); } catch { fail(400, 'VALIDATION', `${label}: رابط الصورة غير صالح`); }
  if (u.protocol !== 'https:') fail(400, 'VALIDATION', `${label}: رابط الصورة يجب أن يبدأ بـ https://`);
  return u.toString();
}

function vPoints(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) fail(400, 'VALIDATION', `${label}: الدرجة يجب أن تكون بين 0.01 و1000`);
  return r2(n);
}

function vAccepted(list, label) {
  if (!Array.isArray(list)) fail(400, 'VALIDATION', `${label}: أضف إجابة مقبولة واحدة على الأقل`);
  const out = [];
  for (const x of list) {
    if (typeof x !== 'string') continue;
    const s = x.trim();
    if (s) {
      if (s.length > 200) fail(400, 'VALIDATION', `${label}: الإجابة المقبولة طويلة جدًا`);
      out.push(s);
    }
  }
  if (out.length < 1 || out.length > 20) fail(400, 'VALIDATION', `${label}: عدد الإجابات المقبولة بين 1 و20`);
  return out;
}

function vPassword(p) {
  if (typeof p !== 'string' || p.length < 10 || p.length > 128) {
    fail(400, 'WEAK_PASSWORD', 'كلمة المرور يجب أن تكون بين 10 و128 حرفًا');
  }
  return p;
}

function normOptions(list, label, min, max) {
  if (!Array.isArray(list) || list.length < min || list.length > max) {
    fail(400, 'VALIDATION', `${label}: عدد العناصر يجب أن يكون بين ${min} و${max}`);
  }
  const used = new Set();
  return list.map((o, i) => {
    const text = vStr(o && o.text, `${label} (عنصر ${i + 1})`, 1, 300);
    let id = o && typeof o.id === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(o.id) && !used.has(o.id) ? o.id : null;
    if (!id) { do { id = 'o' + randHex(3); } while (used.has(id)); }
    used.add(id);
    return { id, text };
  });
}

const kindOf = (q) => (q.type === 'image' ? q.subtype || 'single' : q.type);

function normalizeQuestions(list) {
  if (!Array.isArray(list)) fail(400, 'VALIDATION', 'الأسئلة يجب أن تكون قائمة');
  if (list.length > 200) fail(400, 'VALIDATION', 'الحد الأقصى 200 سؤال في الامتحان');
  const ids = new Set();
  return list.map((q, i) => {
    const label = `السؤال ${i + 1}`;
    if (!q || typeof q !== 'object') fail(400, 'VALIDATION', `${label}: بيانات غير صالحة`);
    if (!QTYPES.includes(q.type)) fail(400, 'VALIDATION', `${label}: نوع السؤال غير معروف`);
    const subtype = q.type === 'image' ? (IMG_SUBTYPES.includes(q.subtype) ? q.subtype : 'single') : undefined;
    const kind = subtype || q.type;
    let id = typeof q.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(q.id) && !ids.has(q.id) ? q.id : null;
    if (!id) { do { id = 'q' + randHex(4); } while (ids.has(id)); }
    ids.add(id);
    const imageUrl = vOptUrl(q.imageUrl, label);
    if (q.type === 'image' && !imageUrl) fail(400, 'VALIDATION', `${label}: سؤال الصورة يتطلب رابط صورة https`);
    const out = { id, type: q.type };
    if (subtype) out.subtype = subtype;
    out.text = vStr(q.text, `${label}: نص السؤال`, 1, 3000);
    out.points = vPoints(q.points, label);
    if (imageUrl) out.imageUrl = imageUrl;
    const explanation = vOptStr(q.explanation, 2000, `${label}: الشرح`);
    if (explanation) out.explanation = explanation;
    
    if (kind === 'single' || kind === 'multi') {
      out.options = normOptions(q.options, `${label}: الخيارات`, 2, 10);
      const optIds = out.options.map((o) => o.id);
      if (kind === 'single') {
        if (typeof q.correct !== 'string' || !optIds.includes(q.correct)) fail(400, 'VALIDATION', `${label}: حدد الإجابة الصحيحة`);
        out.correct = q.correct;
      } else {
        if (!Array.isArray(q.correct) || !q.correct.length) fail(400, 'VALIDATION', `${label}: حدد إجابة صحيحة واحدة على الأقل`);
        const set = new Set(q.correct);
        for (const c of set)
          if (!optIds.includes(c)) fail(400, 'VALIDATION', `${label}: إجابة صحيحة غير موجودة في الخيارات`);
        out.correct = optIds.filter((x) => set.has(x));
      }
    } else if (kind === 'tf') {
      if (typeof q.correct !== 'boolean') fail(400, 'VALIDATION', `${label}: حدد صح أو خطأ`);
      out.correct = q.correct;
    } else if (kind === 'short') {
      out.accepted = vAccepted(q.accepted, `${label}: الإجابات المقبولة`);
    } else if (kind === 'fill') {
      if (!Array.isArray(q.blanks) || q.blanks.length < 1 || q.blanks.length > 10) fail(400, 'VALIDATION', `${label}: عدد الفراغات بين 1 و10`);
      out.blanks = q.blanks.map((b, bi) => ({
        accepted: vAccepted(Array.isArray(b) ? b : b && b.accepted, `${label}: الفراغ ${bi + 1}`),
      }));
    } else if (kind === 'order') {
      out.items = normOptions(q.items, `${label}: العناصر`, 2, 10); // ترتيب الإدخال = الترتيب الصحيح
    } else if (kind === 'essay') {
      const rubric = vOptStr(q.rubric, 2000, `${label}: معيار التصحيح`);
      if (rubric) out.rubric = rubric;
    }
    return out;
  });
}

function normalizeExam(inp, base) {
  if (!inp || typeof inp !== 'object') fail(400, 'VALIDATION', 'بيانات الامتحان غير صالحة');
  const code = normalizeCode(inp.code);
  if (!/^[A-Z0-9-]{3,24}$/.test(code)) fail(400, 'BAD_CODE', 'كود الامتحان: من 3 إلى 24 حرفًا إنجليزيًا أو أرقامًا أو شرطة');
  const opensAt = vOptTime(inp.opensAt, 'وقت الفتح');
  const closesAt = vOptTime(inp.closesAt, 'وقت الإغلاق');
  if (opensAt && closesAt && closesAt <= opensAt) fail(400, 'VALIDATION', 'وقت الإغلاق يجب أن يكون بعد وقت الفتح');
  const resultMode = inp.resultMode === undefined ? 'manual' : inp.resultMode;
  if (!['auto', 'manual'].includes(resultMode)) fail(400, 'VALIDATION', 'طريقة نشر النتائج غير صالحة');
  const questions = normalizeQuestions(inp.questions === undefined ? [] : inp.questions);
  const enabled = inp.enabled === true;
  if (enabled && !questions.length) fail(400, 'VALIDATION', 'لا يمكن تفعيل امتحان بدون أسئلة');
  return {
    id: base.id,
    title: vStr(inp.title, 'اسم الامتحان', 2, 120),
    description: vOptStr(inp.description, 1000, 'الوصف'),
    instructions: vOptStr(inp.instructions, 3000, 'التعليمات'),
    code,
    durationMinutes: vInt(inp.durationMinutes, 'مدة الامتحان (دقائق)', 1, 600),
    opensAt,
    closesAt,
    maxParticipants: vOptInt(inp.maxParticipants, 'الحد الأقصى للمشاركين', 1, 10000),
    maxAttempts: vOptInt(inp.maxAttempts, 'عدد المحاولات لكل طالب', 1, 50),
    passPercent: vOptNum(inp.passPercent, 'نسبة النجاح', 0, 100),
    enabled,
    resultMode,
    requireStudentCode: inp.requireStudentCode === true,
    showReview: inp.showReview === true,
    resultsPublished: base.resultsPublished === true,
    questions,
    createdAt: base.createdAt,
    updatedAt: base.now,
  };
}

/* ───────────── KV ───────────── */

const kvGet = (env, key) => env.QUIZCODE_KV.get(key, 'json');
const kvPut = (env, key, val, opts = {}) => env.QUIZCODE_KV.put(key, JSON.stringify(val), opts);
async function kvList(env, prefix, cap = 3000) {
  const out = [];
  let cursor;
  do {
    const r = await env.QUIZCODE_KV.list({ prefix, cursor, limit: Math.min(1000, cap) });
    out.push(...r.keys);
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor && out.length < cap);
  return out;
}

const totalPoints = (e) => r2(e.questions.reduce((s, q) => s + q.points, 0));

function examMeta(e) {
  return { id: e.id, t: e.title.slice(0, 100), c: e.code, en: e.enabled, qc: e.questions.length, tp: totalPoints(e), d: e.durationMinutes, o: e.opensAt, cl: e.closesAt, rm: e.resultMode, rp: e.resultsPublished, u: e.updatedAt };
}
const putExam = (env, e) => kvPut(env, `exam:${e.id}`, e, { metadata: examMeta(e) });
async function getExam(env, id) {
  if (typeof id !== 'string' || !ID_EXAM.test(id)) fail(404, 'EXAM_NOT_FOUND', 'الامتحان غير موجود');
  const e = await kvGet(env, `exam:${id}`);
  if (!e) fail(404, 'EXAM_NOT_FOUND', 'الامتحان غير موجود');
  return e;
}

function attemptMeta(a) {
  return { id: a.id, n: a.name.slice(0, 60), c: (a.studentCode || '').slice(0, 40), s: a.status, st: a.startedAt, sb: a.submittedAt || 0, dl: a.deadline, t: a.grading ? a.grading.total : null, m: a.grading ? a.grading.max : null, p: a.grading ? a.grading.pending : 0, o: a.override === undefined ? null : a.override };
}
const putAttempt = (env, a) => kvPut(env, `att:${a.examId}:${a.id}`, a, { metadata: attemptMeta(a) });
async function getAttempt(env, examId, attemptId) {
  if (!ID_ATTEMPT.test(String(attemptId))) fail(404, 'ATTEMPT_NOT_FOUND', 'المحاولة غير موجودة');
  const a = await kvGet(env, `att:${examId}:${attemptId}`);
  if (!a) fail(404, 'ATTEMPT_NOT_FOUND', 'المحاولة غير موجودة');
  return a;
}
const idParam = (url, name) => {
  const v = url.searchParams.get(name) || '';
  if (!ID_EXAM.test(v)) fail(400, 'VALIDATION', 'معرّف الامتحان غير صالح');
  return v;
};

/* ───────────── CORS والاستجابات ───────────── */

function isAllowedOrigin(origin, env) {
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes('*') || list.includes(origin);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const h = { Vary: 'Origin' };
  if (origin && isAllowedOrigin(origin, env)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Expose-Headers'] = 'Content-Disposition';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function respond(request, env, payload, status = 200, type = 'application/json; charset=utf-8', extra = {}) {
  return new Response(payload, {
    status,
    headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...corsHeaders(request, env), ...extra },
  });
}
const respondJson = (request, env, obj, status = 200) => respond(request, env, JSON.stringify(obj), status);

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) fail(413, 'TOO_LARGE', 'حجم الطلب كبير جدًا');
  if (!text.trim()) return {};
  let v;
  try { v = JSON.parse(text); } catch { fail(400, 'BAD_JSON', 'صيغة الطلب غير صالحة'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(400, 'BAD_JSON', 'صيغة الطلب غير صالحة');
  return v;
}

/* ───────────── الأمان: كلمة المرور والجلسات ───────────── */

const iterOf = (env) => Math.min(100000, Math.max(10000, parseInt(env.PBKDF2_ITERATIONS, 10) || 100000)); // 100000 هو الحد الأقصى في Workers
const sessionMs = (env) => Math.min(24, Math.max(1, Number(env.SESSION_HOURS) || 8)) * 3600000;

async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', ENC.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations }, key, 256);
  return bytesToHex(bits);
}
async function saveCred(env, password, now) {
  const salt = randHex(16);
  const iter = iterOf(env);
  await kvPut(env, 'admin:cred', { salt, iter, hash: await pbkdf2(password, salt, iter), epoch: randHex(8), updatedAt: now });
}
async function verifyPassword(env, cred, password) {
  const pw = typeof password === 'string' ? password.slice(0, 256) : '';
  return safeEqual(await pbkdf2(pw, cred.salt, cred.iter), cred.hash);
}

async function rlCheck(env, name, request, now, max = 5, windowSec = 900) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `rl:${name}:${await sha256Hex(ip)}`;
  const rec = await kvGet(env, key);
  if (rec && rec.count >= max && now < rec.first + windowSec * 1000) {
    fail(429, 'TOO_MANY_ATTEMPTS', 'محاولات كثيرة. حاول لاحقًا.', { retryAfterSec: Math.ceil((rec.first + windowSec * 1000 - now) / 1000) });
  }
  return { key, rec, now, windowSec };
}
async function rlFail(env, st) {
  const fresh = !st.rec || st.now >= st.rec.first + st.windowSec * 1000;
  const rec = fresh ? { count: 1, first: st.now } : { count: st.rec.count + 1, first: st.rec.first };
  await kvPut(env, st.key, rec, { expirationTtl: Math.max(60, Math.ceil((rec.first + st.windowSec * 1000 - st.now) / 1000)) });
}
const rlClear = async (env, st) => { if (st.rec) await env.QUIZCODE_KV.delete(st.key); };

async function requireAdmin(request, env, now) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') || '');
  if (!m) fail(401, 'UNAUTHORIZED', 'يجب تسجيل الدخول');
  const sessionKey = `sess:${await sha256Hex(m[1])}`;
  const [sess, cred] = await Promise.all([kvGet(env, sessionKey), kvGet(env, 'admin:cred')]);
  if (!sess || !cred || sess.epoch !== cred.epoch || sess.exp < now) fail(401, 'UNAUTHORIZED', 'انتهت الجلسة. سجّل الدخول مجددًا');
  return { sessionKey };
}

/* ───────────── التصحيح ───────────── */

function isEmptyAnswer(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0 || v.every((x) => typeof x === 'string' && x.trim() === '');
  return false;
}
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const matches = (accepted, v) => accepted.some((a) => normText(a) === normText(v));

function gradeQuestion(q, ans) {
  const max = q.points;
  const kind = kindOf(q);
  if (isEmptyAnswer(ans)) return { score: 0, max, status: 'unanswered' };
  const done = (ok) => ({ score: ok ? max : 0, max, status: ok ? 'correct' : 'wrong' });
  switch (kind) {
    case 'single':
      return done(ans === q.correct);
    case 'multi':
      return done(Array.isArray(ans) && sameSet(ans, q.correct));
    case 'tf':
      return done(ans === q.correct);
    case 'short':
      return done(typeof ans === 'string' && matches(q.accepted, ans));
    case 'order':
      return done(Array.isArray(ans) && ans.length === q.items.length && ans.every((x, i) => x === q.items[i].id));
    case 'fill': {
      const ok = q.blanks.filter((b, i) => matches(b.accepted, (ans && ans[i]) || '')).length;
      const status = ok === q.blanks.length ? 'correct' : ok > 0 ? 'partial' : 'wrong';
      return { score: r2((max * ok) / q.blanks.length), max, status };
    }
    case 'essay':
      return { score: 0, max, status: 'pending' };
    default:
      return { score: 0, max, status: 'wrong' };
  }
}

function summarize(exam, items) {
  let total = 0,
    pending = 0,
    max = 0;
  for (const q of exam.questions) {
    const it = items[q.id];
    max += q.points;
    if (it) { total += it.score; if (it.status === 'pending') pending++; }
  }
  return { items, total: r2(total), max: r2(max), pending };
}

function gradeAttempt(exam, answers) {
  const items = {};
  for (const q of exam.questions) items[q.id] = gradeQuestion(q, answers[q.id]);
  return summarize(exam, items);
}

function isVisible(exam, s) {
  if (s.status !== 'submitted') return false;
  if (s.override === true) return true;
  if (s.override === false) return false;
  return exam.resultMode === 'auto' ? (s.pending || 0) === 0 : exam.resultsPublished === true;
}

/* ───────────── عرض الأسئلة والإجابات ───────────── */

function seededShuffle(arr, seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rnd = () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  if (a.length > 1 && a.every((x, i) => x.id === arr[i].id)) a.push(a.shift());
  return a;
}

function publicQuestion(q, seed) {
  const kind = kindOf(q);
  const out = { id: q.id, type: q.type, kind, text: q.text, points: q.points };
  if (q.imageUrl) out.imageUrl = q.imageUrl;
  if (kind === 'single' || kind === 'multi') {
    out.options = seededShuffle(q.options, seed + q.id + ':options');
  }
  if (kind === 'order') out.items = seededShuffle(q.items, seed + q.id);
  if (kind === 'fill') out.blanksCount = q.blanks.length;
  return out;
}

function correctOf(q) {
  switch (kindOf(q)) {
    case 'single':
    case 'multi':
    case 'tf':
      return q.correct;
    case 'short':
      return q.accepted;
    case 'fill':
      return q.blanks.map((b) => b.accepted);
    case 'order':
      return q.items.map((i) => i.id);
    default:
      return null;
  }
}

function buildReview(exam, a, forAdmin) {
  return exam.questions.map((q) => {
    const it = (a.grading && a.grading.items[q.id]) || { score: 0, max: q.points, status: 'unanswered' };
    const row = {
      question: forAdmin ? { ...q, kind: kindOf(q) } : publicQuestion(q, a.id),
      answer: a.answers[q.id] === undefined ? null : a.answers[q.id],
      score: it.score,
      max: it.max,
      status: it.status,
      note: it.note || '',
    };
    if (forAdmin || exam.showReview) {
      row.correct = correctOf(q);
      row.explanation = q.explanation || '';
    }
    return row;
  });
}

function sanitizeAnswer(q, v) {
  switch (kindOf(q)) {
    case 'single':
      return typeof v === 'string' && q.options.some((o) => o.id === v) ? v : undefined;
    case 'multi': {
      if (!Array.isArray(v)) return undefined;
      const set = new Set(v);
      const out = q.options.map((o) => o.id).filter((id) => set.has(id));
      return out.length ? out : undefined;
    }
    case 'tf':
      return v === true || v === false ? v : v === 'true' ? true : v === 'false' ? false : undefined;
    case 'short':
      return typeof v === 'string' && v.trim() ? v.slice(0, 500) : undefined;
    case 'essay':
      return typeof v === 'string' && v.trim() ? v.slice(0, 8000) : undefined;
    case 'fill': {
      if (!Array.isArray(v)) return undefined;
      const out = q.blanks.map((_, i) => (typeof v[i] === 'string' ? v[i].slice(0, 200) : ''));
      return out.some((x) => x.trim()) ? out : undefined;
    }
    case 'order': {
      if (!Array.isArray(v) || v.length !== q.items.length) return undefined;
      const ids = q.items.map((i) => i.id);
      return v.every((x) => typeof x === 'string') && sameSet(v, ids) && new Set(v).size === v.length ? v : undefined;
    }
    default:
      return undefined;
  }
}

function sanitizeAnswers(exam, input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const q of exam.questions) {
    const v = sanitizeAnswer(q, input[q.id]);
    if (v !== undefined) out[q.id] = v;
  }
  return out;
}

/* ───────────── Telegram (اختياري) ───────────── */

const tgConfigured = (env) => !!(env.TG_TOKEN && env.TG_CHAT);
async function sendTelegram(env, text) {
  if (!tgConfigured(env)) return { ok: false, reason: 'NOT_CONFIGURED' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT, text, disable_web_page_preview: true }),
    });
    if (!r.ok) { console.error('Telegram HTTP status', r.status); return { ok: false, reason: 'HTTP_' + r.status }; }
    return { ok: true };
  } catch {
    console.error('Telegram request failed');
    return { ok: false, reason: 'NETWORK' };
  }
}

function fmtTime(env, ms) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: env.TIME_ZONE || 'UTC', dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));
  } catch { return new Date(ms).toISOString(); }
}

function tgMessage(env, exam, a) {
  const g = a.grading;
  const score = g.pending > 0 ?
    `بانتظار التصحيح اليدوي (${g.pending} سؤال) — الدرجة الحالية ${g.total} / ${g.max}` :
    `${g.total} / ${g.max} (${g.max ? r2((g.total / g.max) * 100) : 0}%)`;
  return [
    '📝 تسليم جديد في QuizCode',
    `الامتحان: ${exam.title}`,
    `الطالب: ${a.name}`,
    a.studentCode ? `كود الطالب: ${a.studentCode}` : null,
    `وقت التسليم: ${fmtTime(env, a.submittedAt)}${a.submitReason === 'timeout' ? ' (انتهى الوقت)' : ''}`,
    `الدرجة: ${score}`,
  ].filter(Boolean).join('\n');
}

/* ───────────── منطق المحاولات المشترك ───────────── */

async function finalizeAttempt(c, exam, a, reason, answers) {
  if (a.status === 'submitted') return a;
  if (answers) a.answers = answers;
  a.status = 'submitted';
  a.submitReason = reason;
  a.submittedAt = reason === 'timeout' ? Math.min(c.now, a.deadline) : c.now;
  a.grading = gradeAttempt(exam, a.answers);
  const notify = tgConfigured(c.env) && !a.notified;
  if (notify) a.notified = true; // يُكتب مع المحاولة نفسها لتقليل تكرار الإشعارات
  await putAttempt(c.env, a);
  if (notify) c.ctx.waitUntil(sendTelegram(c.env, tgMessage(c.env, exam, a)));
  return a;
}

function assertOpen(exam, now) {
  if (!exam.enabled) fail(403, 'EXAM_DISABLED', 'هذا الامتحان غير متاح حاليًا');
  if (exam.opensAt && now < exam.opensAt) fail(403, 'EXAM_NOT_OPEN', 'لم يبدأ وقت هذا الامتحان بعد', { opensAt: exam.opensAt });
  if (exam.closesAt && now > exam.closesAt) fail(403, 'EXAM_CLOSED', 'انتهى وقت الدخول إلى هذا الامتحان');
}
const publicExamInfo = (e) => ({ id: e.id, title: e.title, description: e.description, instructions: e.instructions, durationMinutes: e.durationMinutes, requireStudentCode: e.requireStudentCode, questionCount: e.questions.length, totalPoints: totalPoints(e), opensAt: e.opensAt, closesAt: e.closesAt });

function attemptView(exam, a, now) {
  const base = { examId: exam.id, attemptId: a.id, status: a.status, name: a.name, studentCode: a.studentCode || '', startedAt: a.startedAt, deadline: a.deadline, serverNow: now, durationMinutes: exam.durationMinutes, examTitle: exam.title };
  if (a.status !== 'in_progress') return { ...base, submittedAt: a.submittedAt };
  return { ...base, instructions: exam.instructions, questions: seededShuffle(exam.questions, a.id + ':questions').map((q) => publicQuestion(q, a.id)), answers: a.answers };
}

async function authAttempt(c) {
  const { examId, attemptId, token } = c.body;
  if (!ID_EXAM.test(String(examId)) || !ID_ATTEMPT.test(String(attemptId)) || !ID_TOKEN.test(String(token))) {
    fail(403, 'BAD_ATTEMPT', 'جلسة المحاولة غير صالحة');
  }
  const [exam, a] = await Promise.all([kvGet(c.env, `exam:${examId}`), kvGet(c.env, `att:${examId}:${attemptId}`)]);
  if (!exam || !a || !safeEqual(await sha256Hex(token), a.tokenHash)) fail(403, 'BAD_ATTEMPT', 'جلسة المحاولة غير صالحة');
  return { exam, a };
}
const isExpired = (a, now) => now > a.deadline + GRACE_MS;

/* ───────────── مسارات الطلاب ───────────── */

async function examLookup(c) {
  const code = normalizeCode(c.body.code);
  if (!code || code.length > 40) fail(400, 'BAD_CODE', 'أدخل كود الامتحان');
  const idx = await kvGet(c.env, `code:${code}`);
  if (!idx) fail(404, 'EXAM_NOT_FOUND', 'لا يوجد امتحان بهذا الكود');
  const exam = await getExam(c.env, idx.examId);
  assertOpen(exam, c.now);
  return { ok: true, exam: publicExamInfo(exam) };
}

async function attemptStart(c) {
  const exam = await getExam(c.env, c.body.examId);
  assertOpen(exam, c.now);
  const name = vStr(c.body.name, 'الاسم', 2, 60);
  const studentCode = exam.requireStudentCode ? vStr(c.body.studentCode, 'كود الطالب', 1, 40) : '';
  if (exam.maxParticipants) {
    const n = (await kvList(c.env, `att:${exam.id}:`, exam.maxParticipants + 1)).length;
    if (n >= exam.maxParticipants) fail(403, 'EXAM_FULL', 'اكتمل عدد المشاركين في هذا الامتحان');
  }
  let ident = null;
  if (exam.requireStudentCode) {
    const key = `ident:${exam.id}:${await sha256Hex(normalizeIdent(studentCode))}`;
    ident = { key, rec: (await kvGet(c.env, key)) || { n: 0 } };
    if (exam.maxAttempts && ident.rec.n >= exam.maxAttempts) fail(403, 'ATTEMPTS_EXCEEDED', 'استنفدت عدد المحاولات المسموح بها لهذا الكود');
  }
  const token = randHex(24);
  const a = { id: randHex(8), examId: exam.id, examTitle: exam.title, name, studentCode, startedAt: c.now, deadline: c.now + exam.durationMinutes * 60000, status: 'in_progress', answers: {}, tokenHash: await sha256Hex(token), grading: null };
  await putAttempt(c.env, a);
  if (ident) {
    ident.rec.n += 1;
    await kvPut(c.env, ident.key, ident.rec);
  }
  return { ok: true, token, ...attemptView(exam, a, c.now) };
}

async function attemptState(c) {
  const { exam, a } = await authAttempt(c);
  if (a.status === 'in_progress' && isExpired(a, c.now)) await finalizeAttempt(c, exam, a, 'timeout');
  return { ok: true, ...attemptView(exam, a, c.now) };
}

async function attemptSave(c) {
  const { exam, a } = await authAttempt(c);
  if (a.status === 'submitted') fail(409, 'ATTEMPT_SUBMITTED', 'تم تسليم الامتحان ولا يمكن تعديل الإجابات');
  if (isExpired(a, c.now)) {
    await finalizeAttempt(c, exam, a, 'timeout');
    fail(409, 'ATTEMPT_EXPIRED', 'انتهى وقت الامتحان وتم تسليمه بآخر إجابات محفوظة');
  }
  const clean = sanitizeAnswers(exam, c.body.answers);
  const changed = JSON.stringify(clean) !== JSON.stringify(a.answers);
  if (changed) {
    a.answers = clean;
    a.savedAt = c.now;
    await putAttempt(c.env, a);
  }
  return { ok: true, saved: changed, serverNow: c.now, deadline: a.deadline };
}

async function attemptSubmit(c) {
  const { exam, a } = await authAttempt(c);
  if (a.status === 'submitted') return { ok: true, status: 'submitted', alreadySubmitted: true, resultVisible: isVisible(exam, { status: a.status, pending: a.grading.pending, override: a.override }) };
  if (isExpired(a, c.now)) await finalizeAttempt(c, exam, a, 'timeout');
  else await finalizeAttempt(c, exam, a, c.now >= a.deadline ? 'timeout' : 'manual', c.body.answers === undefined ? null : sanitizeAnswers(exam, c.body.answers));
  return { ok: true, status: 'submitted', alreadySubmitted: false, resultVisible: isVisible(exam, { status: a.status, pending: a.grading.pending, override: a.override }) };
}

async function attemptResult(c) {
  const { exam, a } = await authAttempt(c);
  if (a.status === 'in_progress' && isExpired(a, c.now)) await finalizeAttempt(c, exam, a, 'timeout');
  if (a.status !== 'submitted') return { ok: true, status: 'in_progress', visible: false };
  const visible = isVisible(exam, { status: a.status, pending: a.grading.pending, override: a.override });
  const base = { ok: true, status: 'submitted', visible, examTitle: exam.title, name: a.name, studentCode: a.studentCode || '', submittedAt: a.submittedAt };
  if (!visible) {
    const reason = a.override === false ? 'hidden' : exam.resultMode === 'auto' ? 'pending_grading' : 'not_published';
    return { ...base, reason };
  }
  const g = a.grading;
  const percent = g.max ? r2((g.total / g.max) * 100) : 0;
  const result = { total: g.total, max: g.max, percent, passed: exam.passPercent === null ? null : percent >= exam.passPercent, pending: g.pending };
  if (exam.showReview) result.review = buildReview(exam, a, false);
  return { ...base, result };
}

/* ───────────── مسارات الإدارة ───────────── */

async function adminStatus(c) {
  return { ok: true, initialized: !!(await kvGet(c.env, 'admin:cred')), setupConfigured: !!c.env.SETUP_TOKEN };
}

async function adminSetup(c) {
  if (!c.env.SETUP_TOKEN) fail(503, 'SETUP_NOT_CONFIGURED', 'لم يتم ضبط السر SETUP_TOKEN في Cloudflare');
  const rl = await rlCheck(c.env, 'setup', c.request, c.now);
  const ok = typeof c.body.setupToken === 'string' && (await safeEqualSecret(c.body.setupToken, c.env.SETUP_TOKEN));
  if (!ok) {
    await rlFail(c.env, rl);
    fail(403, 'BAD_SETUP_TOKEN', 'رمز التهيئة غير صحيح');
  }
  const existing = await kvGet(c.env, 'admin:cred');
  if (existing && c.body.reset !== true) fail(409, 'ALREADY_INITIALIZED', 'تمت التهيئة مسبقًا. لإعادة ضبط كلمة المرور أرسل reset=true مع رمز التهيئة');
  vPassword(c.body.password);
  await saveCred(c.env, c.body.password, c.now); // epoch جديد يُبطل كل الجلسات القديمة
  await rlClear(c.env, rl);
  return { ok: true, reset: !!existing };
}

async function adminLogin(c) {
  const rl = await rlCheck(c.env, 'login', c.request, c.now);
  const cred = await kvGet(c.env, 'admin:cred');
  if (!cred) fail(409, 'NOT_INITIALIZED', 'لم تتم تهيئة كلمة مرور الإدارة بعد');
  if (!(await verifyPassword(c.env, cred, c.body.password))) {
    await rlFail(c.env, rl);
    fail(401, 'BAD_CREDENTIALS', 'كلمة المرور غير صحيحة');
  }
  await rlClear(c.env, rl);
  const ms = sessionMs(c.env);
  const token = randHex(32);
  await kvPut(c.env, `sess:${await sha256Hex(token)}`, { exp: c.now + ms, epoch: cred.epoch }, { expirationTtl: Math.ceil(ms / 1000) });
  return { ok: true, token, expiresAt: c.now + ms };
}

async function adminLogout(c) {
  await c.env.QUIZCODE_KV.delete(c.admin.sessionKey);
  return { ok: true };
}

async function adminChangePassword(c) {
  const rl = await rlCheck(c.env, 'chpw', c.request, c.now);
  const cred = await kvGet(c.env, 'admin:cred');
  if (!cred || !(await verifyPassword(c.env, cred, c.body.currentPassword))) {
    await rlFail(c.env, rl);
    fail(403, 'BAD_CREDENTIALS', 'كلمة المرور الحالية غير صحيحة');
  }
  vPassword(c.body.newPassword);
  await saveCred(c.env, c.body.newPassword, c.now);
  await rlClear(c.env, rl);
  return { ok: true, loggedOut: true };
}

async function adminListExams(c) {
  const keys = await kvList(c.env, 'exam:', 1000);
  const exams = keys.filter((k) => k.metadata).map((k) => {
    const m = k.metadata;
    return { id: m.id, title: m.t, code: m.c, enabled: m.en, questionCount: m.qc, totalPoints: m.tp, durationMinutes: m.d, opensAt: m.o, closesAt: m.cl, resultMode: m.rm, resultsPublished: m.rp, updatedAt: m.u };
  }).sort((x, y) => y.updatedAt - x.updatedAt);
  return { ok: true, exams };
}

async function adminGetExam(c) {
  return { ok: true, exam: await getExam(c.env, idParam(c.url, 'id')) };
}

async function adminSaveExam(c) {
  const input = c.body.exam;
  if (!input || typeof input !== 'object') fail(400, 'VALIDATION', 'بيانات الامتحان مفقودة');
  let existing = null;
  if (input.id !== undefined && input.id !== null && input.id !== '') existing = await getExam(c.env, input.id);
  const exam = normalizeExam(input, { id: existing ? existing.id : randHex(6), resultsPublished: existing ? existing.resultsPublished : false, createdAt: existing ? existing.createdAt : c.now, now: c.now });
  const owner = await kvGet(c.env, `code:${exam.code}`);
  if (owner && owner.examId !== exam.id) fail(409, 'CODE_TAKEN', 'هذا الكود مستخدم في امتحان آخر');
  if (existing && JSON.stringify(existing.questions) !== JSON.stringify(exam.questions)) {
    const has = await c.env.QUIZCODE_KV.list({ prefix: `att:${exam.id}:`, limit: 1 });
    if (has.keys.length) fail(409, 'EXAM_HAS_ATTEMPTS', 'لا يمكن تعديل الأسئلة بعد وجود محاولات. انسخ الامتحان لإنشاء نسخة جديدة.');
  }
  await putExam(c.env, exam);
  await kvPut(c.env, `code:${exam.code}`, { examId: exam.id });
  if (existing && existing.code !== exam.code) await c.env.QUIZCODE_KV.delete(`code:${existing.code}`);
  return { ok: true, exam };
}

async function adminDuplicateExam(c) {
  const src = await getExam(c.env, c.body.id);
  let code = null;
  for (let i = 0; i < 6 && !code; i++) {
    const cand = `${src.code.slice(0, 19)}-${randHex(2).toUpperCase()}`;
    if (!(await kvGet(c.env, `code:${cand}`))) code = cand;
  }
  if (!code) fail(500, 'INTERNAL', 'تعذر توليد كود جديد');
  const copy = { ...src, id: randHex(6), code, title: `${src.title} (نسخة)`.slice(0, 120), enabled: false, resultsPublished: false, createdAt: c.now, updatedAt: c.now };
  await putExam(c.env, copy);
  await kvPut(c.env, `code:${code}`, { examId: copy.id });
  return { ok: true, exam: copy };
}

async function adminToggleExam(c) {
  const exam = await getExam(c.env, c.body.id);
  const enabled = c.body.enabled === true;
  if (enabled && !exam.questions.length) fail(400, 'VALIDATION', 'لا يمكن تفعيل امتحان بدون أسئلة');
  exam.enabled = enabled;
  exam.updatedAt = c.now;
  await putExam(c.env, exam);
  return { ok: true, enabled };
}

async function adminDeleteExam(c) {
  const exam = await getExam(c.env, c.body.id);
  const atts = await kvList(c.env, `att:${exam.id}:`, 500);
  for (const k of atts) await c.env.QUIZCODE_KV.delete(k.name);
  if (atts.length >= 500) return { ok: true, complete: false }; // كرّر الحذف لإكمال الباقي
  for (const k of await kvList(c.env, `ident:${exam.id}:`, 1000)) await c.env.QUIZCODE_KV.delete(k.name);
  await c.env.QUIZCODE_KV.delete(`exam:${exam.id}`);
  await c.env.QUIZCODE_KV.delete(`code:${exam.code}`);
  return { ok: true, complete: true };
}

function attemptRow(exam, m, now) {
  const has = m.t !== null && m.t !== undefined;
  const percent = has && m.m ? r2((m.t / m.m) * 100) : null;
  return {
    attemptId: m.id,
    name: m.n,
    studentCode: m.c,
    status: m.s === 'submitted' ? 'submitted' : now > m.dl + GRACE_MS ? 'expired' : 'in_progress',
    startedAt: m.st,
    submittedAt: m.sb || null,
    deadline: m.dl,
    total: m.t,
    max: m.m,
    percent,
    passed: percent !== null && exam.passPercent !== null ? percent >= exam.passPercent : null,
    pending: m.p || 0,
    gradingStatus: !has ? 'none' : m.p > 0 ? 'pending' : 'done',
    override: m.o,
    visible: isVisible(exam, { status: m.s, pending: m.p, override: m.o }),
  };
}

async function loadAttemptRows(c, exam) {
  const keys = await kvList(c.env, `att:${exam.id}:`, 3000);
  let budget = 20; // أقصى عدد محاولات منتهية يتم تسليمها تلقائيًا في الطلب الواحد
  const rows = [];
  for (const k of keys) {
    let m = k.metadata;
    if (!m) continue;
    if (m.s === 'in_progress' && c.now > m.dl + GRACE_MS && budget > 0) {
      budget--;
      const a = await kvGet(c.env, k.name);
      if (a && a.status === 'in_progress') m = attemptMeta(await finalizeAttempt(c, exam, a, 'timeout'));
    }
    rows.push(attemptRow(exam, m, c.now));
  }
  return rows.sort((x, y) => y.startedAt - x.startedAt);
}

async function adminListAttempts(c) {
  const exam = await getExam(c.env, idParam(c.url, 'examId'));
  const attempts = await loadAttemptRows(c, exam);
  return { ok: true, exam: { id: exam.id, title: exam.title, resultMode: exam.resultMode, resultsPublished: exam.resultsPublished, passPercent: exam.passPercent, totalPoints: totalPoints(exam) }, attempts };
}

async function adminGetAttempt(c) {
  const exam = await getExam(c.env, idParam(c.url, 'examId'));
  const a = await getAttempt(c.env, exam.id, c.url.searchParams.get('attemptId'));
  if (a.status === 'in_progress' && isExpired(a, c.now)) await finalizeAttempt(c, exam, a, 'timeout');
  const { tokenHash, ...safe } = a;
  const g = a.grading;
  return {
    ok: true,
    attempt: { ...safe, answers: undefined, grading: g ? { total: g.total, max: g.max, pending: g.pending } : null, visible: isVisible(exam, { status: a.status, pending: g ? g.pending : 0, override: a.override }) },
    exam: { id: exam.id, title: exam.title, resultMode: exam.resultMode, resultsPublished: exam.resultsPublished, passPercent: exam.passPercent },
    review: g ? buildReview(exam, a, true) : [],
  };
}

async function adminGrade(c) {
  const exam = await getExam(c.env, c.body.examId);
  const a = await getAttempt(c.env, exam.id, c.body.attemptId);
  if (a.status !== 'submitted' || !a.grading) fail(409, 'NOT_SUBMITTED', 'لا يمكن تصحيح محاولة لم تُسلَّم بعد');
  const q = exam.questions.find((x) => x.id === c.body.questionId);
  if (!q || kindOf(q) !== 'essay') fail(400, 'VALIDATION', 'هذا السؤال ليس مقاليًا');
  const it = a.grading.items[q.id];
  if (!it || it.status === 'unanswered') fail(409, 'NOTHING_TO_GRADE', 'لا توجد إجابة لتصحيحها');
  const score = typeof c.body.score === 'string' && c.body.score.trim() !== '' ? Number(c.body.score) : c.body.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > q.points) fail(400, 'BAD_SCORE', `الدرجة يجب أن تكون بين 0 و${q.points}`);
  it.score = r2(score);
  it.status = 'graded';
  it.gradedAt = c.now;
  const note = vOptStr(c.body.note, 1000, 'الملاحظة');
  if (note) it.note = note;
  else delete it.note;
  a.grading = summarize(exam, a.grading.items);
  await putAttempt(c.env, a);
  return { ok: true, grading: { total: a.grading.total, max: a.grading.max, pending: a.grading.pending }, item: it };
}

async function adminPublish(c) {
  const exam = await getExam(c.env, c.body.examId);
  const action = c.body.action;
  if (!['publish', 'hide', 'reset'].includes(action)) fail(400, 'VALIDATION', 'إجراء غير صالح');
  if (c.body.attemptId) {
    const a = await getAttempt(c.env, exam.id, c.body.attemptId);
    if (action === 'publish') a.override = true;
    else if (action === 'hide') a.override = false;
    else delete a.override;
    await putAttempt(c.env, a);
    return { ok: true, scope: 'attempt', override: a.override === undefined ? null : a.override };
  }
  if (exam.resultMode !== 'manual') fail(400, 'VALIDATION', 'النشر على مستوى الامتحان يعمل في الوضع اليدوي فقط. استخدم نشر محاولة محددة أو غيّر الوضع.');
  if (action === 'reset') fail(400, 'VALIDATION', 'إجراء غير صالح');
  exam.resultsPublished = action === 'publish';
  exam.updatedAt = c.now;
  await putExam(c.env, exam);
  return { ok: true, scope: 'exam', resultsPublished: exam.resultsPublished };
}

const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // منع حقن الصيغ في Excel
  return '"' + s.replace(/"/g, '""') + '"';
};
async function adminExport(c) {
  const exam = await getExam(c.env, idParam(c.url, 'examId'));
  const tz = Math.max(-840, Math.min(840, parseInt(c.url.searchParams.get('tz'), 10) || 0));
  const fd = (ms) => (ms ? new Date(ms + tz * 60000).toISOString().replace('T', ' ').slice(0, 19) : '');
  const statusAr = { submitted: 'تم التسليم', expired: 'انتهى الوقت', in_progress: 'جارية' };
  const head = ['الامتحان', 'اسم الطالب', 'كود الطالب', 'وقت البدء', 'وقت التسليم', 'حالة المحاولة', 'الدرجة', 'الدرجة القصوى', 'النسبة %', 'النتيجة', 'حالة التصحيح', 'حالة النشر'];
  const lines = [head.map(csvCell).join(',')];
  for (const r of await loadAttemptRows(c, exam)) {
    lines.push([
      exam.title, r.name, r.studentCode, fd(r.startedAt), fd(r.submittedAt), statusAr[r.status],
      r.total, r.max, r.percent, r.passed === null ? '' : r.passed ? 'ناجح' : 'راسب',
      r.gradingStatus === 'none' ? '' : r.gradingStatus === 'pending' ? `بانتظار التصحيح (${r.pending})` : 'مكتمل',
      r.status !== 'submitted' ? '' : r.visible ? 'منشورة' : 'غير منشورة',
    ].map(csvCell).join(','));
  }
  return { __csv: '\uFEFF' + lines.join('\r\n'), filename: `results-${exam.id}.csv` };
}

async function adminTelegramTest(c) {
  if (!tgConfigured(c.env)) fail(400, 'TELEGRAM_NOT_CONFIGURED', 'لم يتم ضبط TG_TOKEN و TG_CHAT في Cloudflare');
  const r = await sendTelegram(c.env, '✅ اختبار اتصال QuizCode: الإشعارات تعمل.');
  if (!r.ok) fail(502, 'TELEGRAM_FAILED', 'تعذر الإرسال إلى Telegram. تحقق من TG_TOKEN و TG_CHAT.', { reason: r.reason });
  return { ok: true };
}

/* ───────────── التوجيه ───────────── */

const ROUTES = {
  'GET /api/health': { fn: (c) => ({ ok: true, serverNow: c.now }) },
  'GET /api/admin/status': { fn: adminStatus },
  'POST /api/admin/setup': { fn: adminSetup },
  'POST /api/admin/login': { fn: adminLogin },
  'POST /api/admin/logout': { admin: true, fn: adminLogout },
  'POST /api/admin/change-password': { admin: true, fn: adminChangePassword },
  'GET /api/admin/exams': { admin: true, fn: adminListExams },
  'GET /api/admin/exam': { admin: true, fn: adminGetExam },
  'POST /api/admin/exam/save': { admin: true, fn: adminSaveExam },
  'POST /api/admin/exam/duplicate': { admin: true, fn: adminDuplicateExam },
  'POST /api/admin/exam/toggle': { admin: true, fn: adminToggleExam },
  'POST /api/admin/exam/delete': { admin: true, fn: adminDeleteExam },
  'GET /api/admin/attempts': { admin: true, fn: adminListAttempts },
  'GET /api/admin/attempt': { admin: true, fn: adminGetAttempt },
  'POST /api/admin/grade': { admin: true, fn: adminGrade },
  'POST /api/admin/publish': { admin: true, fn: adminPublish },
  'GET /api/admin/export': { admin: true, fn: adminExport },
  'POST /api/admin/telegram-test': { admin: true, fn: adminTelegramTest },
  'POST /api/exam/lookup': { fn: examLookup },
  'POST /api/attempt/start': { fn: attemptStart },
  'POST /api/attempt/state': { fn: attemptState },
  'POST /api/attempt/save': { fn: attemptSave },
  'POST /api/attempt/submit': { fn: attemptSubmit },
  'POST /api/attempt/result': { fn: attemptResult },
};

async function handle(request, env, ctx) {
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') {
    if (origin && !isAllowedOrigin(origin, env)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  if (origin && !isAllowedOrigin(origin, env)) fail(403, 'ORIGIN_NOT_ALLOWED', 'هذا الموقع غير مسموح له بالاتصال بالخادم');
  if (!env.QUIZCODE_KV) fail(500, 'KV_NOT_BOUND', 'إعداد KV غير مكتمل على الخادم');
  const url = new URL(request.url);
  const route = ROUTES[`${request.method} ${url.pathname.replace(/\/+$/, '')}`];
  if (!route) fail(404, 'NOT_FOUND', 'المسار غير موجود');
  const c = { request, env, ctx, url, now: Date.now(), body: {} };
  if (request.method === 'POST') c.body = await readJson(request);
  if (route.admin) c.admin = await requireAdmin(request, env, c.now);
  const out = await route.fn(c);
  if (out && out.__csv !== undefined) {
    return respond(request, env, out.__csv, 200, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${out.filename}"` });
  }
  return respondJson(request, env, out);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        return respondJson(request, env, { ok: false, error: { code: e.code, message: e.message, ...e.extra } }, e.status);
      }
      console.error('Unhandled error:', e && e.name ? e.name : 'Error'); // لا نسجل الرسائل الكاملة لتجنب تسريب بيانات
      return respondJson(request, env, { ok: false, error: { code: 'INTERNAL', message: 'حدث خطأ غير متوقع في الخادم' } }, 500);
    }
  },
};
