/* QuizCode — لوحة الإدارة (واجهة فقط: كل الصلاحيات والتحقق الحقيقي يتم في الـ Worker) */
(function() {
  'use strict';
  const { $, $$, esc, toast, showAlert, withBusy, confirmDialog, fmtDateTime, fmtNum, toLocalInput, fromLocalInput, downloadBlob } = window.UI;
  const API = window.QuizAPI;
  const R = window.Render;
  const app = $('#app');
  
  const TYPES = [
    ['single', 'اختيار إجابة واحدة'],
    ['multi', 'اختيار متعدد'],
    ['tf', 'صح أو خطأ'],
    ['short', 'إجابة نصية قصيرة'],
    ['fill', 'أكمل الفراغ'],
    ['order', 'ترتيب العناصر'],
    ['image', 'سؤال يعتمد على صورة'],
    ['essay', 'سؤال مقالي']
  ];
  const SUBS = [
    ['single', 'اختيار إجابة واحدة'],
    ['multi', 'اختيار متعدد'],
    ['tf', 'صح أو خطأ'],
    ['short', 'إجابة نصية قصيرة'],
    ['essay', 'مقالي']
  ];
  const rid = () => 'o' + Math.random().toString(36).slice(2, 8);
  const kindOf = (q) => (q.type === 'image' ? q.subtype || 'single' : q.type);
  const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
  
  let exams = [];
  let ex = null; // الامتحان قيد التحرير (نموذج الواجهة)
  let exFilter = '';
  let ctx = null; // سياق صفحة النتائج
  
  const setNav = (on) => { $('#nav').hidden = !on; };
  const loading = () => { app.innerHTML = '<div class="spinner-page">جارٍ التحميل…</div>'; };
  const errBox = (m) => `<div class="alert alert-error" role="alert">${esc(m)}</div>`;
  
  /* ───────────── الدخول والتهيئة ───────────── */
  async function boot() {
    loading();
    let st;
    try { st = await API.adminStatus(); } catch (e) { setNav(false);
      app.innerHTML = errBox(e.message) + '<button class="btn btn-primary" data-act="reload">إعادة المحاولة</button>'; return; }
    if (!st.initialized) return viewSetup(st, false);
    if (!API.adminSession.get()) return viewLogin();
    setNav(true);
    viewExams();
  }
  
  function viewSetup(st, reset) {
    setNav(false);
    app.innerHTML = `<form id="setup-form" class="card" style="max-width:480px;margin-inline:auto" novalidate>
      <h1>${reset ? 'إعادة ضبط كلمة مرور الإدارة' : 'تهيئة لوحة الإدارة'}</h1>
      <p class="muted">${reset ? 'ستُلغى كل الجلسات الحالية.' : 'أنشئ كلمة مرور الإدارة لأول مرة.'} يلزم رمز التهيئة SETUP_TOKEN المحفوظ كسر في Cloudflare.</p>
      ${st.setupConfigured ? '' : '<div class="alert alert-warn">لم يتم ضبط SETUP_TOKEN على الخادم بعد. أضفه ثم أعد تحميل الصفحة.</div>'}
      <div id="msg" class="alert" role="alert" hidden></div>
      <div class="field"><label for="tok">رمز التهيئة (SETUP_TOKEN)</label><input id="tok" type="password" autocomplete="off" class="ltr"></div>
      <div class="field"><label for="pw1">كلمة المرور الجديدة</label><input id="pw1" type="password" autocomplete="new-password" class="ltr"><p class="hint">10 أحرف على الأقل.</p></div>
      <div class="field"><label for="pw2">تأكيد كلمة المرور</label><input id="pw2" type="password" autocomplete="new-password" class="ltr"></div>
      <button class="btn btn-primary btn-block" type="submit" id="setup-btn">${reset ? 'إعادة الضبط' : 'حفظ كلمة المرور'}</button>
      ${reset ? '<button type="button" class="btn btn-ghost btn-block mt" data-act="to-login">رجوع لتسجيل الدخول</button>' : ''}</form>`;
    $('#setup-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const msg = $('#msg');
      const pw = $('#pw1').value;
      if (pw !== $('#pw2').value) return showAlert(msg, 'كلمتا المرور غير متطابقتين.');
      withBusy($('#setup-btn'), 'جارٍ الحفظ…', async () => {
        try {
          await API.adminSetup({ setupToken: $('#tok').value, password: pw, reset });
          toast('تم حفظ كلمة المرور. سجّل الدخول الآن.', 'success');
          viewLogin();
        } catch (err) { showAlert(msg, err.message + (err.extra.retryAfterSec ? ` (بعد ${err.extra.retryAfterSec} ثانية)` : '')); }
      });
    });
  }
  
  function viewLogin(message) {
    setNav(false);
    app.innerHTML = `<form id="login-form" class="card" style="max-width:420px;margin-inline:auto" novalidate>
      <h1>تسجيل دخول المسؤول</h1>
      <div id="msg" class="alert" role="alert" hidden></div>
      <div class="field"><label for="pw">كلمة المرور</label><input id="pw" type="password" autocomplete="current-password" class="ltr"></div>
      <button class="btn btn-primary btn-block" type="submit" id="login-btn">دخول</button>
      <p class="center mt small"><a href="#" data-act="to-reset">نسيت كلمة المرور؟</a></p></form>`;
    if (message) showAlert($('#msg'), message, 'warn');
    $('#login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!$('#pw').value) return showAlert($('#msg'), 'اكتب كلمة المرور.');
      withBusy($('#login-btn'), 'جارٍ الدخول…', async () => {
        try {
          await API.adminLogin($('#pw').value);
          setNav(true);
          viewExams();
        } catch (err) { showAlert($('#msg'), err.message + (err.extra.retryAfterSec ? ` (بعد ${Math.ceil(err.extra.retryAfterSec / 60)} دقيقة تقريبًا)` : ''));
          $('#pw').value = ''; }
      });
    });
    $('#pw').focus();
  }
  window.addEventListener('quizcode:unauthorized', () => viewLogin('انتهت الجلسة. سجّل الدخول من جديد.'));
  
  /* ───────────── قائمة الامتحانات ───────────── */
  async function viewExams() {
    ex = null;
    ctx = null;
    loading();
    try { exams = (await API.listExams()).exams; } catch (e) { if (e.code !== 'UNAUTHORIZED') app.innerHTML = errBox(e.message); return; }
    app.innerHTML = `<div class="toolbar"><h1 class="grow" style="margin:0">الامتحانات</h1><button class="btn btn-primary" data-act="new">إنشاء امتحان</button></div>
      <div class="toolbar"><div class="grow"><input id="exam-search" type="search" placeholder="ابحث باسم الامتحان أو الكود" value="${esc(exFilter)}"></div></div>
      <div id="exam-list"></div>`;
    renderExamList();
  }
  
  function renderExamList() {
    const q = exFilter.trim().toLowerCase();
    const list = exams.filter((e) => !q || e.title.toLowerCase().includes(q) || e.code.toLowerCase().includes(q));
    $('#exam-list').innerHTML = list.length ? list.map((e) => `<div class="card exam-card" data-id="${esc(e.id)}">
      <div class="row between"><h3>${esc(e.title)}</h3><span class="badge ${e.enabled ? 'badge-ok' : ''}">${e.enabled ? 'مفعّل' : 'معطّل'}</span></div>
      <p class="muted small" style="margin:.3rem 0 0">الكود: <b class="ltr">${esc(e.code)}</b> — ${esc(e.questionCount)} سؤال — ${esc(fmtNum(e.totalPoints))} درجة — ${esc(e.durationMinutes)} دقيقة</p>
      <p class="muted small" style="margin:0">الفتح: ${esc(fmtDateTime(e.opensAt))} — الإغلاق: ${esc(fmtDateTime(e.closesAt))} — النتائج: ${e.resultMode === 'auto' ? 'تلقائي' : e.resultsPublished ? 'يدوي (منشورة)' : 'يدوي (غير منشورة)'}</p>
      <div class="actions">
        <button class="btn btn-primary btn-sm" data-act="results">النتائج والمشاركون</button>
        <button class="btn btn-secondary btn-sm" data-act="edit">تعديل</button>
        <button class="btn btn-secondary btn-sm" data-act="dup">نسخ</button>
        <button class="btn btn-secondary btn-sm" data-act="toggle">${e.enabled ? 'تعطيل' : 'تفعيل'}</button>
        <button class="btn btn-danger btn-sm" data-act="del">حذف</button></div></div>`).join('') :
      '<div class="card center muted">لا توجد امتحانات بعد. اضغط «إنشاء امتحان» للبدء.</div>';
    const s = $('#exam-search');
    if (s && !s.dataset.bound) { s.dataset.bound = '1';
      s.addEventListener('input', () => { exFilter = s.value;
        renderExamList(); }); }
  }
  
  /* ───────────── محرر الامتحان ───────────── */
  function genCode() {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => a[b % a.length]).join('');
  }
  
  function fixKind(q) {
    const k = kindOf(q);
    if (k === 'single' || k === 'multi') {
      while (q.options.length < 2) q.options.push({ id: rid(), text: '' });
      if (k === 'single' && !q.options.some((o) => o.id === q.correct)) q.correct = q.options[0].id;
      if (k === 'multi') q.correct = Array.isArray(q.correct) ? q.correct.filter((c) => q.options.some((o) => o.id === c)) : [];
    }
    if (k === 'tf' && typeof q.correct !== 'boolean') q.correct = true;
    if (k === 'fill' && !q.blanks.length) q.blanks = [''];
    if (k === 'order')
      while (q.items.length < 2) q.items.push({ id: rid(), text: '' });
    return q;
  }
  
  function newQuestion(type) {
    return fixKind({ type, subtype: 'single', text: '', points: 1, imageUrl: '', explanation: '', rubric: '', options: [], items: [], correct: null, accepted: '', blanks: [] });
  }
  
  function fromServerQ(q) {
    return fixKind({
      id: q.id,
      type: q.type,
      subtype: q.subtype || 'single',
      text: q.text,
      points: q.points,
      imageUrl: q.imageUrl || '',
      explanation: q.explanation || '',
      rubric: q.rubric || '',
      options: (q.options || []).map((o) => ({ ...o })),
      items: (q.items || []).map((o) => ({ ...o })),
      correct: Array.isArray(q.correct) ? q.correct.slice() : q.correct === undefined ? null : q.correct,
      accepted: (q.accepted || []).join('\n'),
      blanks: (q.blanks || []).map((b) => b.accepted.join('\n')),
    });
  }
  
  function toServerQ(q) {
    const k = kindOf(q);
    const o = { type: q.type, text: q.text, points: Number(q.points), imageUrl: q.imageUrl.trim(), explanation: q.explanation };
    if (q.id) o.id = q.id;
    if (q.type === 'image') o.subtype = q.subtype;
    if (k === 'single' || k === 'multi') { o.options = q.options.map((x) => ({ id: x.id, text: x.text }));
      o.correct = q.correct; }
    else if (k === 'tf') o.correct = q.correct;
    else if (k === 'short') o.accepted = lines(q.accepted);
    else if (k === 'fill') o.blanks = q.blanks.map((b) => ({ accepted: lines(b) }));
    else if (k === 'order') o.items = q.items.map((x) => ({ id: x.id, text: x.text }));
    else if (k === 'essay') o.rubric = q.rubric;
    return o;
  }
  
  async function viewEditor(id) {
    loading();
    if (id) {
      try { const s = (await API.getExam(id)).exam;
        ex = { ...s, questions: s.questions.map(fromServerQ) }; } catch (e) { app.innerHTML = errBox(e.message); return; }
    } else {
      ex = { title: '', description: '', instructions: '', code: genCode(), durationMinutes: 30, opensAt: null, closesAt: null, maxParticipants: null, maxAttempts: null, passPercent: null, enabled: false, resultMode: 'manual', requireStudentCode: false, showReview: false, questions: [] };
    }
    const v = (x) => (x === null || x === undefined ? '' : esc(x));
    app.innerHTML = `<h1>${id ? 'تعديل الامتحان' : 'إنشاء امتحان'}</h1><div id="ed-msg" class="alert" role="alert" hidden></div>
      <div class="card"><h2>إعدادات الامتحان</h2><div class="grid grid-2">
        <div class="field"><label for="f-title">اسم الامتحان</label><input id="f-title" type="text" data-b="title" maxlength="120" value="${v(ex.title)}"></div>
        <div class="field"><label for="f-code">كود الامتحان</label><div class="row" style="flex-wrap:nowrap"><input id="f-code" type="text" data-b="code" class="ltr" maxlength="24" value="${v(ex.code)}"><button type="button" class="btn btn-secondary btn-sm" data-act="gen-code">توليد</button></div><p class="hint">أحرف إنجليزية وأرقام وشرطة (3–24). لا يتكرر بين الامتحانات.</p></div>
        <div class="field"><label for="f-dur">المدة (بالدقائق)</label><input id="f-dur" type="number" min="1" max="600" data-b="durationMinutes" value="${v(ex.durationMinutes)}"></div>
        <div class="field"><label for="f-pass">نسبة النجاح % (اختياري)</label><input id="f-pass" type="number" min="0" max="100" data-b="passPercent" value="${v(ex.passPercent)}"></div>
        <div class="field"><label for="f-open">وقت الفتح (اختياري)</label><input id="f-open" type="datetime-local" data-b="opensAt" data-dt="1" value="${esc(toLocalInput(ex.opensAt))}"></div>
        <div class="field"><label for="f-close">آخر وقت للدخول (اختياري)</label><input id="f-close" type="datetime-local" data-b="closesAt" data-dt="1" value="${esc(toLocalInput(ex.closesAt))}"><p class="hint">من بدأ قبل هذا الوقت يكمل مدته كاملة.</p></div>
        <div class="field"><label for="f-maxp">الحد الأقصى للمشاركين (اختياري)</label><input id="f-maxp" type="number" min="1" data-b="maxParticipants" value="${v(ex.maxParticipants)}"></div>
        <div class="field"><label for="f-maxa">المحاولات لكل طالب (اختياري)</label><input id="f-maxa" type="number" min="1" data-b="maxAttempts" value="${v(ex.maxAttempts)}"><p class="hint">تُطبَّق فقط عند تفعيل حقل كود الطالب.</p></div>
        <div class="field"><label for="f-mode">نشر النتائج</label><select id="f-mode" data-b="resultMode"><option value="auto" ${ex.resultMode === 'auto' ? 'selected' : ''}>تلقائي (عند اكتمال التصحيح)</option><option value="manual" ${ex.resultMode === 'manual' ? 'selected' : ''}>يدوي (أنشرها بنفسي)</option></select></div>
      </div>
      <div class="field"><label for="f-desc">وصف (اختياري)</label><textarea id="f-desc" data-b="description" rows="2" maxlength="1000">${esc(ex.description)}</textarea></div>
      <div class="field"><label for="f-ins">تعليمات تظهر قبل البدء (اختياري)</label><textarea id="f-ins" data-b="instructions" rows="3" maxlength="3000">${esc(ex.instructions)}</textarea></div>
      <div class="field"><label class="check"><input type="checkbox" data-b="requireStudentCode" ${ex.requireStudentCode ? 'checked' : ''}>طلب كود الطالب قبل البدء</label></div>
      <div class="field"><label class="check"><input type="checkbox" data-b="showReview" ${ex.showReview ? 'checked' : ''}>إظهار الإجابات الصحيحة والشرح للطالب مع النتيجة</label></div>
      <div class="field"><label class="check"><input type="checkbox" data-b="enabled" ${ex.enabled ? 'checked' : ''}>الامتحان مفعّل (متاح للطلاب)</label><p class="hint">يلزم وجود سؤال واحد على الأقل للتفعيل.</p></div></div>
      <h2 class="section-title">الأسئلة <span class="badge" id="q-count"></span></h2>
      <div id="q-list"></div>
      <div class="row mb"><select id="new-type" aria-label="نوع السؤال الجديد">${TYPES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select><button class="btn btn-secondary" data-act="add-q">إضافة سؤال</button></div>
      <div class="sticky-save"><button class="btn btn-primary" data-act="save-exam" id="save-btn">حفظ الامتحان</button><button class="btn btn-ghost" data-act="cancel-edit">إلغاء</button></div>`;
    renderQuestions();
  }
  
  function renderQuestions() {
    $('#q-count').textContent = ex.questions.length;
    $('#q-list').innerHTML = ex.questions.length ? ex.questions.map(qCard).join('') : '<div class="card center muted">لا توجد أسئلة. اختر نوع السؤال ثم اضغط «إضافة سؤال».</div>';
  }
  
  function qCard(q, i) {
    const k = kindOf(q);
    const d = (extra) => `data-qi="${i}" ${extra}`;
    let block = '';
    if (k === 'single' || k === 'multi') {
      block = `<label>الخيارات <span class="hint">(حدّد ${k === 'single' ? 'الإجابة الصحيحة' : 'الإجابات الصحيحة'})</span></label>` + q.options.map((o, j) => `<div class="opt-row">
        <input type="${k === 'single' ? 'radio' : 'checkbox'}" name="c-${i}" aria-label="إجابة صحيحة" ${d(k === 'single' ? `data-cs="${esc(o.id)}"` : `data-cm="${esc(o.id)}"`)} ${(k === 'single' ? q.correct === o.id : (q.correct || []).includes(o.id)) ? 'checked' : ''}>
        <input type="text" ${d(`data-list="options" data-li="${j}"`)} maxlength="300" value="${esc(o.text)}" placeholder="نص الخيار ${j + 1}">
        <button class="btn btn-ghost btn-sm" data-act="del-opt" data-i="${i}" data-j="${j}" aria-label="حذف الخيار">✕</button></div>`).join('') +
        (q.options.length < 10 ? `<button class="btn btn-secondary btn-sm" data-act="add-opt" data-i="${i}">إضافة خيار</button>` : '');
    } else if (k === 'tf') {
      block = `<label>الإجابة الصحيحة</label><div class="row"><label class="check"><input type="radio" name="tf-${i}" ${d('data-tf="true"')} ${q.correct === true ? 'checked' : ''}>صح</label><label class="check"><input type="radio" name="tf-${i}" ${d('data-tf="false"')} ${q.correct === false ? 'checked' : ''}>خطأ</label></div>`;
    } else if (k === 'short') {
      block = `<label>الإجابات المقبولة (كل إجابة في سطر)</label><textarea rows="3" ${d('data-f="accepted"')}>${esc(q.accepted)}</textarea><p class="hint">لا يفرّق التصحيح بين أشكال الهمزة والتشكيل وحالة الأحرف.</p>`;
    } else if (k === 'fill') {
      block = `<p class="hint">اكتب نص السؤال واستخدم ___ لمكان كل فراغ. لكل فراغ إجابات مقبولة (كل إجابة في سطر). تُمنح الدرجة بنسبة الفراغات الصحيحة.</p>` + q.blanks.map((b, j) => `<div class="field"><label>الفراغ ${j + 1}</label><div class="row" style="flex-wrap:nowrap"><textarea rows="2" ${d(`data-blank="${j}"`)}>${esc(b)}</textarea><button class="btn btn-ghost btn-sm" data-act="del-blank" data-i="${i}" data-j="${j}" aria-label="حذف الفراغ">✕</button></div></div>`).join('') +
        (q.blanks.length < 10 ? `<button class="btn btn-secondary btn-sm" data-act="add-blank" data-i="${i}">إضافة فراغ</button>` : '');
    } else if (k === 'order') {
      block = `<label>العناصر بالترتيب الصحيح <span class="hint">(سيراها الطالب مخلوطة)</span></label>` + q.items.map((o, j) => `<div class="opt-row">
        <input type="text" ${d(`data-list="items" data-li="${j}"`)} maxlength="300" value="${esc(o.text)}" placeholder="العنصر ${j + 1}">
        <button class="btn btn-ghost btn-sm" data-act="mv-item" data-i="${i}" data-j="${j}" data-d="-1" aria-label="لأعلى" ${j === 0 ? 'disabled' : ''}>▲</button>
        <button class="btn btn-ghost btn-sm" data-act="mv-item" data-i="${i}" data-j="${j}" data-d="1" aria-label="لأسفل" ${j === q.items.length - 1 ? 'disabled' : ''}>▼</button>
        <button class="btn btn-ghost btn-sm" data-act="del-item" data-i="${i}" data-j="${j}" aria-label="حذف العنصر">✕</button></div>`).join('') +
        (q.items.length < 10 ? `<button class="btn btn-secondary btn-sm" data-act="add-item" data-i="${i}">إضافة عنصر</button>` : '');
    } else if (k === 'essay') {
      block = `<label>معيار التصحيح (يظهر للمسؤول فقط)</label><textarea rows="3" ${d('data-f="rubric"')}>${esc(q.rubric)}</textarea><p class="hint">يُصحَّح يدويًا من صفحة المشاركين.</p>`;
    }
    return `<div class="q-card"><div class="q-head"><span class="num">سؤال ${i + 1}</span>
      <select class="grow" aria-label="نوع السؤال" ${d('data-f="type"')}>${TYPES.map(([t, l]) => `<option value="${t}" ${q.type === t ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${q.type === 'image' ? `<select aria-label="نوع الإجابة" ${d('data-f="subtype"')}>${SUBS.map(([t, l]) => `<option value="${t}" ${q.subtype === t ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
      <button class="btn btn-ghost btn-sm" data-act="mv-q" data-i="${i}" data-d="-1" aria-label="تحريك لأعلى" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="btn btn-ghost btn-sm" data-act="mv-q" data-i="${i}" data-d="1" aria-label="تحريك لأسفل" ${i === ex.questions.length - 1 ? 'disabled' : ''}>▼</button>
      <button class="btn btn-danger btn-sm" data-act="del-q" data-i="${i}">حذف</button></div>
      <div class="field"><label>نص السؤال</label><textarea rows="3" maxlength="3000" ${d('data-f="text"')}>${esc(q.text)}</textarea></div>
      <div class="grid grid-2"><div class="field"><label>الدرجة</label><input type="number" min="0.25" step="0.25" ${d('data-f="points"')} value="${esc(q.points)}"></div>
      <div class="field"><label>رابط صورة https ${q.type === 'image' ? '(مطلوب)' : '(اختياري)'}</label><input type="url" class="ltr" placeholder="https://" ${d('data-f="imageUrl"')} value="${esc(q.imageUrl)}"></div></div>
      ${block}
      <div class="field mt"><label>شرح أو ملاحظات (لا تظهر قبل التسليم)</label><textarea rows="2" maxlength="2000" ${d('data-f="explanation"')}>${esc(q.explanation)}</textarea></div></div>`;
  }
  
  /* ربط الحقول بالنموذج */
  function onField(e) {
    const t = e.target;
    if (!ex) return;
    if (t.dataset.b) {
      const key = t.dataset.b;
      if (t.type === 'checkbox') ex[key] = t.checked;
      else if (t.dataset.dt) ex[key] = fromLocalInput(t.value);
      else if (t.type === 'number') ex[key] = t.value === '' ? null : Number(t.value);
      else ex[key] = t.value;
      return;
    }
    if (t.dataset.qi === undefined) return;
    const q = ex.questions[+t.dataset.qi];
    if (!q) return;
    if (t.dataset.f === 'type') { if (q.type !== t.value) { q.type = t.value;
        q.correct = null;
        q.options = [];
        q.items = [];
        q.blanks = [];
        q.accepted = '';
        fixKind(q);
        renderQuestions(); } return; }
    if (t.dataset.f === 'subtype') { if (q.subtype !== t.value) { q.subtype = t.value;
        q.correct = null;
        q.options = [];
        q.accepted = '';
        fixKind(q);
        renderQuestions(); } return; }
    if (t.dataset.f) q[t.dataset.f] = t.value;
    else if (t.dataset.list) q[t.dataset.list][+t.dataset.li].text = t.value;
    else if (t.dataset.blank !== undefined) q.blanks[+t.dataset.blank] = t.value;
    else if (t.dataset.cs !== undefined) q.correct = t.dataset.cs;
    else if (t.dataset.cm !== undefined) { const s = new Set(q.correct || []); if (t.checked) s.add(t.dataset.cm);
      else s.delete(t.dataset.cm);
      q.correct = [...s]; }
    else if (t.dataset.tf !== undefined) q.correct = t.dataset.tf === 'true';
  }
  app.addEventListener('input', onField);
  app.addEventListener('change', onField);
  
  function moveIn(arr, j, d) { const k = j + d; if (k >= 0 && k < arr.length)[arr[j], arr[k]] = [arr[k], arr[j]]; }
  
  async function saveExam(btn) {
    const msg = $('#ed-msg');
    showAlert(msg, '');
    const payload = { ...ex, questions: ex.questions.map(toServerQ) };
    await withBusy(btn, 'جارٍ الحفظ…', async () => {
      try {
        await API.saveExam(payload);
        toast('تم حفظ الامتحان', 'success');
        await viewExams();
      } catch (e) {
        showAlert(msg, e.message);
        msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }
  
  /* ───────────── المشاركون والنتائج ───────────── */
  const ST = { submitted: ['تم التسليم', 'badge-ok'], in_progress: ['جارية', 'badge-info'], expired: ['انتهى الوقت', 'badge-warn'] };
  
  async function viewResults(examId) {
    loading();
    try {
      const r = await API.listAttempts(examId);
      ctx = { examId, exam: r.exam, attempts: r.attempts, q: '', s: '' };
    } catch (e) { if (e.code !== 'UNAUTHORIZED') app.innerHTML = errBox(e.message) + '<button class="btn btn-ghost" data-act="nav-exams">رجوع</button>'; return; }
    const m = ctx.exam;
    app.innerHTML = `<div class="toolbar"><button class="btn btn-ghost btn-sm" data-act="nav-exams">رجوع</button><h1 class="grow" style="margin:0">${esc(m.title)}</h1></div>
      <div class="card"><div class="stat-row"><div>المشاركون<br><b>${ctx.attempts.length}</b></div><div>بانتظار التصحيح<br><b>${ctx.attempts.filter((a) => a.pending > 0).length}</b></div><div>الدرجة الكلية<br><b>${esc(fmtNum(m.totalPoints))}</b></div><div>نشر النتائج<br><b>${m.resultMode === 'auto' ? 'تلقائي' : m.resultsPublished ? 'يدوي — منشورة' : 'يدوي — غير منشورة'}</b></div></div>
      <div class="actions"><button class="btn btn-secondary btn-sm" data-act="refresh-results">تحديث</button><button class="btn btn-secondary btn-sm" data-act="export">تصدير CSV</button>
      ${m.resultMode === 'manual' ? (m.resultsPublished ? '<button class="btn btn-danger btn-sm" data-act="exam-pub" data-v="hide">إخفاء نتائج الامتحان</button>' : '<button class="btn btn-primary btn-sm" data-act="exam-pub" data-v="publish">نشر نتائج الامتحان</button>') : ''}</div></div>
      <div class="toolbar"><div class="grow"><input id="f-q" type="search" placeholder="ابحث باسم الطالب أو كوده"></div>
      <select id="f-s" aria-label="تصفية حسب الحالة"><option value="">كل الحالات</option><option value="submitted">تم التسليم</option><option value="in_progress">جارية</option><option value="expired">انتهى الوقت</option><option value="pending">بانتظار التصحيح</option></select></div>
      <div class="table-wrap"><table><thead><tr><th>الطالب</th><th>الكود</th><th>البدء</th><th>التسليم</th><th>الحالة</th><th>الدرجة</th><th>التصحيح</th><th>النشر</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>`;
    $('#f-q').addEventListener('input', (e) => { ctx.q = e.target.value;
      renderRows(); });
    $('#f-s').addEventListener('change', (e) => { ctx.s = e.target.value;
      renderRows(); });
    renderRows();
  }
  
  function renderRows() {
    const q = ctx.q.trim().toLowerCase();
    const rows = ctx.attempts.filter((a) => (!q || a.name.toLowerCase().includes(q) || a.studentCode.toLowerCase().includes(q)) && (!ctx.s || (ctx.s === 'pending' ? a.pending > 0 : a.status === ctx.s)));
    $('#rows').innerHTML = rows.length ? rows.map((a) => {
      const st = ST[a.status];
      return `<tr><td>${esc(a.name)}</td><td class="ltr">${esc(a.studentCode) || '—'}</td><td>${esc(fmtDateTime(a.startedAt))}</td><td>${esc(fmtDateTime(a.submittedAt))}</td>
        <td><span class="badge ${st[1]}">${st[0]}</span></td>
        <td>${a.total === null ? '—' : `${esc(fmtNum(a.total))} / ${esc(fmtNum(a.max))} (${esc(fmtNum(a.percent))}%) ${a.passed === null ? '' : a.passed ? '<span class="badge badge-ok">ناجح</span>' : '<span class="badge badge-danger">راسب</span>'}`}</td>
        <td>${a.gradingStatus === 'pending' ? `<span class="badge badge-warn">بانتظار (${esc(a.pending)})</span>` : a.gradingStatus === 'done' ? '<span class="badge badge-ok">مكتمل</span>' : '—'}</td>
        <td>${a.status !== 'submitted' ? '—' : a.visible ? '<span class="badge badge-ok">منشورة</span>' : '<span class="badge">غير منشورة</span>'}</td>
        <td><button class="btn btn-secondary btn-sm" data-act="open-attempt" data-aid="${esc(a.attemptId)}">عرض</button></td></tr>`;
    }).join('') : '<tr><td colspan="9" class="center muted">لا توجد نتائج مطابقة.</td></tr>';
  }
  
  async function viewAttempt(aid) {
    loading();
    let r;
    try { r = await API.getAttempt(ctx.examId, aid); } catch (e) { if (e.code !== 'UNAUTHORIZED') app.innerHTML = errBox(e.message) + '<button class="btn btn-ghost" data-act="back-results">رجوع</button>'; return; }
    ctx.aid = aid;
    const a = r.attempt;
    const g = a.grading;
    app.innerHTML = `<div class="toolbar"><button class="btn btn-ghost btn-sm" data-act="back-results">رجوع للمشاركين</button><h1 class="grow" style="margin:0">${esc(a.name)}</h1></div>
      <div class="card"><p class="muted" style="margin:0">${esc(r.exam.title)}${a.studentCode ? ' — كود الطالب: ' + esc(a.studentCode) : ''}<br>البدء: ${esc(fmtDateTime(a.startedAt))} — التسليم: ${esc(fmtDateTime(a.submittedAt))}${a.submitReason === 'timeout' ? ' (انتهى الوقت)' : ''}</p>
      ${g ? `<p class="mt" style="margin-bottom:.4rem">الدرجة: <b>${esc(fmtNum(g.total))} / ${esc(fmtNum(g.max))}</b>${g.pending ? ` <span class="badge badge-warn">${esc(g.pending)} بانتظار التصحيح</span>` : ''}</p>
      <p style="margin:0">ظهور النتيجة للطالب: <b>${a.visible ? 'ظاهرة' : 'مخفية'}</b>${a.override === true ? ' (نُشرت يدويًا)' : a.override === false ? ' (أُخفيت يدويًا)' : ''}</p>
      <div class="actions"><button class="btn btn-primary btn-sm" data-act="att-pub" data-v="publish">نشر نتيجة هذا الطالب</button><button class="btn btn-secondary btn-sm" data-act="att-pub" data-v="hide">إخفاء</button><button class="btn btn-ghost btn-sm" data-act="att-pub" data-v="reset">اتباع إعداد الامتحان</button></div>` : '<div class="alert alert-info mt">لم تُسلَّم هذه المحاولة بعد، فلا توجد إجابات للمراجعة.</div>'}</div>
      <div id="att-msg" class="alert" role="alert" hidden></div>
      ${r.review.map((it, i) => reviewCard(it, i)).join('')}`;
  }
  
  function reviewCard(it, i) {
    const q = it.question;
    const k = R.kindOf(q);
    const ans = R.answerText(q, it.answer);
    const cor = R.correctText(q, it.correct);
    return `<div class="card review-item ${esc(it.status)}" data-qid="${esc(q.id)}">
      <div class="row between"><b>سؤال ${i + 1} — ${esc(R.TYPE_LABELS[q.type])}</b><span>${R.statusBadge(it.status)} <span class="badge">${esc(fmtNum(it.score))} / ${esc(fmtNum(it.max))}</span></span></div>
      <p class="q-text">${esc(q.text)}</p>${q.imageUrl ? `<img class="q-image" src="${esc(q.imageUrl)}" alt="صورة السؤال" referrerpolicy="no-referrer">` : ''}
      <label>إجابة الطالب</label><div class="answer-box">${ans ? esc(ans) : '<span class="muted">لم يجب</span>'}</div>
      ${cor ? `<p class="mt" style="margin-bottom:0"><b>الإجابة الصحيحة:</b> ${esc(cor)}</p>` : ''}
      ${q.rubric ? `<p class="muted" style="margin:.4rem 0 0"><b>معيار التصحيح:</b> ${esc(q.rubric)}</p>` : ''}
      ${it.explanation ? `<p class="muted" style="margin:.4rem 0 0"><b>شرح:</b> ${esc(it.explanation)}</p>` : ''}
      ${k === 'essay' && (it.status === 'pending' || it.status === 'graded') ? `<div class="grade-box"><div class="row"><div><label>الدرجة (0 – ${esc(fmtNum(it.max))})</label><input type="number" class="g-score" min="0" max="${esc(it.max)}" step="0.25" value="${it.status === 'graded' ? esc(it.score) : ''}" style="width:130px"></div>
        <div class="grow"><label>ملاحظة (اختياري)</label><input type="text" class="g-note" maxlength="1000" value="${esc(it.note)}"></div></div>
        <button class="btn btn-primary btn-sm mt" data-act="grade" data-qid="${esc(q.id)}">حفظ التصحيح</button></div>` : ''}</div>`;
  }
  
  /* ───────────── الإعدادات ───────────── */
  function viewSettings() {
    ex = null;
    ctx = null;
    app.innerHTML = `<h1>الإعدادات</h1>
      <form id="pw-form" class="card" style="max-width:480px" novalidate><h2>تغيير كلمة مرور الإدارة</h2><div id="pw-msg" class="alert" role="alert" hidden></div>
      <div class="field"><label for="cur">كلمة المرور الحالية</label><input id="cur" type="password" autocomplete="current-password" class="ltr"></div>
      <div class="field"><label for="n1">كلمة المرور الجديدة</label><input id="n1" type="password" autocomplete="new-password" class="ltr"><p class="hint">10 أحرف على الأقل. سيُطلب منك تسجيل الدخول مجددًا.</p></div>
      <div class="field"><label for="n2">تأكيد كلمة المرور الجديدة</label><input id="n2" type="password" autocomplete="new-password" class="ltr"></div>
      <button class="btn btn-primary" type="submit" id="pw-btn">تغيير كلمة المرور</button></form>
      <div class="card" style="max-width:480px"><h2>إشعارات Telegram</h2><p class="muted">تُفعَّل بإضافة السرّين TG_TOKEN وTG_CHAT في Cloudflare. اضغط الزر لإرسال رسالة اختبار.</p><button class="btn btn-secondary" id="tg-btn" data-act="tg-test">إرسال رسالة اختبار</button></div>
      <div class="card" style="max-width:480px"><h2>نسيت كلمة المرور؟</h2><p class="muted">من شاشة تسجيل الدخول اختر «نسيت كلمة المرور؟» وأدخل SETUP_TOKEN.</p></div>`;
    $('#pw-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const msg = $('#pw-msg');
      if ($('#n1').value !== $('#n2').value) return showAlert(msg, 'كلمتا المرور الجديدتان غير متطابقتين.');
      withBusy($('#pw-btn'), 'جارٍ التغيير…', async () => {
        try { await API.changePassword($('#cur').value, $('#n1').value);
          toast('تم تغيير كلمة المرور. سجّل الدخول من جديد.', 'success');
          viewLogin(); }
        catch (err) { if (err.code !== 'UNAUTHORIZED') showAlert(msg, err.message); }
      });
    });
  }
  
  /* ───────────── الأحداث العامة ───────────── */
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const card = b.closest('[data-id]');
    const id = card && card.dataset.id;
    const i = b.dataset.i !== undefined ? +b.dataset.i : null;
    const j = b.dataset.j !== undefined ? +b.dataset.j : null;
    const q = i !== null && ex ? ex.questions[i] : null;
    switch (act) {
      case 'reload':
        return boot();
      case 'to-reset':
        e.preventDefault();
        return viewSetup(await API.adminStatus().catch(() => ({ setupConfigured: true })), true);
      case 'to-login':
        return viewLogin();
      case 'nav-exams':
        return viewExams();
      case 'nav-settings':
        return viewSettings();
      case 'logout':
        await API.adminLogout();
        setNav(false);
        return viewLogin('تم تسجيل الخروج.');
      case 'new':
        return viewEditor(null);
      case 'edit':
        return viewEditor(id);
      case 'results':
        return viewResults(id);
      case 'dup':
        return withBusy(b, '…', async () => { try { await API.duplicateExam(id);
            toast('تم نسخ الامتحان (معطّل بكود جديد)', 'success');
            await viewExams(); } catch (err) { toast(err.message, 'error'); } });
      case 'toggle': {
        const cur = exams.find((x) => x.id === id);
        return withBusy(b, '…', async () => { try { await API.toggleExam(id, !cur.enabled);
            await viewExams(); } catch (err) { toast(err.message, 'error'); } });
      }
      case 'del': {
        const cur = exams.find((x) => x.id === id);
        if (!(await confirmDialog(`سيُحذف الامتحان «${cur.title}» وكل محاولات الطلاب ونتائجهم نهائيًا. هل أنت متأكد؟`, { title: 'حذف الامتحان', okText: 'حذف نهائيًا', danger: true }))) return;
        return withBusy(b, 'جارٍ الحذف…', async () => {
          try {
            let r;
            do { r = await API.deleteExam(id); } while (r.complete === false);
            toast('تم حذف الامتحان', 'success');
          } catch (err) { toast(err.message, 'error'); }
          await viewExams();
        });
      }
      /* المحرر */
      case 'gen-code': { ex.code = genCode();
        $('#f-code').value = ex.code; return undefined; }
      case 'add-q':
        ex.questions.push(newQuestion($('#new-type').value));
        renderQuestions();
        return $('#q-list').lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
      case 'del-q':
        if (await confirmDialog('حذف هذا السؤال؟', { danger: true, okText: 'حذف' })) { ex.questions.splice(i, 1);
          renderQuestions(); }
        return undefined;
      case 'mv-q':
        moveIn(ex.questions, i, +b.dataset.d);
        return renderQuestions();
      case 'add-opt':
        q.options.push({ id: rid(), text: '' });
        return renderQuestions();
      case 'del-opt':
        if (q.options.length <= 2) return toast('يلزم خياران على الأقل', 'error');
        q.options.splice(j, 1);
        fixKind(q);
        return renderQuestions();
      case 'add-blank':
        q.blanks.push('');
        return renderQuestions();
      case 'del-blank':
        if (q.blanks.length <= 1) return toast('يلزم فراغ واحد على الأقل', 'error');
        q.blanks.splice(j, 1);
        return renderQuestions();
      case 'add-item':
        q.items.push({ id: rid(), text: '' });
        return renderQuestions();
      case 'del-item':
        if (q.items.length <= 2) return toast('يلزم عنصران على الأقل', 'error');
        q.items.splice(j, 1);
        return renderQuestions();
      case 'mv-item':
        moveIn(q.items, j, +b.dataset.d);
        return renderQuestions();
      case 'save-exam':
        return saveExam(b);
      case 'cancel-edit':
        if (await confirmDialog('تجاهل التغييرات غير المحفوظة؟', { okText: 'تجاهل', danger: true })) viewExams();
        return undefined;
        /* النتائج */
      case 'refresh-results':
        return viewResults(ctx.examId);
      case 'back-results':
        return viewResults(ctx.examId);
      case 'open-attempt':
        return viewAttempt(b.dataset.aid);
      case 'export':
        return withBusy(b, 'جارٍ التصدير…', async () => { try { const f = await API.exportCsv(ctx.examId);
            downloadBlob(f.blob, f.filename); } catch (err) { toast(err.message, 'error'); } });
      case 'exam-pub':
        return withBusy(b, '…', async () => { try { await API.publish({ examId: ctx.examId, action: b.dataset.v });
            toast(b.dataset.v === 'publish' ? 'تم نشر نتائج الامتحان' : 'تم إخفاء نتائج الامتحان', 'success');
            await viewResults(ctx.examId); } catch (err) { toast(err.message, 'error'); } });
      case 'att-pub':
        return withBusy(b, '…', async () => { try { await API.publish({ examId: ctx.examId, attemptId: ctx.aid, action: b.dataset.v });
            toast('تم التحديث', 'success');
            await viewAttempt(ctx.aid); } catch (err) { toast(err.message, 'error'); } });
      case 'grade': {
        const box = b.closest('.grade-box');
        const score = $('.g-score', box).value;
        if (score === '') return toast('أدخل الدرجة أولًا', 'error');
        return withBusy(b, 'جارٍ الحفظ…', async () => {
          try {
            await API.gradeEssay({ examId: ctx.examId, attemptId: ctx.aid, questionId: b.dataset.qid, score: Number(score), note: $('.g-note', box).value });
            toast('تم حفظ التصحيح وإعادة حساب النتيجة', 'success');
            await viewAttempt(ctx.aid);
          } catch (err) { showAlert($('#att-msg'), err.message); }
        });
      }
      case 'tg-test':
        return withBusy(b, 'جارٍ الإرسال…', async () => { try { await API.telegramTest();
            toast('تم إرسال رسالة الاختبار', 'success'); } catch (err) { toast(err.message, 'error'); } });
      default:
        return undefined;
    }
  });
  
  boot();
})();