/* QuizCode — صفحة الامتحان: بدء/استئناف المحاولة، سؤال واحد في كل شاشة، حفظ تلقائي، مؤقت من وقت الخادم */
(function() {
  'use strict';
  const { $, esc, showAlert, withBusy, confirmDialog, fmtClock, fmtDateTime, debounce, normalizeCodeInput } = window.UI;
  const API = window.QuizAPI;
  const AUTOSAVE_MS = 15000;
  
  const code = normalizeCodeInput(new URLSearchParams(location.search).get('code') || '');
  let info = null;
  let creds = null;
  let questions = [];
  let answers = {};
  let deadline = 0;
  let idx = 0;
  let dirty = false;
  let saving = false;
  let submitting = false;
  let timerId = null;
  
  const screens = ['status-screen', 'start-screen', 'exam-screen'];
  const show = (id) => screens.forEach((s) => { $('#' + s).hidden = s !== id; });
  
  function fatal(message, retry) {
    show('status-screen');
    $('#status-msg').className = 'alert alert-error';
    $('#status-msg').textContent = message;
    $('#status-actions').hidden = false;
    if (retry) {
      const b = document.createElement('button');
      b.className = 'btn btn-primary';
      b.textContent = 'إعادة المحاولة';
      b.style.marginInlineEnd = '.5rem';
      b.onclick = () => location.reload();
      $('#status-actions').prepend(b);
    }
  }
  const goResult = () => { location.replace(API.resultUrl(creds)); };
  
  /* ───── التهيئة ───── */
  async function init() {
    if (!code) return fatal('لا يوجد كود امتحان في الرابط. ارجع للصفحة الرئيسية وأدخل الكود.');
    const saved = API.attemptStore.get(code);
    if (saved) {
      try {
        const st = await API.attemptState(saved);
        creds = saved;
        if (st.status === 'in_progress') return beginExam(st);
        return goResult();
      } catch (e) {
        if (e.code === 'NETWORK' || e.code === 'NOT_CONFIGURED') return fatal(e.message, true);
        API.attemptStore.clear(code); // محاولة قديمة أو غير صالحة
      }
    }
    try {
      info = (await API.lookupExam(code)).exam;
    } catch (e) {
      let m = e.message;
      if (e.code === 'EXAM_NOT_OPEN' && e.extra.opensAt) m += ` — يبدأ في ${fmtDateTime(e.extra.opensAt)}`;
      return fatal(m, e.code === 'NETWORK');
    }
    showStart();
  }
  
  function showStart() {
    show('start-screen');
    $('#exam-title').textContent = info.title;
    $('#exam-desc').textContent = info.description || '';
    $('#exam-meta').textContent = `عدد الأسئلة: ${info.questionCount} — الدرجة الكلية: ${info.totalPoints} — المدة: ${info.durationMinutes} دقيقة`;
    if (info.instructions) { const b = $('#exam-instructions');
      b.hidden = false;
      b.style.whiteSpace = 'pre-wrap';
      b.textContent = info.instructions; }
    $('#code-field').hidden = !info.requireStudentCode;
    $('#student-name').focus();
  }
  
  $('#start-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#student-name').value.trim();
    const studentCode = $('#student-code').value.trim();
    const msg = $('#start-msg');
    if (name.length < 2) return showAlert(msg, 'اكتب اسمك (حرفان على الأقل).');
    if (info.requireStudentCode && !studentCode) return showAlert(msg, 'اكتب كود الطالب.');
    withBusy($('#start-btn'), 'جارٍ البدء…', async () => {
      showAlert(msg, '');
      try {
        const r = await API.startAttempt({ examId: info.id, name, studentCode });
        creds = { examId: r.examId, attemptId: r.attemptId, token: r.token };
        API.attemptStore.set(code, creds);
        beginExam(r);
      } catch (err) {
        showAlert(msg, err.message);
      }
    });
  });
  
  /* ───── الامتحان ───── */
  function beginExam(st) {
    questions = st.questions;
    answers = st.answers || {};
    deadline = st.deadline;
    idx = 0;
    show('exam-screen');
    render();
    tick();
    timerId = setInterval(tick, 1000);
  }
  
  function tick() {
    const left = deadline - API.serverNow();
    const t = $('#timer');
    t.textContent = fmtClock(left);
    t.classList.toggle('low', left <= 60000);
    if (left <= 0 && !submitting) { clearInterval(timerId);
      doSubmit(true); }
  }
  
  const isAnswered = (q) => {
    const v = answers[q.id];
    if (v === undefined || v === null) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.some((x) => (typeof x === 'string' ? x.trim() !== '' : true));
    return true;
  };
  
  function render() {
    const q = questions[idx];
    const last = idx === questions.length - 1;
    $('#counter').textContent = `السؤال ${idx + 1} من ${questions.length}`;
    $('#progress-bar').style.width = `${((idx + 1) / questions.length) * 100}%`;
    $('#prev-btn').disabled = idx === 0;
    $('#next-btn').hidden = last;
    $('#submit-btn').hidden = !last;
    const box = $('#q-box');
    box.innerHTML = `<p class="small muted">الدرجة: ${esc(q.points)}</p>
      <div class="q-text">${esc(q.text)}</div>
      ${q.imageUrl ? `<img class="q-image" src="${esc(q.imageUrl)}" alt="صورة السؤال" referrerpolicy="no-referrer">` : ''}
      <div id="q-body">${body(q)}</div>`;
    const img = $('.q-image', box);
    if (img) img.addEventListener('error', () => { img.replaceWith(Object.assign(document.createElement('p'), { className: 'alert alert-warn', textContent: 'تعذر تحميل الصورة.' })); });
    window.scrollTo({ top: 0 });
  }
  
  function body(q) {
    const v = answers[q.id];
    switch (q.kind) {
      case 'single':
        return q.options.map((o) => `<label class="option"><input type="radio" name="opt" value="${esc(o.id)}" ${v === o.id ? 'checked' : ''}><span>${esc(o.text)}</span></label>`).join('');
      case 'multi':
        return `<p class="hint">يمكنك اختيار أكثر من إجابة.</p>` + q.options.map((o) => `<label class="option"><input type="checkbox" name="opt" value="${esc(o.id)}" ${Array.isArray(v) && v.includes(o.id) ? 'checked' : ''}><span>${esc(o.text)}</span></label>`).join('');
      case 'tf':
        return [
          ['true', 'صح'],
          ['false', 'خطأ']
        ].map(([val, label]) => `<label class="option"><input type="radio" name="tf" value="${val}" ${String(v) === val ? 'checked' : ''}><span>${label}</span></label>`).join('');
      case 'short':
        return `<input type="text" id="ans-text" maxlength="500" autocomplete="off" value="${esc(v || '')}" placeholder="اكتب إجابتك">`;
      case 'essay':
        return `<textarea id="ans-text" maxlength="8000" rows="8" placeholder="اكتب إجابتك هنا">${esc(v || '')}</textarea>`;
      case 'fill':
        return Array.from({ length: q.blanksCount }, (_, i) => `<div class="field"><label for="blank-${i}">الفراغ ${i + 1}</label><input type="text" id="blank-${i}" data-blank="${i}" maxlength="200" autocomplete="off" value="${esc((v && v[i]) || '')}"></div>`).join('');
      case 'order': {
        const ids = Array.isArray(v) ? v : q.items.map((i) => i.id);
        const byId = Object.fromEntries(q.items.map((i) => [i.id, i.text]));
        return `<p class="hint">استخدم الأسهم لترتيب العناصر. الترتيب الذي لا تحرّكه لا يُحتسب كإجابة.</p>` + ids.map((id, i) => `<div class="option" style="cursor:default"><span class="grow">${esc(byId[id])}</span>
          <button type="button" class="btn btn-ghost btn-sm" data-mv="-1" data-i="${i}" aria-label="تحريك لأعلى" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button type="button" class="btn btn-ghost btn-sm" data-mv="1" data-i="${i}" aria-label="تحريك لأسفل" ${i === ids.length - 1 ? 'disabled' : ''}>▼</button></div>`).join('');
      }
      default:
        return '';
    }
  }
  
  function setAnswer(q, value) {
    const empty = value === undefined || value === '' || (Array.isArray(value) && value.every((x) => x === '')) || (Array.isArray(value) && !value.length);
    if (empty) delete answers[q.id];
    else answers[q.id] = value;
    dirty = true;
    $('#save-state').textContent = '';
    scheduleSave();
  }
  
  const qBox = $('#q-box');
  qBox.addEventListener('input', (e) => {
    const q = questions[idx];
    const t = e.target;
    if (t.id === 'ans-text') setAnswer(q, t.value);
    else if (t.dataset.blank !== undefined) {
      const arr = Array.isArray(answers[q.id]) ? answers[q.id].slice() : Array(q.blanksCount).fill('');
      arr[+t.dataset.blank] = t.value;
      setAnswer(q, arr);
    }
  });
  qBox.addEventListener('change', (e) => {
    const q = questions[idx];
    const t = e.target;
    if (t.name === 'opt' && q.kind === 'single') setAnswer(q, t.value);
    else if (t.name === 'opt' && q.kind === 'multi') setAnswer(q, [...qBox.querySelectorAll('input[name=opt]:checked')].map((x) => x.value));
    else if (t.name === 'tf') setAnswer(q, t.value === 'true');
  });
  qBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mv]');
    if (!b) return;
    const q = questions[idx];
    const ids = Array.isArray(answers[q.id]) ? answers[q.id].slice() : q.items.map((i) => i.id);
    const i = +b.dataset.i,
      j = i + +b.dataset.mv;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setAnswer(q, ids);
    $('#q-body').innerHTML = body(q);
  });
  
  $('#prev-btn').addEventListener('click', () => { if (idx > 0) { idx--;
      render(); } });
  $('#next-btn').addEventListener('click', () => { if (idx < questions.length - 1) { idx++;
      render(); } });
  
  /* ───── الحفظ التلقائي (الخادم يتجاهل الكتابة إذا لم تتغير الإجابات) ───── */
  const scheduleSave = debounce(save, AUTOSAVE_MS);
  async function save() {
    if (!dirty || saving || submitting || !creds) return;
    saving = true;
    const snap = JSON.stringify(answers);
    try {
      await API.saveAnswers(creds, answers);
      if (JSON.stringify(answers) === snap) dirty = false;
      $('#save-state').textContent = 'تم الحفظ';
    } catch (e) {
      if (e.code === 'ATTEMPT_SUBMITTED' || e.code === 'ATTEMPT_EXPIRED') { goResult(); return; }
      $('#save-state').textContent = 'تعذر الحفظ — سنعيد المحاولة';
      scheduleSave();
    } finally {
      saving = false;
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
  window.addEventListener('pagehide', save);
  window.addEventListener('online', save);
  
  /* ───── التسليم ───── */
  $('#submit-btn').addEventListener('click', async () => {
    const unanswered = questions.filter((q) => !isAnswered(q)).length;
    const msg = unanswered ? `لديك ${unanswered} سؤال دون إجابة. بعد التسليم لا يمكنك تعديل إجاباتك. هل تريد التسليم؟` : 'بعد التسليم لا يمكنك تعديل إجاباتك. هل تريد التسليم؟';
    if (await confirmDialog(msg, { title: 'تسليم الامتحان', okText: 'نعم، سلّم الامتحان', cancelText: 'العودة للأسئلة' })) doSubmit(false);
  });
  
  async function doSubmit(auto) {
    if (submitting) return;
    submitting = true;
    scheduleSave.cancel();
    ['prev-btn', 'next-btn', 'submit-btn'].forEach((id) => { $('#' + id).disabled = true; });
    const msg = $('#exam-msg');
    showAlert(msg, auto ? 'انتهى الوقت. جارٍ تسليم إجاباتك…' : 'جارٍ تسليم إجاباتك…', 'info');
    for (let attempt = 0;; attempt++) {
      try {
        await API.submitAttempt(creds, answers);
        return goResult();
      } catch (e) {
        if (['ATTEMPT_SUBMITTED', 'ATTEMPT_EXPIRED', 'BAD_ATTEMPT'].includes(e.code)) return goResult();
        if (!auto && attempt >= 0) { // تسليم يدوي: نعيد التحكم للطالب ليحاول مجددًا
          submitting = false;
          ['prev-btn', 'next-btn', 'submit-btn'].forEach((id) => { $('#' + id).disabled = false; });
          $('#prev-btn').disabled = idx === 0;
          showAlert(msg, 'تعذر التسليم: ' + e.message + ' — إجاباتك ما زالت محفوظة في هذه الصفحة، حاول مرة أخرى.', 'error');
          return;
        }
        await new Promise((r) => setTimeout(r, 3000)); // تسليم تلقائي: نعيد المحاولة حتى ينجح
      }
    }
  }
  
  init();
})();