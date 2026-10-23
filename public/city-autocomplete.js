/* City,state autocomplete shared by the portal, find, and request pages.
   Suggestions come from /api/cities (bundled US city dataset). */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var seq = 0;
  function fetchCities(q, state) {
    var my = ++seq;
    var url = '/api/cities?q=' + encodeURIComponent(q) + '&state=' + encodeURIComponent(state || '') + '&limit=8';
    return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      if (my !== seq) return null; // stale
      return (d && d.cities) || [];
    }).catch(function () { return []; });
  }

  var CSS = '.ca-drop{position:absolute;left:0;right:0;top:100%;z-index:60;background:#fff;border:1px solid #e2e8f0;border-radius:10px;margin-top:4px;box-shadow:0 10px 28px rgba(15,23,42,.14);max-height:240px;overflow:auto;display:none}' +
    '.ca-item{display:block;width:100%;text-align:left;background:none;border:0;padding:10px 12px;font-size:.95rem;color:#0f172a;cursor:pointer}' +
    '.ca-item small{color:#64748b;margin-left:6px}' +
    '.ca-item.active,.ca-item:hover{background:#eff6ff}' +
    '.ca-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}' +
    '.ca-chip{display:inline-flex;align-items:center;gap:6px;background:#eff6ff;border:1px solid #bfdbfe;color:#0f172a;border-radius:999px;padding:6px 6px 6px 12px;font-size:.9rem}' +
    '.ca-chip button{border:0;background:#dbeafe;color:#1e40af;border-radius:999px;width:22px;height:22px;line-height:1;cursor:pointer;font-size:.85rem}';

  function ensureCss() {
    if (document.getElementById('ca-css')) return;
    var st = document.createElement('style');
    st.id = 'ca-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function makeDrop() {
    var d = document.createElement('div');
    d.className = 'ca-drop';
    return d;
  }

  /* Single city input. Selecting fills the input and (optionally) a state input. */
  function attach(input, opts) {
    opts = opts || {};
    ensureCss();
    var stateInput = opts.stateInput || null;
    var onSelect = opts.onSelect || null;
    var wrap = input.parentNode;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
    var drop = makeDrop();
    wrap.appendChild(drop);
    var items = [], active = -1, timer = null, lastQ = '';

    function close() { drop.style.display = 'none'; items = []; active = -1; }
    function render() {
      if (!items.length) { close(); return; }
      drop.innerHTML = items.map(function (it, i) {
        return '<button type="button" class="ca-item' + (i === active ? ' active' : '') + '" data-i="' + i + '">' +
          esc(it.city) + '<small>' + esc(it.state) + '</small></button>';
      }).join('');
      drop.style.display = 'block';
      Array.prototype.forEach.call(drop.querySelectorAll('.ca-item'), function (el) {
        el.addEventListener('mousedown', function (e) {
          e.preventDefault();
          pick(items[parseInt(el.getAttribute('data-i'), 10)]);
        });
        el.addEventListener('mousemove', function () {
          active = parseInt(el.getAttribute('data-i'), 10);
          paintActive();
        });
      });
    }
    function paintActive() {
      Array.prototype.forEach.call(drop.querySelectorAll('.ca-item'), function (el, i) {
        el.classList.toggle('active', i === active);
      });
    }
    function pick(it) {
      if (!it) return;
      input.value = it.city;
      if (stateInput) stateInput.value = it.state;
      close();
      if (onSelect) onSelect(it);
    }
    function search() {
      var q = input.value.trim();
      if (q.length < 2 || q === lastQ) { if (q.length < 2) close(); return; }
      lastQ = q;
      var st = stateInput ? stateInput.value.trim() : '';
      fetchCities(q, st).then(function (list) {
        if (list === null) return;
        items = list; active = list.length ? 0 : -1;
        render();
      });
    }
    input.addEventListener('input', function () {
      lastQ = '';
      clearTimeout(timer);
      timer = setTimeout(search, 180);
    });
    input.addEventListener('focus', function () { lastQ = ''; search(); });
    input.addEventListener('keydown', function (e) {
      if (drop.style.display !== 'block') return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); paintActive(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paintActive(); }
      else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); pick(items[active]); } }
      else if (e.key === 'Escape') { close(); }
    });
    input.addEventListener('blur', function () { setTimeout(close, 120); });
    return { close: close };
  }

  /* Multi-city chips for service areas. get() -> ["City, ST", ...] */
  function chips(mount, opts) {
    opts = opts || {};
    ensureCss();
    mount.innerHTML = '<div class="ca-chips"></div>' +
      '<div style="position:relative"><input class="ca-city-input" placeholder="Type a city, then pick it from the list" autocomplete="off">' +
      '<div class="ca-drop"></div></div>' +
      '<p class="muted" style="font-size:.82rem;margin:6px 0 0">Pick each city from the list so it is spelled right and in the right state.</p>';
    var chipBox = mount.querySelector('.ca-chips');
    var input = mount.querySelector('.ca-city-input');
    var drop = mount.querySelector('.ca-drop');
    var list = [];
    var items = [], active = -1, timer = null;

    function renderChips() {
      chipBox.innerHTML = list.map(function (c, i) {
        return '<span class="ca-chip">' + esc(c) + '<button type="button" data-i="' + i + '" aria-label="Remove">&times;</button></span>';
      }).join('');
      Array.prototype.forEach.call(chipBox.querySelectorAll('button'), function (b) {
        b.addEventListener('click', function () {
          list.splice(parseInt(b.getAttribute('data-i'), 10), 1);
          renderChips();
        });
      });
    }
    function close() { drop.style.display = 'none'; items = []; active = -1; }
    function add(it) {
      if (!it) return;
      var label = it.city + ', ' + it.state;
      if (list.indexOf(label) === -1) list.push(label);
      input.value = '';
      close();
      renderChips();
      input.focus();
    }
    function render() {
      if (!items.length) { close(); return; }
      drop.innerHTML = items.map(function (it, i) {
        return '<button type="button" class="ca-item' + (i === active ? ' active' : '') + '" data-i="' + i + '">' +
          esc(it.city) + '<small>' + esc(it.state) + '</small></button>';
      }).join('');
      drop.style.display = 'block';
      Array.prototype.forEach.call(drop.querySelectorAll('.ca-item'), function (el) {
        el.addEventListener('mousedown', function (e) {
          e.preventDefault();
          add(items[parseInt(el.getAttribute('data-i'), 10)]);
        });
      });
    }
    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var q = input.value.trim();
        if (q.length < 2) { close(); return; }
        fetchCities(q, '').then(function (res) {
          if (res === null) return;
          items = res; active = res.length ? 0 : -1;
          render();
        });
      }, 180);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (drop.style.display === 'block' && active >= 0) add(items[active]);
        else if (items.length) add(items[0]);
      } else if (e.key === 'Escape') { close(); }
      else if (e.key === 'Backspace' && !input.value && list.length) { list.pop(); renderChips(); }
    });
    input.addEventListener('blur', function () { setTimeout(close, 120); });
    renderChips();
    return {
      get: function () { return list.slice(); },
      set: function (arr) {
        list = (arr || []).map(function (c) { return String(c).trim(); }).filter(Boolean);
        renderChips();
      }
    };
  }

  window.CityAC = { attach: attach, chips: chips };
})();
