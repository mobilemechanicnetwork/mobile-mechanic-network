/* VehiclePicker: three cascading dropdowns (Year -> Make -> Model) backed by
   /api/vehicles/years, /api/vehicles/makes?year=, /api/vehicles/models?year=&make=.
   Page provides three <select> elements; this script wires them up.

   const picker = VehiclePicker.attach({ year: 'f-year', make: 'f-make', model: 'f-model', onChange: fn });
   picker.get()            -> { year, make, model } or null when incomplete
   picker.vehicleString()  -> "2020 Honda Accord" or ""
   picker.set(year, make, model)      -> async; selects values (for saved vehicles)
   picker.setFromString("2020 Honda Accord") -> async; best-effort parse
   picker.reset()          -> clears all three
*/
(function () {
  const OTHER = '__other';
  const cache = { years: null, makes: {}, models: {} };

  async function getYears() {
    if (!cache.years) {
      const d = await (await fetch('/api/vehicles/years')).json().catch(() => ({}));
      cache.years = Array.isArray(d.years) ? d.years.slice().sort((a, b) => b - a) : [];
    }
    return cache.years;
  }
  async function getMakes(year) {
    if (!cache.makes[year]) {
      const d = await (await fetch('/api/vehicles/makes?year=' + encodeURIComponent(year))).json().catch(() => ({}));
      cache.makes[year] = Array.isArray(d.makes) ? d.makes : [];
    }
    return cache.makes[year];
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

  function attach(opts) {
    const yearSel = document.getElementById(opts.year);
    const makeSel = document.getElementById(opts.make);
    const modelSel = document.getElementById(opts.model);
    if (!yearSel || !makeSel || !modelSel) return null;

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

    function syncOther() {
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

    yearSel.addEventListener('change', async () => {
      const y = yearSel.value;
      fillSelect(makeSel, [], 'Select make');
      fillSelect(modelSel, [], 'Select model');
      makeSel.disabled = !y; modelSel.disabled = true;
      syncOther(); fire();
      if (!y) return;
      const makes = await getMakes(y);
      // keep the chosen year if the user moved on meanwhile
      if (yearSel.value !== y) return;
      fillSelect(makeSel, makes, 'Select make');
      makeSel.disabled = false;
      syncOther();
    });
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
      get() {
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
        return { year: y, make: m, model: mo };
      },
      vehicleString() {
        const v = this.get();
        return v ? (v.year + ' ' + v.make + ' ' + v.model) : '';
      },
      async set(y, m, mo) {
        this.reset();
        y = String(y || ''); m = String(m || ''); mo = String(mo || '');
        const years = await getYears();
        if (y && years.map(String).includes(y)) {
          yearSel.value = y;
          yearSel.dispatchEvent(new Event('change'));
          const makes = await getMakes(y);
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
        const ym = str.match(/^(\d{4})\s+(.+)$/);
        if (!ym) {
          // no leading year: stash the whole thing as free text
          const years = await getYears();
          if (!years.length) return;
          yearSel.value = String(years[0]);
          yearSel.dispatchEvent(new Event('change'));
          await getMakes(yearSel.value);
          makeSel.value = OTHER; syncOther();
          makeOther.value = ''; modelOther.value = str;
          syncOther(); fire();
          return;
        }
        const y = ym[1], rest = ym[2];
        const years = await getYears();
        if (!years.map(String).includes(y)) { await this.set(y, '', rest); return; }
        const makes = await getMakes(y);
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

  window.VehiclePicker = { attach, _cache: cache };
})();
