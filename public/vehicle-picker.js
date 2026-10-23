/* VehiclePicker: vehicle-type tabs + three cascading dropdowns
   (Year -> Make -> Model) backed by /api/vehicles/years,
   /api/vehicles/makes?year=&type=, /api/vehicles/models?year=&make=.
   Page provides three <select> elements and a container for the type tabs:

   <div id="f-type"></div>
   <select id="f-year"></select><select id="f-make"></select><select id="f-model"></select>

   const picker = VehiclePicker.attach({ year: 'f-year', make: 'f-make', model: 'f-model', type: 'f-type', onChange: fn });
   picker.get()            -> { year, make, model, type } or null when incomplete
   picker.vehicleString()  -> "2020 Honda Accord" or ""
   picker.setType('motorcycle')
   picker.set(year, make, model)      -> async; selects values (for saved vehicles)
   picker.setFromString("2020 Honda Accord") -> async; best-effort parse
   picker.reset()          -> clears year/make/model (keeps type)
*/
(function () {
  const OTHER = '__other';
  const TYPES = [
    { id: 'car', label: 'Car / Truck' },
    { id: 'motorcycle', label: 'Motorcycle' },
    { id: 'commercial', label: 'Bus / Commercial' },
    { id: 'smallengine', label: 'Small Engine' }
  ];
  // Curated brand list: NHTSA does not track outdoor power equipment,
  // so small engines use a static list + free-text model instead of year/make/model.
  const SMALL_ENGINE_BRANDS = ['Ariens', 'Briggs & Stratton', 'Champion', 'Craftsman', 'Cub Cadet',
    'Dewalt', 'ECHO', 'EGO', 'Generac', 'Greenworks', 'Honda', 'Husqvarna', 'John Deere',
    'Kawasaki', 'Kohler', 'MTD', 'Poulan Pro', 'Predator', 'Ryobi', 'Snapper', 'STIHL',
    'Tecumseh', 'Toro', 'Troy-Bilt', 'Westinghouse'];
  const cache = { years: null, makes: {}, models: {} };

  async function getYears() {
    if (!cache.years) {
      const d = await (await fetch('/api/vehicles/years')).json().catch(() => ({}));
      cache.years = Array.isArray(d.years) ? d.years.slice().sort((a, b) => b - a) : [];
    }
    return cache.years;
  }
  async function getMakes(year, type) {
    const k = type + '|' + year;
    if (!cache.makes[k]) {
      const d = await (await fetch('/api/vehicles/makes?year=' + encodeURIComponent(year) + '&type=' + encodeURIComponent(type))).json().catch(() => ({}));
      cache.makes[k] = Array.isArray(d.makes) ? d.makes : [];
    }
    return cache.makes[k];
  }
  async function getModels(year, make) {
    const k = year + '|' + make;
    if (!cache.models[k]) {
      const d = await (await fetch('/api/vehicles/models?year=' + encodeURIComponent(year) + '&make=' + encodeURIComponent(make))).json().catch(() => ({}));
      cache.models[k] = Array.isArray(d.models) ? d.models : [];
    }
    return cache.models[k];
  }

  function fillSelect(sel, items, placeholder) {
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = placeholder; ph.disabled = true; ph.selected = true;
    sel.appendChild(ph);
    items.forEach(v => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    });
    const o = document.createElement('option');
    o.value = OTHER; o.textContent = 'Other / not listed';
    sel.appendChild(o);
  }

  function ensureTypeStyles() {
    if (document.getElementById('vp-type-styles')) return;
    const st = document.createElement('style');
    st.id = 'vp-type-styles';
    st.textContent = '.vp-type{display:flex;gap:8px;margin:0 0 10px}' +
      '.vp-type button{flex:1;padding:10px 6px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;' +
      'font-size:14px;font-weight:600;color:#475569;cursor:pointer}' +
      '.vp-type button.on{background:#2563eb;border-color:#2563eb;color:#fff}';
    document.head.appendChild(st);
  }

  function attach(opts) {
    const yearSel = document.getElementById(opts.year);
    const makeSel = document.getElementById(opts.make);
    const modelSel = document.getElementById(opts.model);
    if (!yearSel || !makeSel || !modelSel) return null;
    ensureTypeStyles();

    let curType = 'car';
    const typeBox = opts.type ? document.getElementById(opts.type) : null;
    if (typeBox) {
      typeBox.className = (typeBox.className + ' vp-type').trim();
      typeBox.innerHTML = '';
      TYPES.forEach(t => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.t = t.id;
        b.textContent = t.label;
        if (t.id === curType) b.classList.add('on');
        b.addEventListener('click', () => api.setType(t.id));
        typeBox.appendChild(b);
      });
    }
    function paintType() {
      if (!typeBox) return;
      Array.prototype.forEach.call(typeBox.querySelectorAll('button'), b => {
        b.classList.toggle('on', b.dataset.t === curType);
      });
    }

    // "Other" free-text inputs, created and managed by the picker
    function makeOtherInput(sel, placeholder) {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = placeholder;
      inp.maxLength = 60;
      inp.style.display = 'none';
      inp.style.marginTop = '6px';
      sel.insertAdjacentElement('afterend', inp);
      return inp;
    }
    const makeOther = makeOtherInput(makeSel, 'Enter the make');
    const modelOther = makeOtherInput(modelSel, 'Enter the model');

    function fire() { if (typeof opts.onChange === 'function') { try { opts.onChange(api.get()); } catch (e) {} } }

    function isSmallEngine() { return curType === 'smallengine'; }
    function yearLabel() { return document.querySelector('label[for="' + yearSel.id + '"]'); }

    // Small-engine mode: no year; brand dropdown + free-text equipment model.
    function configureForType() {
      const se = isSmallEngine();
      yearSel.style.display = se ? 'none' : '';
      const yl = yearLabel();
      if (yl) yl.style.display = se ? 'none' : '';
      if (se) {
        fillSelect(makeSel, SMALL_ENGINE_BRANDS, 'Select brand');
        makeSel.disabled = false;
        modelSel.style.display = 'none';
        modelOther.style.display = '';
        modelOther.placeholder = 'Equipment, e.g. 21" push mower';
        modelOther.value = '';
        makeOther.style.display = 'none';
        makeOther.value = '';
      } else {
        modelOther.placeholder = 'Enter the model';
        api.reset();
      }
      fire();
    }

    function syncOther() {
      if (isSmallEngine()) {
        const mOther = makeSel.value === OTHER;
        makeOther.style.display = mOther ? '' : 'none';
        if (!mOther) makeOther.value = '';
        modelSel.style.display = 'none';
        modelOther.style.display = '';
        return;
      }
      const mOther = makeSel.value === OTHER;
      const dOther = modelSel.value === OTHER;
      makeOther.style.display = mOther ? '' : 'none';
      if (!mOther) makeOther.value = '';
      // model falls back to free text when the make is custom (no dataset for it)
      const modelFree = mOther || dOther;
      modelSel.style.display = mOther ? 'none' : '';
      modelOther.style.display = modelFree ? '' : 'none';
      if (!modelFree) modelOther.value = '';
    }

    async function reloadMakes() {
      const y = yearSel.value;
      fillSelect(makeSel, [], 'Select make');
      fillSelect(modelSel, [], 'Select model');
      makeSel.disabled = !y; modelSel.disabled = true;
      syncOther(); fire();
      if (!y) return;
      const makes = await getMakes(y, curType);
      // keep the chosen year/type if the user moved on meanwhile
      if (yearSel.value !== y) return;
      fillSelect(makeSel, makes, 'Select make');
      makeSel.disabled = false;
      syncOther();
    }

    yearSel.addEventListener('change', reloadMakes);
    makeSel.addEventListener('change', async () => {
      const y = yearSel.value, m = makeSel.value;
      fillSelect(modelSel, [], 'Select model');
      modelSel.disabled = true;
      syncOther(); fire();
      if (!y || !m || m === OTHER) { syncOther(); return; }
      const models = await getModels(y, m);
      if (yearSel.value !== y || makeSel.value !== m) return;
      fillSelect(modelSel, models, 'Select model');
      modelSel.disabled = false;
      syncOther();
    });
    modelSel.addEventListener('change', () => { syncOther(); fire(); });
    makeOther.addEventListener('input', fire);
    modelOther.addEventListener('input', fire);

    const api = {
      get type() { return curType; },
      setType(t) {
        if (!TYPES.some(x => x.id === t) || t === curType) return;
        curType = t;
        paintType();
        if (isSmallEngine()) { configureForType(); return; }
        // leaving small-engine mode: restore the normal cascade
        yearSel.style.display = '';
        const yl = yearLabel();
        if (yl) yl.style.display = '';
        modelSel.style.display = '';
        reloadMakes();
      },
      get() {
        if (isSmallEngine()) {
          const b = makeSel.value;
          if (!b || b === OTHER) return null;
          const mo = modelOther.value.trim();
          if (!mo) return null;
          return { year: '', make: b, model: mo, type: curType };
        }
        const y = yearSel.value;
        if (!y) return null;
        let m = makeSel.value, mo;
        if (!m) return null;
        if (m === OTHER) {
          m = makeOther.value.trim();
          mo = modelOther.value.trim();
        } else {
          mo = modelSel.value;
          if (!mo) return null;
          if (mo === OTHER) mo = modelOther.value.trim();
        }
        if (!m || !mo) return null;
        return { year: y, make: m, model: mo, type: curType };
      },
      vehicleString() {
        const v = this.get();
        if (!v) return '';
        return v.type === 'smallengine' ? (v.make + ' ' + v.model) : (v.year + ' ' + v.make + ' ' + v.model);
      },
      async set(y, m, mo) {
        y = String(y || ''); m = String(m || ''); mo = String(mo || '');
        if (isSmallEngine()) {
          if (!SMALL_ENGINE_BRANDS.includes(m)) {
            // unknown brand: leave type tab, stash as free text via Other
            makeSel.value = OTHER; syncOther();
            makeOther.value = m; modelOther.value = mo;
            syncOther(); fire();
            return;
          }
          makeSel.value = m;
          modelOther.value = mo;
          syncOther(); fire();
          return;
        }
        this.reset();
        const years = await getYears();
        if (y && years.map(String).includes(y)) {
          yearSel.value = y;
          yearSel.dispatchEvent(new Event('change'));
          const makes = await getMakes(y, curType);
          if (makes.includes(m)) {
            makeSel.value = m;
            makeSel.dispatchEvent(new Event('change'));
            const models = await getModels(y, m);
            if (models.includes(mo)) { modelSel.value = mo; }
            else if (mo) { modelSel.value = OTHER; }
          } else if (m) {
            makeSel.value = OTHER;
          }
          syncOther();
          if (makeSel.value === OTHER) {
            makeOther.value = m;
            modelOther.value = mo;
          } else if (modelSel.value === OTHER) {
            modelOther.value = mo;
          }
          syncOther(); fire();
        } else if (y || m || mo) {
          // year unknown: drop everything into free text under Other
          const years2 = await getYears();
          if (years2.length) { yearSel.value = String(years2[0]); yearSel.dispatchEvent(new Event('change')); }
          makeSel.value = OTHER; syncOther();
          makeOther.value = [y, m].filter(Boolean).join(' ');
          modelOther.value = mo;
          syncOther(); fire();
        }
      },
      async setFromString(str) {
        str = String(str || '').trim();
        if (isSmallEngine()) {
          // format is "Brand <equipment>" with no year
          let hit = '';
          const sl = str.toLowerCase();
          SMALL_ENGINE_BRANDS.forEach(b => { if (sl.indexOf(b.toLowerCase()) === 0 && b.length > hit.length) hit = b; });
          if (hit) await this.set('', hit, str.slice(hit.length).trim());
          else await this.set('', str, '');
          return;
        }
        const ym = str.match(/^(\d{4})\s+(.+)$/);
        if (!ym) {
          // no leading year: stash the whole thing as free text
          const years = await getYears();
          if (!years.length) return;
          yearSel.value = String(years[0]);
          yearSel.dispatchEvent(new Event('change'));
          await getMakes(yearSel.value, curType);
          makeSel.value = OTHER; syncOther();
          makeOther.value = ''; modelOther.value = str;
          syncOther(); fire();
          return;
        }
        const y = ym[1], rest = ym[2];
        const years = await getYears();
        if (!years.map(String).includes(y)) { await this.set(y, '', rest); return; }
        const makes = await getMakes(y, curType);
        // longest make name that matches the start of the remainder
        let hit = '';
        const rl = rest.toLowerCase();
        makes.forEach(mk => { if (rl.indexOf(mk.toLowerCase()) === 0 && mk.length > hit.length) hit = mk; });
        if (hit) {
          const mo = rest.slice(hit.length).trim();
          await this.set(y, hit, mo);
        } else {
          await this.set(y, rest, '');
        }
      },
      reset() {
        if (isSmallEngine()) { configureForType(); return; }
        fillSelect(makeSel, [], 'Select make');
        fillSelect(modelSel, [], 'Select model');
        makeSel.disabled = true; modelSel.disabled = true;
        makeOther.value = ''; modelOther.value = '';
        getYears().then(years => {
          const keep = yearSel.value;
          yearSel.innerHTML = '';
          const ph = document.createElement('option');
          ph.value = ''; ph.textContent = 'Select year'; ph.disabled = true; ph.selected = true;
          yearSel.appendChild(ph);
          years.forEach(v => {
            const o = document.createElement('option');
            o.value = String(v); o.textContent = String(v);
            yearSel.appendChild(o);
          });
          if (keep && years.map(String).includes(keep)) yearSel.value = keep;
        });
        syncOther();
      }
    };

    api.reset();
    return api;
  }

  window.VehiclePicker = { attach, TYPES, _cache: cache };
})();
