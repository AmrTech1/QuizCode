// اختبار دخاني محلي للـ Worker باستخدام KV وهمي في الذاكرة (لا يحتاج Cloudflare).
// التشغيل: node tests/smoke.mjs   (يتطلب Node 18 أو أحدث)
import worker from '../worker/index.js';

class MemKV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); if (!v) return null; return type === 'json' ? JSON.parse(v.value) : v.value; }
  async put(k, value, opts = {}) { this.m.set(k, { value, metadata: opts.metadata === undefined ? null : JSON.parse(JSON.stringify(opts.metadata)) }); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = '', limit = 1000 } = {}) {
    const keys = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name, metadata: this.m.get(name).metadata || undefined }));
    return { keys, list_complete: true };
  }
}

const ORIGIN = 'https://app.test';
const kv = new MemKV();
const env = { QUIZ_KV: kv, SETUP_TOKEN: 'setup-secret-for-tests', ALLOWED_ORIGINS: ORIGIN, PBKDF2_ITERATIONS: '10000' };
const ctx = { waitUntil: (p) => p };
let adminToken = null;

const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

async function api(method, path, body, { admin = false, origin = ORIGIN, raw = false } = {}) {
  const headers = { Origin: origin, 'CF-Connecting-IP': '203.0.113.7' };
  if (body) headers['Content-Type'] = 'application/json';
  if (admin) headers.Authorization = 'Bearer ' + adminToken;
  const res = await worker.fetch(new Request('https://w.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  if (raw) return res;
  const { status: attemptStatus, ...rest } = await res.json(); // status في الجسم = حالة المحاولة، وليس حالة HTTP
  return { status: res.status, attemptStatus, ...rest };
}

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log('  ✓', name);
  } else {
    failed++;
    console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

const examInput = (over = {}) => ({
  title: 'امتحان تجريبي',
  description: 'وصف',
  instructions: 'اقرأ بتمعن',
  code: 'demo-1',
  durationMinutes: 30,
  enabled: true,
  resultMode: 'auto',
  requireStudentCode: true,
  maxAttempts: 1,
  passPercent: 50,
  showReview: true,
  questions: [
    { id: 'q1', type: 'single', text: 'سؤال 1', points: 2, options: [{ id: 'a', text: 'أ' }, { id: 'b', text: 'ب' }], correct: 'a', explanation: 'شرح سري' },
    { id: 'q2', type: 'multi', text: 'سؤال 2', points: 3, options: [{ id: 'a', text: '1' }, { id: 'b', text: '2' }, { id: 'c', text: '3' }], correct: ['a', 'c'] },
    { id: 'q3', type: 'tf', text: 'سؤال 3', points: 1, correct: true },
    { id: 'q4', type: 'short', text: 'عاصمة مصر؟', points: 2, accepted: ['القاهرة', 'Cairo'] },
    { id: 'q5', type: 'fill', text: 'اثنان + اثنان = ___ ، وثلاثة × اثنان = ___', points: 4, blanks: [{ accepted: ['4', 'أربعة'] }, { accepted: ['ستة', '6'] }] },
    { id: 'q6', type: 'order', text: 'رتب', points: 3, items: [{ id: 'i1', text: 'أول' }, { id: 'i2', text: 'ثاني' }, { id: 'i3', text: 'ثالث' }] },
    { id: 'q7', type: 'image', subtype: 'single', text: 'ما في الصورة؟', points: 1, imageUrl: 'https://example.com/x.png', options: [{ id: 'a', text: 'قطة' }, { id: 'b', text: 'كلب' }], correct: 'a' },
    { id: 'q8', type: 'essay', text: 'اشرح', points: 5, rubric: 'معيار سري' },
  ],
  ...over,
});

console.log('1) الإعداد وتسجيل الدخول');
let r = await api('GET', '/api/health');
check('health', r.status === 200 && r.ok);
r = await api('GET', '/api/health', null, { origin: 'https://evil.test' });
check('رفض Origin غير مسموح', r.status === 403 && r.error.code === 'ORIGIN_NOT_ALLOWED');
const pre = await worker.fetch(new Request('https://w.test/api/admin/login', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env, ctx);
check('OPTIONS/CORS', pre.status === 204 && pre.headers.get('Access-Control-Allow-Origin') === ORIGIN);
r = await api('GET', '/api/admin/status');
check('الحالة: غير مهيأ', r.initialized === false && r.setupConfigured === true);
r = await api('POST', '/api/admin/setup', { setupToken: 'wrong', password: 'a-long-password-123' });
check('رفض رمز تهيئة خاطئ', r.status === 403 && r.error.code === 'BAD_SETUP_TOKEN');
r = await api('POST', '/api/admin/setup', { setupToken: env.SETUP_TOKEN, password: 'short' });
check('رفض كلمة مرور ضعيفة', r.status === 400);
r = await api('POST', '/api/admin/setup', { setupToken: env.SETUP_TOKEN, password: 'a-long-password-123' });
check('تهيئة ناجحة', r.status === 200 && r.ok);
check('لا تخزين لكلمة المرور كنص صريح', !JSON.stringify([...kv.m.values()]).includes('a-long-password-123'));
r = await api('POST', '/api/admin/setup', { setupToken: env.SETUP_TOKEN, password: 'another-password-1' });
check('منع إعادة التهيئة بدون reset', r.status === 409);
r = await api('GET', '/api/admin/exams');
check('رفض العملية الإدارية بدون جلسة', r.status === 401);
r = await api('POST', '/api/admin/login', { password: 'wrong-password-1' });
check('رفض كلمة مرور خاطئة', r.status === 401);
r = await api('POST', '/api/admin/login', { password: 'a-long-password-123' });
check('تسجيل دخول ناجح', r.status === 200 && /^[a-f0-9]{64}$/.test(r.token));
adminToken = r.token;
for (let i = 0; i < 5; i++) await api('POST', '/api/admin/login', { password: 'bad-bad-bad-bad' });
r = await api('POST', '/api/admin/login', { password: 'a-long-password-123' });
check('تقييد المحاولات المتكررة (429)', r.status === 429);
kv.m.forEach((_, k) => { if (k.startsWith('rl:')) kv.m.delete(k); });

console.log('2) إنشاء الامتحان');
r = await api('POST', '/api/admin/exam/save', { exam: examInput({ questions: [{ type: 'single', text: 'x', points: 1, options: [{ text: 'a' }, { text: 'b' }], correct: 'zzz' }] }) }, { admin: true });
check('رفض سؤال بإجابة صحيحة غير موجودة', r.status === 400);
r = await api('POST', '/api/admin/exam/save', { exam: examInput({ questions: [{ type: 'image', text: 'x', points: 1, imageUrl: 'http://insecure.test/a.png', options: [{ text: 'a' }, { text: 'b' }], correct: 'a' }] }) }, { admin: true });
check('رفض صورة غير HTTPS', r.status === 400);
r = await api('POST', '/api/admin/exam/save', { exam: examInput() }, { admin: true });
check('إنشاء امتحان', r.status === 200 && r.exam.code === 'DEMO-1');
const examId = r.exam.id;
r = await api('POST', '/api/admin/exam/save', { exam: examInput({ title: 'آخر' }) }, { admin: true });
check('رفض كود مكرر', r.status === 409 && r.error.code === 'CODE_TAKEN');
r = await api('GET', '/api/admin/exams', null, { admin: true });
check('قائمة الامتحانات من metadata', r.exams.length === 1 && r.exams[0].questionCount === 8 && r.exams[0].totalPoints === 21);

console.log('3) دخول الطالب (بدون كشف الإجابات)');
r = await api('POST', '/api/exam/lookup', { code: ' demo-1 ' });
check('lookup يطبّع الكود', r.status === 200 && r.exam.id === examId);
check('lookup لا يعيد الأسئلة', !('questions' in r.exam));
r = await api('POST', '/api/exam/lookup', { code: 'NOPE' });
check('كود غير موجود', r.status === 404 && r.error.code === 'EXAM_NOT_FOUND');
r = await api('POST', '/api/attempt/start', { examId, name: 'ط', studentCode: 'S1' });
check('رفض اسم قصير', r.status === 400);
r = await api('POST', '/api/attempt/start', { examId, name: 'أحمد علي' });
check('رفض غياب كود الطالب عند تفعيله', r.status === 400);
const startRaw = await api('POST', '/api/attempt/start', { examId, name: 'أحمد علي', studentCode: 'S-١٠١' }, { raw: true });
const startText = await startRaw.text();
const start = JSON.parse(startText);
check('بدء المحاولة', startRaw.status === 200 && start.questions.length === 8);
check('لا تسريب للإجابات الصحيحة', !/"correct"|"accepted"|"blanks"|explanation|rubric|شرح سري|معيار سري/.test(startText));
check('عنصر الترتيب مخلوط وليس بالترتيب الصحيح', start.questions[5].items.map((i) => i.id).join() !== 'i1,i2,i3');
const cred = { examId, attemptId: start.attemptId, token: start.token };
r = await api('POST', '/api/attempt/start', { examId, name: 'أحمد علي', studentCode: 's-101' });
check('منع تجاوز عدد المحاولات (كود مطبّع)', r.status === 403 && r.error.code === 'ATTEMPTS_EXCEEDED');
r = await api('POST', '/api/attempt/state', { ...cred, token: 'f'.repeat(48) });
check('رفض توكن خاطئ', r.status === 403);

console.log('4) الحفظ والتسليم');
const answers = { q1: 'a', q2: ['c', 'a'], q3: false, q4: 'الْقَاهِرَة', q5: ['٤', 'خمسة'], q6: ['i1', 'i2', 'i3'], q7: 'b', q8: 'إجابة مقالية', bogus: 'x' };
const writesBefore = [...kv.m.keys()].length;
r = await api('POST', '/api/attempt/save', { ...cred, answers });
check('حفظ الإجابات', r.status === 200 && r.saved === true);
r = await api('POST', '/api/attempt/save', { ...cred, answers });
check('الحفظ المتطابق لا يكتب مجددًا', r.status === 200 && r.saved === false);
r = await api('POST', '/api/attempt/state', cred);
check('استرجاع الإجابات', r.status === 200 && r.answers.q1 === 'a' && r.answers.bogus === undefined);
r = await api('POST', '/api/attempt/result', cred);
check('النتيجة قبل التسليم غير متاحة', r.status === 200 && r.attemptStatus === 'in_progress' && r.visible === false);
r = await api('POST', '/api/attempt/submit', { ...cred, answers });
check('تسليم', r.status === 200 && r.alreadySubmitted === false);
check('وضع تلقائي: النتيجة مخفية حتى تصحيح المقال', r.resultVisible === false);
r = await api('POST', '/api/attempt/submit', { ...cred, answers: { q1: 'b' } });
check('تسليم مكرر لا يُحتسب', r.status === 200 && r.alreadySubmitted === true);
r = await api('POST', '/api/attempt/save', { ...cred, answers: { q1: 'b' } });
check('منع التعديل بعد التسليم', r.status === 409 && r.error.code === 'ATTEMPT_SUBMITTED');
r = await api('POST', '/api/attempt/result', cred);
check('سبب الإخفاء: بانتظار التصحيح', r.visible === false && r.reason === 'pending_grading' && !('result' in r));

console.log('5) تصحيح المقال والنشر');
r = await api('GET', `/api/admin/attempts?examId=${examId}`, null, { admin: true });
check('قائمة المحاولات', r.attempts.length === 1 && r.attempts[0].pending === 1 && r.attempts[0].total === 12 && r.attempts[0].max === 21, r.attempts && r.attempts[0]);
r = await api('GET', `/api/admin/attempt?examId=${examId}&attemptId=${cred.attemptId}`, null, { admin: true });
check('الإدارة ترى الإجابات الصحيحة ومعيار التصحيح', r.review[7].question.rubric === 'معيار سري' && JSON.stringify(r.review[0].correct) === '"a"');
r = await api('POST', '/api/admin/grade', { examId, attemptId: cred.attemptId, questionId: 'q8', score: 6 }, { admin: true });
check('رفض درجة أكبر من الحد الأقصى', r.status === 400 && r.error.code === 'BAD_SCORE');
r = await api('POST', '/api/admin/grade', { examId, attemptId: cred.attemptId, questionId: 'q1', score: 1 }, { admin: true });
check('رفض تصحيح سؤال غير مقالي', r.status === 400);
r = await api('POST', '/api/admin/grade', { examId, attemptId: cred.attemptId, questionId: 'q8', score: 4, note: 'جيد' }, { admin: true });
check('تصحيح المقال وإعادة الحساب', r.status === 200 && r.grading.total === 16 && r.grading.pending === 0, r.grading);
r = await api('POST', '/api/attempt/result', cred);
check('النتيجة تظهر تلقائيًا بعد التصحيح', r.visible === true && r.result.total === 16 && r.result.max === 21 && r.result.percent === 76.19 && r.result.passed === true, r.result);
check('المراجعة تتضمن الإجابات الصحيحة عند تفعيل showReview', Array.isArray(r.result.review) && r.result.review[7].note === 'جيد');
r = await api('POST', '/api/admin/grade', { examId, attemptId: cred.attemptId, questionId: 'q8', score: 2 }, { admin: true });
check('تعديل الدرجة لاحقًا يحدّث النتيجة', r.grading.total === 14);
r = await api('POST', '/api/admin/publish', { examId, attemptId: cred.attemptId, action: 'hide' }, { admin: true });
r = await api('POST', '/api/attempt/result', cred);
check('إخفاء النتيجة يدويًا', r.visible === false && r.reason === 'hidden');
await api('POST', '/api/admin/publish', { examId, attemptId: cred.attemptId, action: 'reset' }, { admin: true });

console.log('6) التعديل والنسخ والتصدير');
let saved = (await api('GET', `/api/admin/exam?id=${examId}`, null, { admin: true })).exam;
r = await api('POST', '/api/admin/exam/save', { exam: { ...saved, questions: saved.questions.slice(0, 3) } }, { admin: true });
check('منع تعديل الأسئلة بعد وجود محاولات', r.status === 409 && r.error.code === 'EXAM_HAS_ATTEMPTS');
r = await api('POST', '/api/admin/exam/save', { exam: { ...saved, title: 'عنوان جديد', resultMode: 'manual' } }, { admin: true });
check('تعديل الإعدادات مسموح', r.status === 200 && r.exam.title === 'عنوان جديد');
r = await api('POST', '/api/attempt/result', cred);
check('وضع يدوي: النتيجة مخفية حتى النشر', r.visible === false && r.reason === 'not_published');
r = await api('POST', '/api/admin/publish', { examId, action: 'publish' }, { admin: true });
r = await api('POST', '/api/attempt/result', cred);
check('نشر الامتحان يُظهر النتيجة', r.visible === true);
const csv = await api('GET', `/api/admin/export?examId=${examId}&tz=0`, null, { admin: true, raw: true });
const csvBytes = new Uint8Array(await csv.arrayBuffer());
const csvText = new TextDecoder().decode(csvBytes);
check('تصدير CSV مع BOM وبيانات الطالب', csv.status === 200 && csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf && csvText.includes('أحمد علي') && csvText.includes('منشورة'));
r = await api('POST', '/api/admin/exam/duplicate', { id: examId }, { admin: true });
check('نسخ الامتحان (معطّل بكود جديد)', r.status === 200 && r.exam.enabled === false && r.exam.code !== 'DEMO-1');
const copyId = r.exam.id;
r = await api('POST', '/api/exam/lookup', { code: r.exam.code });
check('امتحان معطّل غير متاح للطلاب', r.status === 403 && r.error.code === 'EXAM_DISABLED');
r = await api('POST', '/api/admin/exam/toggle', { id: copyId, enabled: true }, { admin: true });
check('تفعيل الامتحان', r.enabled === true);
r = await api('POST', '/api/admin/exam/delete', { id: copyId }, { admin: true });
check('حذف الامتحان', r.complete === true && !(await kv.get(`exam:${copyId}`)));

console.log('7) انتهاء الوقت وقيود الفتح');
r = await api('POST', '/api/admin/exam/save', { exam: examInput({ code: 'TIMED', requireStudentCode: false, maxAttempts: null, maxParticipants: 1, durationMinutes: 1, opensAt: Date.now() + 3600000 }) }, { admin: true });
const timedId = r.exam.id;
r = await api('POST', '/api/exam/lookup', { code: 'timed' });
check('امتحان لم يفتح بعد', r.status === 403 && r.error.code === 'EXAM_NOT_OPEN' && r.error.opensAt > Date.now());
skew = 3700000;
r = await api('POST', '/api/attempt/start', { examId: timedId, name: 'سارة' });
check('بدء بعد وقت الفتح', r.status === 200, r.error);
const tc = { examId: timedId, attemptId: r.attemptId, token: r.token };
r = await api('POST', '/api/attempt/start', { examId: timedId, name: 'طالب ثان' });
check('حد المشاركين', r.status === 403 && r.error.code === 'EXAM_FULL');
await api('POST', '/api/attempt/save', { ...tc, answers: { q1: 'a' } });
skew += 5 * 60000;
r = await api('POST', '/api/attempt/save', { ...tc, answers: { q1: 'b', q3: true } });
check('رفض الحفظ بعد انتهاء الوقت مع تسليم تلقائي', r.status === 409 && r.error.code === 'ATTEMPT_EXPIRED');
r = await api('POST', '/api/attempt/state', tc);
check('الحالة بعد الانتهاء: مسلّمة', r.status === 200 && r.attemptStatus === 'submitted' && r.submittedAt > 0, r);
r = await api('GET', `/api/admin/attempt?examId=${timedId}&attemptId=${tc.attemptId}`, null, { admin: true });
check('التصحيح استخدم آخر إجابات محفوظة فقط', r.review[0].answer === 'a' && r.review[2].answer === null && r.attempt.submitReason === 'timeout');

console.log('8) تسجيل الخروج وتغيير كلمة المرور');
r = await api('POST', '/api/admin/logout', {}, { admin: true });
r = await api('GET', '/api/admin/exams', null, { admin: true });
check('الجلسة تبطل بعد الخروج', r.status === 401);
r = await api('POST', '/api/admin/login', { password: 'a-long-password-123' });
adminToken = r.token;
r = await api('POST', '/api/admin/change-password', { currentPassword: 'a-long-password-123', newPassword: 'brand-new-password-9' }, { admin: true });
check('تغيير كلمة المرور', r.status === 200 && r.loggedOut === true);
r = await api('GET', '/api/admin/exams', null, { admin: true });
check('تغيير كلمة المرور يبطل الجلسات القديمة', r.status === 401);
r = await api('POST', '/api/admin/login', { password: 'brand-new-password-9' });
check('الدخول بكلمة المرور الجديدة', r.status === 200);

Date.now = realNow;
console.log(`\nالنتيجة: ${passed} نجح، ${failed} فشل`);
process.exit(failed ? 1 : 0);