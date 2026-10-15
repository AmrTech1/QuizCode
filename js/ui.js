/* QuizCode — أدوات الواجهة المشتركة (بدون أي مكتبات خارجية) */
(function() {
  'use strict';
  
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  
  /* تهريب HTML — استخدمه دائمًا عند إدخال نص قادم من المستخدم أو الخادم داخل innerHTML */
  const esc = (v) => String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } [c]));
  
  function toast(message, type = 'info', ms = 3800) {
    let box = $('#toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toasts';
      box.className = 'toasts';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.textContent = message;
    box.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }
  
  /* يعرض رسالة داخل عنصر تنبيه (alert). مرّر رسالة فارغة لإخفائه */
  function showAlert(box, message, type = 'error') {
    if (!box) return;
    if (!message) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.hidden = false;
    box.className = 'alert alert-' + type;
    box.textContent = message;
  }
  
  function setBusy(btn, busy, busyText) {
    if (!btn) return;
    if (busy) {
      if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent;
      btn.disabled = true;
      btn.classList.add('is-busy');
      if (busyText) btn.textContent = busyText;
    } else {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      if (btn.dataset.label !== undefined) {
        btn.textContent = btn.dataset.label;
        delete btn.dataset.label;
      }
    }
  }
  /* ينفذ العملية مع تعطيل الزر لمنع النقر المتكرر */
  async function withBusy(btn, busyText, fn) {
    if (btn && btn.disabled) return undefined;
    setBusy(btn, true, busyText);
    try { return await fn(); } finally { setBusy(btn, false); }
  }
  
  /* نافذة تأكيد: تُرجع Promise<boolean> */
  function confirmDialog(message, opts = {}) {
    const { title = 'تأكيد', okText = 'تأكيد', cancelText = 'إلغاء', danger = false } = opts;
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-backdrop';
      back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mdl-t">
        <h2 id="mdl-t">${esc(title)}</h2><p>${esc(message)}</p>
        <div class="modal-actions"><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okText)}</button>
        <button type="button" class="btn btn-ghost" data-cancel>${esc(cancelText)}</button></div></div>`;
      const prev = document.activeElement;
      const close = (val) => {
        document.removeEventListener('keydown', onKey);
        back.remove();
        if (prev && prev.focus) prev.focus();
        resolve(val);
      };
      const onKey = (e) => { if (e.key === 'Escape') close(false); };
      back.addEventListener('click', (e) => { if (e.target === back) close(false); });
      $('[data-ok]', back).addEventListener('click', () => close(true));
      $('[data-cancel]', back).addEventListener('click', () => close(false));
      document.addEventListener('keydown', onKey);
      document.body.appendChild(back);
      $('[data-cancel]', back).focus();
    });
  }
  
  /* تنسيق */
  function fmtDateTime(ms) {
    if (!ms) return '—';
    try { return new Date(ms).toLocaleString('ar-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return new Date(ms).toLocaleString(); }
  }
  
  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
  }
  const fmtNum = (n) => (n === null || n === undefined ? '—' : String(Math.round(n * 100) / 100));
  
  /* حقول datetime-local ⇄ ms */
  function toLocalInput(ms) {
    if (!ms) return '';
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  }
  
  function fromLocalInput(str) {
    if (!str) return null;
    const t = new Date(str).getTime();
    return Number.isFinite(t) ? t : null;
  }
  
  /* تحويل الأرقام العربية إلى إنجليزية وتوحيد الكود (يطابق منطق الخادم) */
  function normalizeCodeInput(s) {
    return String(s || '')
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/\s+/g, '')
      .toUpperCase();
  }
  
  function debounce(fn, ms) {
    let t;
    const d = (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
    d.cancel = () => clearTimeout(t);
    return d;
  }
  
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  
  window.UI = { $, $$, esc, toast, showAlert, setBusy, withBusy, confirmDialog, fmtDateTime, fmtClock, fmtNum, toLocalInput, fromLocalInput, normalizeCodeInput, debounce, downloadBlob };
})();