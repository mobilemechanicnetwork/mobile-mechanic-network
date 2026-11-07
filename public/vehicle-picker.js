/* VehiclePicker: vehicle-type tabs + three cascading dropdowns
   (Year -> Make -> Model) backed by /api/vehicles/years,
   /api/vehicles/makes?year=&type=, /api/vehicles/models?year=&make=.
   Page provides three <select> elements and a container for the type tabs:

   <div id="f-type"></div>
   <select id="f-year"></select><select id="f-make"></select><select id="f-model"></select>

   const picker = VehiclePicker.attach({ year: 'f-year', make: 'f-make', model: 'f-model', type: 'f-type', onChange: fn });
   picker.get()            -> { year, make, model, type, trim, engine, transmission, drivetrain } or null when incomplete
   picker.vehicleString()  -> "2020 Honda Accord" or "" (base vehicle only)
   picker.vehicleDisplay() -> "2020 Ford Explorer XL 3.5L Manual AWD" or "" (base + optional trim/engine/transmission/drivetrain)
   picker.setType('motorcycle')
   picker.set(year, make, model, trim, engine, transmission, drivetrain) -> async; selects values (for saved vehicles)
   picker.setFromString("2020 Honda Accord") -> async; best-effort parse (extras stay blank)
   picker.reset()          -> clears year/make/model and the extras (keeps type)
   VehiclePicker.display(vehicle, trim, engine, transmission, drivetrain) -> composed display string for a stored vehicle
   Trim is free text; engine is a selector of the combinations available
   for the chosen vehicle (from /api/vehicles/engines, EPA data) with a
   free-text fallback when the model has no listed engines or the engine
   is not listed. Transmission is Manual/Automatic. All optional. They
   never enter the base vehicle string, so garage matching and photo
   lookup still key on year/make/model.
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
  const cache = { years: null, makes: {}, models: {}, engines: {} };

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
      // Cache the in-flight promise, not just the resolved list, so two
      // concurrent calls for the same list share one fetch instead of
      // racing each other to refill a select.
      cache.makes[k] = (async () => {
        const d = await (await fetch('/api/vehicles/makes?year=' + encodeURIComponent(year) + '&type=' + encodeURIComponent(type))).json().catch(() => ({}));
        return Array.isArray(d.makes) ? d.makes : [];
      })();
    }
    return cache.makes[k];
  }
  async function getModels(year, make, type) {
    const k = year + '|' + make + '|' + type;
    if (!cache.models[k]) {
      cache.models[k] = (async () => {
        const d = await (await fetch('/api/vehicles/models?year=' + encodeURIComponent(year) + '&make=' + encodeURIComponent(make) + '&type=' + encodeURIComponent(type))).json().catch(() => ({}));
        return Array.isArray(d.models) ? d.models : [];
      })();
    }
    return cache.models[k];
  }
  async function getEngines(year, make, model) {
    const k = year + '|' + make + '|' + model;
    if (!cache.engines[k]) {
      cache.engines[k] = (async () => {
        const d = await (await fetch('/api/vehicles/engines?year=' + encodeURIComponent(year) + '&make=' + encodeURIComponent(make) + '&model=' + encodeURIComponent(model))).json().catch(() => ({}));
        return Array.isArray(d.engines) ? d.engines : [];
      })();
    }
    return cache.engines[k];
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

    let allowed = TYPES;
    if (Array.isArray(opts.allowedTypes) && opts.allowedTypes.length) {
      const kept = TYPES.filter(t => opts.allowedTypes.includes(t.id));
      if (kept.length) allowed = kept;
    }
    let curType = allowed.some(t => t.id === 'car') ? 'car' : allowed[0].id;
    const typeBox = opts.type ? document.getElementById(opts.type) : null;
    if (typeBox) {
      typeBox.className = (typeBox.className + ' vp-type').trim();
      typeBox.innerHTML = '';
      allowed.forEach(t => {
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

    // Optional trim / engine / transmission, created and managed by the
    // picker. They sit under the model row and are never required.
    const extrasBox = document.createElement('div');
    extrasBox.style.display = 'flex';
    extrasBox.style.gap = '8px';
    extrasBox.style.flexWrap = 'wrap';
    extrasBox.style.marginTop = '6px';
    const trimInp = document.createElement('input');
    trimInp.type = 'text';
    trimInp.placeholder = 'Trim (optional), e.g. XL';
    trimInp.maxLength = 60;
    trimInp.style.flex = '1';
    trimInp.style.minWidth = '120px';
    const engineWrap = document.createElement('div');
    engineWrap.style.flex = '1';
    engineWrap.style.minWidth = '120px';
    const engineSel = document.createElement('select');
    engineSel.style.width = '100%';
    engineSel.style.display = 'none';
    const engineOther = document.createElement('input');
    engineOther.type = 'text';
    engineOther.placeholder = 'Engine (optional), e.g. 3.5L';
    engineOther.maxLength = 60;
    engineOther.style.width = '100%';
    engineWrap.appendChild(engineSel);
    engineWrap.appendChild(engineOther);
    const transSel = document.createElement('select');
    transSel.style.flex = '1';
    transSel.style.minWidth = '120px';
    const transPh = document.createElement('option');
    transPh.value = ''; transPh.textContent = 'Transmission (optional)'; transPh.disabled = true; transPh.selected = true;
    transSel.appendChild(transPh);
    ['Manual', 'Automatic'].forEach(v => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      transSel.appendChild(o);
    });
    const driveSel = document.createElement('select');
    driveSel.style.flex = '1';
    driveSel.style.minWidth = '120px';
    const drivePh = document.createElement('option');
    drivePh.value = ''; drivePh.textContent = 'Drivetrain (optional)'; drivePh.disabled = true; drivePh.selected = true;
    driveSel.appendChild(drivePh);
    ['AWD', 'FWD', 'RWD'].forEach(v => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      driveSel.appendChild(o);
    });
    extrasBox.appendChild(trimInp);
    extrasBox.appendChild(engineWrap);
    extrasBox.appendChild(transSel);
    extrasBox.appendChild(driveSel);
    // The extras row goes BELOW the year/make/model row, not inside it.
    // The picker inserts the "Other" inputs right after their selects,
    // so inserting the extras after modelOther would land it inside the
    // row's flex container, where it competes for width with the three
    // selects and squeezes them (on the new-ticket popup the year, make,
    // and model came out extremely short). Walk up to the nearest
    // ancestor that holds the year select too (the row itself, or the
    // .row wrapper) and put the extras after that instead.
    let rowEl = modelSel.parentElement;
    while (rowEl && !rowEl.contains(yearSel)) rowEl = rowEl.parentElement;
    if (rowEl && rowEl.parentElement) rowEl.insertAdjacentElement('afterend', extrasBox);
    else modelOther.insertAdjacentElement('afterend', extrasBox);

    // Engine selector: the combinations available for the chosen
    // vehicle, from /api/vehicles/engines (EPA data). The select fills
    // when a model is picked; when the model has no listed engines (or
    // the engine is not listed) the field stays a free-text input.
    // pendingEngine holds an engine set before its model's list loads
    // (set() sets the extras before the model), and reloadEngines
    // applies it once the list arrives.
    let pendingEngine = '';
    async function reloadEngines() {
      const y = yearSel.value, m = makeSel.value, mo = modelSel.value;
      const base = (!y || !m || !mo || m === OTHER || mo === OTHER) ? null : { y, m, mo };
      engineSel.style.display = 'none';
      engineOther.style.display = '';
      if (!base) { engineOther.value = pendingEngine; return; }
      const engines = await getEngines(base.y, base.m, base.mo);
      if (yearSel.value !== base.y || makeSel.value !== base.m || modelSel.value !== base.mo) return;
      if (!engines.length) { engineOther.value = pendingEngine; return; }
      engineSel.innerHTML = '';
      const ph = document.createElement('option');
      ph.value = ''; ph.textContent = 'Engine (optional)'; ph.disabled = true; ph.selected = true;
      engineSel.appendChild(ph);
      engines.forEach(v => {
        const o = document.createElement('option');
        o.value = v; o.textContent = v;
        engineSel.appendChild(o);
      });
      const o = document.createElement('option');
      o.value = OTHER; o.textContent = 'Other / not listed';
      engineSel.appendChild(o);
      engineSel.style.display = '';
      if (pendingEngine && engines.includes(pendingEngine)) {
        engineSel.value = pendingEngine;
        engineOther.style.display = 'none';
        engineOther.value = '';
      } else if (pendingEngine) {
        engineSel.value = OTHER;
        engineOther.style.display = '';
        engineOther.value = pendingEngine;
      } else {
        engineOther.style.display = 'none';
        engineOther.value = '';
      }
      pendingEngine = '';
      fire();
    }

    function getExtras() {
      let engine = '';
      if (engineSel.style.display !== 'none' && engineSel.value && engineSel.value !== OTHER) {
        engine = engineSel.value;
      } else {
        engine = engineOther.value.trim();
      }
      return {
        trim: trimInp.value.trim(),
        engine: engine,
        transmission: transSel.value === 'Manual' || transSel.value === 'Automatic' ? transSel.value : '',
        drivetrain: driveSel.value === 'AWD' || driveSel.value === 'FWD' || driveSel.value === 'RWD' ? driveSel.value : ''
      };
    }
    function setExtras(trim, engine, transmission, drivetrain) {
      trimInp.value = String(trim || '').slice(0, 60);
      pendingEngine = String(engine || '').slice(0, 60);
      engineOther.value = pendingEngine;
      engineSel.style.display = 'none';
      engineOther.style.display = '';
      transSel.value = (transmission === 'Manual' || transmission === 'Automatic') ? transmission : '';
      if (!transSel.value) transSel.selectedIndex = 0;
      driveSel.value = (drivetrain === 'AWD' || drivetrain === 'FWD' || drivetrain === 'RWD') ? drivetrain : '';
      if (!driveSel.value) driveSel.selectedIndex = 0;
    }

    function fire() { if (typeof opts.onChange === 'function') { try { opts.onChange(api.get()); } catch (e) {} } }

    function isSmallEngine() { return curType === 'smallengine'; }
    function yearLabel() { return document.querySelector('label[for="' + yearSel.id + '"]'); }

    // Small-engine mode: no year; brand dropdown + free-text equipment model.
    function configureForType() {
      const se = isSmallEngine();
      yearSel.style.display = se ? 'none' : '';
      extrasBox.style.display = se ? 'none' : 'flex';
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
      syncOther(); reloadEngines(); fire();
      if (!y || !m || m === OTHER) { syncOther(); return; }
      const models = await getModels(y, m, curType);
      if (yearSel.value !== y || makeSel.value !== m) return;
      fillSelect(modelSel, models, 'Select model');
      modelSel.disabled = false;
      syncOther();
    });
    modelSel.addEventListener('change', () => { syncOther(); reloadEngines(); fire(); });
    makeOther.addEventListener('input', fire);
    modelOther.addEventListener('input', fire);
    trimInp.addEventListener('input', fire);
    engineSel.addEventListener('change', () => {
      const other = engineSel.value === OTHER;
      engineOther.style.display = other ? '' : 'none';
      if (!other) engineOther.value = '';
      fire();
    });
    engineOther.addEventListener('input', fire);
    transSel.addEventListener('change', fire);
    driveSel.addEventListener('change', fire);

    const api = {
      get type() { return curType; },
      setExtras(trim, engine, transmission, drivetrain) { setExtras(trim, engine, transmission, drivetrain); fire(); },
      setType(t) {
        if (!allowed.some(x => x.id === t) || t === curType) return;
        curType = t;
        paintType();
        if (isSmallEngine()) { configureForType(); return; }
        // leaving small-engine mode: restore the normal cascade
        yearSel.style.display = '';
        extrasBox.style.display = 'flex';
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
          return { year: '', make: b, model: mo, type: curType, trim: '', engine: '', transmission: '', drivetrain: '' };
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
        return { year: y, make: m, model: mo, type: curType, ...getExtras() };
      },
      vehicleString() {
        const v = this.get();
        if (!v) return '';
        return v.type === 'smallengine' ? (v.make + ' ' + v.model) : (v.year + ' ' + v.make + ' ' + v.model);
      },
      vehicleDisplay() {
        const v = this.get();
        if (!v) return '';
        return displayVehicle(this.vehicleString(), v.trim, v.engine, v.transmission, v.drivetrain);
      },
      async set(y, m, mo, trim, engine, transmission, drivetrain) {
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
        setExtras(trim, engine, transmission, drivetrain);
        const years = await getYears();
        if (y && years.map(String).includes(y)) {
          yearSel.value = y;
          // Fill the dependent selects directly instead of dispatching
          // change events: the change listeners refill asynchronously,
          // and a refill landing after the assignments below wipes the
          // chosen make/model back to the placeholder.
          const makes = await getMakes(y, curType);
          fillSelect(makeSel, makes, 'Select make');
          makeSel.disabled = false;
          if (makes.includes(m)) {
            makeSel.value = m;
            const models = await getModels(y, m, curType);
            fillSelect(modelSel, models, 'Select model');
            modelSel.disabled = false;
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
          // load the engine combinations for the chosen model and
          // apply the pending engine (setExtras stored it earlier)
          await reloadEngines();
          syncOther(); fire();
        } else if (y || m || mo) {
          // year unknown: drop everything into free text under Other
          const years2 = await getYears();
          if (years2.length) { yearSel.value = String(years2[0]); }
          makeSel.value = OTHER; syncOther();
          makeOther.value = [y, m].filter(Boolean).join(' ');
          modelOther.value = mo;
          syncOther(); fire();
        }
      },
      async setFromString(str) {
        str = String(str || '').trim();
        setExtras('', '', '', '');
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
        pendingEngine = '';
        engineSel.innerHTML = '';
        engineSel.style.display = 'none';
        engineOther.value = '';
        engineOther.style.display = '';
        setExtras('', '', '', '');
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

  // Compose a stored vehicle's display string: base vehicle plus any
  // optional trim, engine, and transmission, e.g.
  // "2020 Ford Explorer XL 3.5L Manual". The base string never carries
  // the extras, so matching and photo lookup still key on year/make/model.
  function displayVehicle(vehicle, trim, engine, transmission, drivetrain) {
    const parts = [String(vehicle || '').trim()];
    if (trim) parts.push(String(trim).trim());
    if (engine) parts.push(String(engine).trim());
    if (transmission) parts.push(String(transmission).trim());
    if (drivetrain) parts.push(String(drivetrain).trim());
    return parts.filter(Boolean).join(' ');
  }

  window.VehiclePicker = { attach, TYPES, display: displayVehicle, _cache: cache };
})();
