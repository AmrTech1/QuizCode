/* QuizCode — عرض الإجابات وحالات التصحيح (مشترك بين result.html و admin.html) */
(function() {
  'use strict';
  const { esc } = window.UI;
  
  const kindOf = (q) => q.kind || (q.type === 'image' ? q.subtype || 'single' : q.type);
  const optText = (q, id) => { const o = (q.options || []).find((x) => x.id === id); return o ? o.text : String(id); };
  const itemText = (q, id) => { const o = (q.items || []).find((x) => x.id === id); return o ? o.text : String(id); };
  
  /* نص إجابة الطالب. يعيد نصًا عاديًا (استخدم esc عند عرضه). النص الفارغ = لم يجب */
  function answerText(q, v) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return '';
    switch (kindOf(q)) {
      case 'single':
        return optText(q, v);
      case 'multi':
        return (Array.isArray(v) ? v : []).map((id) => optText(q, id)).join('، ');
      case 'tf':
        return v === true ? 'صح' : 'خطأ';
      case 'fill':
        return (Array.isArray(v) ? v : []).map((x, i) => `(${i + 1}) ${x || '—'}`).join('   ');
      case 'order':
        return (Array.isArray(v) ? v : []).map((id) => itemText(q, id)).join(' ← ');
      default:
        return String(v);
    }
  }
  
  /* نص الإجابة الصحيحة (يُعرض فقط عندما يرسلها الخادم) */
  function correctText(q, c) {
    if (c === null || c === undefined) return '';
    switch (kindOf(q)) {
      case 'single':
        return optText(q, c);
      case 'multi':
        return (c || []).map((id) => optText(q, id)).join('، ');
      case 'tf':
        return c === true ? 'صح' : 'خطأ';
      case 'short':
        return (c || []).join(' / ');
      case 'fill':
        return (c || []).map((a, i) => `(${i + 1}) ${a.join(' / ')}`).join('   ');
      case 'order':
        return (c || []).map((id) => itemText(q, id)).join(' ← ');
      default:
        return '';
    }
  }
  
  const STATUS = {
    correct: ['صحيحة', 'badge-ok'],
    wrong: ['خاطئة', 'badge-danger'],
    partial: ['صحيحة جزئيًا', 'badge-warn'],
    unanswered: ['دون إجابة', ''],
    pending: ['بانتظار التصحيح', 'badge-warn'],
    graded: ['تم تصحيحها', 'badge-info'],
  };
  
  function statusBadge(status) {
    const s = STATUS[status] || [status, ''];
    return `<span class="badge ${s[1]}">${esc(s[0])}</span>`;
  }
  
  const TYPE_LABELS = { single: 'اختيار إجابة واحدة', multi: 'اختيار متعدد', tf: 'صح أو خطأ', short: 'إجابة نصية قصيرة', fill: 'أكمل الفراغ', order: 'ترتيب العناصر', image: 'سؤال صورة', essay: 'سؤال مقالي' };
  
  window.Render = { kindOf, answerText, correctText, statusBadge, TYPE_LABELS };
})();