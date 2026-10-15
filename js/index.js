/* QuizCode — الصفحة الرئيسية للطلاب: التحقق من الكود ثم الانتقال إلى exam.html */
(function() {
  'use strict';
  const { $, showAlert, withBusy, normalizeCodeInput, fmtDateTime } = window.UI;
  const form = $('#enter-form');
  const input = $('#code');
  const btn = $('#enter-btn');
  const msg = $('#msg');
  
  if (!window.QuizAPI.isConfigured()) {
    showAlert(msg, 'لم يتم ضبط عنوان الخادم بعد. عدّل API_BASE في الملف js/config.js', 'warn');
  }
  
  input.addEventListener('input', () => {
    const pos = input.selectionStart;
    const v = normalizeCodeInput(input.value);
    if (v !== input.value) { input.value = v; try { input.setSelectionRange(pos, pos); } catch { /* تجاهل */ } }
    showAlert(msg, '');
  });
  
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCodeInput(input.value);
    if (!code) { showAlert(msg, 'اكتب كود الامتحان أولًا.', 'error');
      input.focus(); return; }
    withBusy(btn, 'جارٍ التحقق…', async () => {
      showAlert(msg, '');
      try {
        await window.QuizAPI.lookupExam(code);
        location.href = 'exam.html?code=' + encodeURIComponent(code);
      } catch (err) {
        let text = err.message;
        if (err.code === 'EXAM_NOT_OPEN' && err.extra.opensAt) text += ` — يبدأ في ${fmtDateTime(err.extra.opensAt)}`;
        showAlert(msg, text, err.code === 'EXAM_NOT_FOUND' || err.code === 'BAD_CODE' ? 'error' : 'warn');
      }
    });
  });
  
  input.focus();
})();