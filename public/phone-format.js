// Shared US phone formatting: display as (xxx) xxx-xxxx, no leading 1.
// Storage stays E.164 on the server; this is display and input only.
(function () {
  function digitsOf(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  function coreDigits(v) {
    let d = digitsOf(v);
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    return d;
  }
  // Full display form for a complete number; anything else passes through.
  function display(v) {
    const d = coreDigits(v);
    if (d.length !== 10) return String(v == null ? '' : v);
    return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  }
  // Progressive form while typing; leaves longer input alone.
  function progressive(v) {
    if (digitsOf(v).length > 11) return String(v);
    const d = coreDigits(v);
    if (d.length === 0) return '';
    if (d.length <= 3) return '(' + d;
    if (d.length <= 6) return '(' + d.slice(0, 3) + ') ' + d.slice(3);
    return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6, 10);
  }
  function attach(input) {
    if (!input) return;
    input.addEventListener('input', () => {
      const prev = input.value;
      const sel = input.selectionStart;
      const digitsBefore = digitsOf(prev.slice(0, sel == null ? prev.length : sel)).length;
      const next = progressive(prev);
      input.value = next;
      let seen = 0, pos = next.length;
      for (let i = 0; i < next.length; i++) {
        if (/\d/.test(next[i])) seen++;
        if (seen >= digitsBefore) { pos = i + 1; break; }
      }
      try { input.setSelectionRange(pos, pos); } catch (e) {}
    });
    if (input.value) input.value = progressive(input.value);
  }
  window.PhoneFmt = { display: display, progressive: progressive, attach: attach };
})();
