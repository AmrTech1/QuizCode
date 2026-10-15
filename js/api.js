/* QuizCode — عميل الـ API المشترك بين كل الصفحات.
   يعتمد على window.QUIZCODE_CONFIG.API_BASE من js/config.js */
(function() {
  'use strict';
  
  const BASE = String((window.QUIZCODE_CONFIG && window.QUIZCODE_CONFIG.API_BASE) || '').replace(/\/+$/, '');
  const ADMIN_KEY = 'quizcode_admin_session';
  const ATTEMPT_PREFIX = 'quizcode_attempt:';
  let serverOffset = 0; // الفرق بين ساعة الخادم وساعة الجهاز (ms)
  
  class ApiError extends Error {
    constructor(status, code, message, extra) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.extra = extra || {};
    }
  }
  
  const isConfigured = () => !!BASE && !/YOUR-SUBDOMAIN/i.test(BASE);
  
  function syncTime(serverNow) {
    if (typeof serverNow === 'number' && isFinite(serverNow)) serverOffset = serverNow - Date.now();
  }
  const serverNow = () => Date.now() + serverOffset;
  
  /* تخزين محلي آمن (قد يفشل في وضع التصفح الخاص) */
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* تجاهل */ } },
  };
  
  /* جلسة الإدارة */
  const adminSession = {
    get() {
      const s = store.get(ADMIN_KEY);
      if (!s || typeof s.token !== 'string' || !(s.expiresAt > Date.now())) { store.del(ADMIN_KEY); return null; }
      return s;
    },
    set(token, expiresAt) { store.set(ADMIN_KEY, { token, expiresAt }); },
    clear() { store.del(ADMIN_KEY); },
  };
  
  /* بيانات محاولة الطالب (تُحفظ لاسترجاعها عند إعادة تحميل الصفحة) */
  const attemptStore = {
    get(code) { return store.get(ATTEMPT_PREFIX + String(code).toUpperCase()); },
    set(code, creds) { store.set(ATTEMPT_PREFIX + String(code).toUpperCase(), { examId: creds.examId, attemptId: creds.attemptId, token: creds.token }); },
    clear(code) { store.del(ATTEMPT_PREFIX + String(code).toUpperCase()); },
  };
  /* رابط النتيجة الشخصي: البيانات في fragment فلا تُرسل إلى أي خادم عند فتح الصفحة */
  const resultUrl = (c) => `result.html#e=${encodeURIComponent(c.examId)}&a=${encodeURIComponent(c.attemptId)}&t=${encodeURIComponent(c.token)}`;
  
  function parseResultHash(hash) {
    const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const c = { examId: p.get('e'), attemptId: p.get('a'), token: p.get('t') };
    return c.examId && c.attemptId && c.token ? c : null;
  }
  
  /* الطلب الأساسي */
  async function request(method, path, opts = {}) {
    if (!isConfigured()) throw new ApiError(0, 'NOT_CONFIGURED', 'لم يتم ضبط عنوان الخادم. عدّل API_BASE في الملف js/config.js');
    const headers = {};
    let body;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body || {});
    }
    if (opts.admin) {
      const s = adminSession.get();
      if (!s) { window.dispatchEvent(new CustomEvent('quizcode:unauthorized')); throw new ApiError(401, 'UNAUTHORIZED', 'يجب تسجيل الدخول'); }
      headers.Authorization = 'Bearer ' + s.token;
    }
    let url = BASE + path;
    if (opts.query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query))
        if (v !== undefined && v !== null) q.set(k, String(v));
      url += '?' + q.toString();
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 25000);
    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: ctrl.signal, cache: 'no-store' });
    } catch (e) {
      throw new ApiError(0, 'NETWORK', e && e.name === 'AbortError' ? 'انتهت مهلة الاتصال بالخادم. حاول مرة أخرى.' : 'تعذر الاتصال بالخادم. تحقق من الإنترنت ثم حاول مرة أخرى.');
    } finally {
      clearTimeout(timer);
    }
    if (opts.raw && res.ok) return res;
    let data = null;
    try { data = await res.json(); } catch { /* ليس JSON */ }
    if (!res.ok || !data || data.ok === false) {
      const err = (data && data.error) || {};
      if (res.status === 401 && opts.admin) {
        adminSession.clear();
        window.dispatchEvent(new CustomEvent('quizcode:unauthorized'));
      }
      throw new ApiError(res.status, err.code || 'HTTP_' + res.status, err.message || 'حدث خطأ غير متوقع', err);
    }
    if (data.serverNow) syncTime(data.serverNow);
    return data;
  }
  const get = (path, query, admin) => request('GET', path, { query, admin });
  const post = (path, body, admin) => request('POST', path, { body, admin });
  
  const QuizAPI = {
    ApiError,
    isConfigured,
    syncTime,
    serverNow,
    adminSession,
    attemptStore,
    resultUrl,
    parseResultHash,
    
    health: () => get('/api/health'),
    
    /* الطلاب — c = { examId, attemptId, token } */
    lookupExam: (code) => post('/api/exam/lookup', { code }),
    startAttempt: ({ examId, name, studentCode }) => post('/api/attempt/start', { examId, name, studentCode }),
    attemptState: (c) => post('/api/attempt/state', c),
    saveAnswers: (c, answers) => post('/api/attempt/save', { ...c, answers }),
    submitAttempt: (c, answers) => post('/api/attempt/submit', { ...c, answers }),
    attemptResult: (c) => post('/api/attempt/result', c),
    
    /* الإدارة */
    adminStatus: () => get('/api/admin/status'),
    adminSetup: ({ setupToken, password, reset }) => post('/api/admin/setup', { setupToken, password, reset: !!reset }),
    async adminLogin(password) {
      const r = await post('/api/admin/login', { password });
      adminSession.set(r.token, r.expiresAt);
      return r;
    },
    async adminLogout() {
      try { await post('/api/admin/logout', {}, true); } catch { /* حتى لو فشل الخادم نحذف الجلسة محليًا */ }
      adminSession.clear();
    },
    async changePassword(currentPassword, newPassword) {
      const r = await post('/api/admin/change-password', { currentPassword, newPassword }, true);
      adminSession.clear();
      return r;
    },
    listExams: () => get('/api/admin/exams', null, true),
    getExam: (id) => get('/api/admin/exam', { id }, true),
    saveExam: (exam) => post('/api/admin/exam/save', { exam }, true),
    duplicateExam: (id) => post('/api/admin/exam/duplicate', { id }, true),
    toggleExam: (id, enabled) => post('/api/admin/exam/toggle', { id, enabled }, true),
    deleteExam: (id) => post('/api/admin/exam/delete', { id }, true),
    listAttempts: (examId) => get('/api/admin/attempts', { examId }, true),
    getAttempt: (examId, attemptId) => get('/api/admin/attempt', { examId, attemptId }, true),
    gradeEssay: ({ examId, attemptId, questionId, score, note }) => post('/api/admin/grade', { examId, attemptId, questionId, score, note }, true),
    publish: ({ examId, attemptId, action }) => post('/api/admin/publish', { examId, attemptId, action }, true),
    async exportCsv(examId) {
      const tz = -new Date().getTimezoneOffset();
      const res = await request('GET', '/api/admin/export', { query: { examId, tz }, admin: true, raw: true });
      return { blob: await res.blob(), filename: `results-${examId}.csv` };
    },
    telegramTest: () => post('/api/admin/telegram-test', {}, true),
  };
  
  window.QuizAPI = QuizAPI;
})();