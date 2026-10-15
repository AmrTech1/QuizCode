/* QuizCode — صفحة نتيجة الطالب. بيانات المحاولة تأتي من الجزء بعد # في الرابط */
(function() {
  'use strict';
  const { $, esc, showAlert, fmtDateTime, fmtNum } = window.UI;
  const API = window.QuizAPI;
  const R = window.Render;
  const content = $('#content');
  const creds = API.parseResultHash(location.hash);
  let pollTimer = null;
  
  const REASONS = {
    pending_grading: 'تم تسليم إجاباتك. النتيجة ستظهر بعد انتهاء المسؤول من تصحيح الأسئلة المقالية.',
    not_published: 'تم تسليم إجاباتك. لم ينشر المسؤول النتيجة بعد، عُد لاحقًا.',
    hidden: 'تم تسليم إجاباتك. النتيجة غير متاحة للعرض حاليًا.',
  };
  
  async function load() {
    if (!creds) {
      content.innerHTML = '<div class="card center"><p>لا توجد بيانات محاولة في هذا الرابط.</p><a class="btn btn-primary" href="index.html">الصفحة الرئيسية</a></div>';
      return;
    }
    try {
      const r = await API.attemptResult(creds);
      showAlert($('#msg'), '');
      $('#save-hint').hidden = false;
      if (r.status === 'in_progress') {
        content.innerHTML = '<div class="card center"><p>هذه المحاولة ما زالت جارية ولم تُسلَّم بعد.</p></div>';
        return;
      }
      r.visible ? renderResult(r) : renderWaiting(r);
    } catch (e) {
      showAlert($('#msg'), e.code === 'BAD_ATTEMPT' ? 'رابط النتيجة غير صالح أو تم حذف الامتحان.' : e.message);
      content.innerHTML = '';
    }
  }
  
  function header(r) {
    return `<h1>${esc(r.examTitle)}</h1><p class="muted">${esc(r.name)}${r.studentCode ? ' — ' + esc(r.studentCode) : ''}<br>وقت التسليم: ${esc(fmtDateTime(r.submittedAt))}</p>`;
  }
  
  function renderWaiting(r) {
    content.innerHTML = `<div class="card">${header(r)}<div class="alert alert-info">${esc(REASONS[r.reason] || REASONS.not_published)}</div>
      <button id="refresh" class="btn btn-secondary" type="button">تحديث الصفحة</button></div>`;
    $('#refresh').addEventListener('click', load);
  }
  
  function renderResult(r) {
    const s = r.result;
    const verdict = s.passed === null ? '' : s.passed ? '<span class="badge badge-ok">ناجح</span>' : '<span class="badge badge-danger">راسب</span>';
    let html = `<div class="card">${header(r)}
      <div class="center"><div class="score-big">${esc(fmtNum(s.total))} / ${esc(fmtNum(s.max))}</div>
      <p>النسبة: <b>${esc(fmtNum(s.percent))}%</b> ${verdict}</p></div>
      ${s.pending ? `<div class="alert alert-warn">يوجد ${esc(s.pending)} سؤال مقالي لم يُصحَّح بعد، وقد تتغير درجتك.</div>` : ''}</div>`;
    if (s.review) {
      html += '<h2>مراجعة الإجابات</h2>' + s.review.map((it, i) => {
        const q = it.question;
        const ans = R.answerText(q, it.answer);
        const cor = R.correctText(q, it.correct);
        return `<div class="card review-item ${esc(it.status)}">
          <div class="row between"><b>سؤال ${i + 1}</b><span>${R.statusBadge(it.status)} <span class="badge">${esc(fmtNum(it.score))} / ${esc(fmtNum(it.max))}</span></span></div>
          <p class="q-text">${esc(q.text)}</p>
          ${q.imageUrl ? `<img class="q-image" src="${esc(q.imageUrl)}" alt="صورة السؤال" referrerpolicy="no-referrer">` : ''}
          <p><b>إجابتك:</b> <span style="white-space:pre-wrap">${ans ? esc(ans) : '<span class="muted">لم تُجب</span>'}</span></p>
          ${cor ? `<p><b>الإجابة الصحيحة:</b> ${esc(cor)}</p>` : ''}
          ${it.note ? `<p><b>ملاحظة المصحّح:</b> ${esc(it.note)}</p>` : ''}
          ${it.explanation ? `<p class="muted"><b>شرح:</b> ${esc(it.explanation)}</p>` : ''}</div>`;
      }).join('');
    }
    content.innerHTML = html;
  }
  
  load();
})();