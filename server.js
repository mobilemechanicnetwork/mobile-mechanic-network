// Mobile Mechanic Network — website server
// Stage 1: public site + accounts. Stage 2: mechanic business profiles + directory.
// Stage 3: quote requests matched by area + service, mechanic quotes, accept/decline.
// Dependency-free Node.js. Portable: runs on any host that runs Node.
// Storage is JSON files for the pre-deploy stage; swap for Postgres at deploy.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const SERVICES = ['Diagnostics', 'Brakes', 'Battery & starting', 'Oil & maintenance', 'Engine repair', 'Pre-purchase inspection', 'Other'];

// VIN: 17 chars, letters I/O/Q never used. Returns the cleaned VIN or null.
function cleanVin(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(s) ? s : null;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
function store(name) {
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]');
  return {
    read() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } },
    write(rows) { fs.writeFileSync(file, JSON.stringify(rows, null, 2)); },
  };
}
const usersStore = store('users.json');
const businessesStore = store('businesses.json');
const requestsStore = store('requests.json');
const quotesStore = store('quotes.json');
const promotionsStore = store('promotions.json');
const ticketsStore = store('tickets.json');
const vehiclesStore = store('vehicles.json');

const sessions = new Map(); // token -> userId (in-memory at this stage)
const visitsStore = store('visits.json');
const searchesStore = store('searches.json');
function clientIpHash(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
  return crypto.createHash('sha256').update('mmn-visit-salt:' + ip).digest('hex').slice(0, 16);
}
function logVisit(req, p) {
  try {
    const visits = visitsStore.read();
    visits.push({ t: new Date().toISOString(), path: p, ip: clientIpHash(req) });
    if (visits.length > 20000) visits.splice(0, visits.length - 20000);
    visitsStore.write(visits);
  } catch (e) {}
}
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // founder admin passphrase, set as env var on the host
const adminSessions = new Set(); // admin token strings (in-memory; re-login after each deploy)

function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function makeUser({ name, email, password, role }) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: crypto.randomUUID(), name, email: email.toLowerCase(), role, isAdmin: false, salt, passwordHash: hashPassword(password, salt), createdAt: new Date().toISOString() };
}
function verifyPassword(user, password) {
  return crypto.timingSafeEqual(Buffer.from(hashPassword(password, user.salt), 'hex'), Buffer.from(user.passwordHash, 'hex'));
}
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, role: u.role, isAdmin: !!u.isAdmin, phone: u.phone || '', createdAt: u.createdAt }; }

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function sendJson(res, status, obj) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function getSessionUser(req) {
  const match = (req.headers.cookie || '').match(/mmn_session=([a-f0-9]+)/);
  if (!match) return null;
  const userId = sessions.get(match[1]);
  return userId ? usersStore.read().find(u => u.id === userId) || null : null;
}
function startSession(res, status, user, payload) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, user.id);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Set-Cookie': `mmn_session=${token}; HttpOnly; SameSite=Lax; Path=/` });
  res.end(JSON.stringify(payload));
}
function myBusiness(userId) { return businessesStore.read().find(b => b.userId === userId) || null; }
function servedCities(biz) {
  const list = [biz.city, ...(Array.isArray(biz.serviceCities) ? biz.serviceCities : [])];
  return list.map(c => String(c).trim().toLowerCase()).filter(Boolean);
}
function requestMatchesBusiness(reqRow, biz) {
  if (!biz || !biz.published) return false;
  const owner = usersStore.read().find(u => u.id === biz.userId);
  if (mechanicFrozen(owner)) return false;
  return biz.state.toLowerCase() === reqRow.state.toLowerCase()
    && biz.services.includes(reqRow.service)
    && servedCities(biz).includes(reqRow.city.toLowerCase());
}
function publicBusiness(b) {
  const owner = usersStore.read().find(u => u.id === b.userId);
  return { id: b.id, name: b.name, city: b.city, state: b.state, serviceCities: b.serviceCities || [], services: b.services, about: b.about, phone: b.phone || '', logoUrl: b.logoUrl || '', coverUrl: b.coverUrl || '', gallery: b.gallery || [], socials: b.socials || {}, mechanicName: owner ? owner.name : '' };
}
function latestPromotion(businessId) {
  const all = promotionsStore.read().filter(x => x.businessId === businessId);
  all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const p = all[0];
  return p ? { title: p.title, description: p.description, validUntil: p.validUntil } : null;
}
// A mechanic is frozen when the 90-day trial is over and no active subscription exists.
// Frozen mechanics are hidden from search, get no requests, and cannot write —
// but they can always sign in and reach the Billing tab to add payment.
function mechanicFrozen(user) {
  if (!user || user.role !== 'mechanic') return false;
  if (user.billingStatus === 'active') return false;
  if (!user.trialEndsAt) return false;
  return Date.now() > new Date(user.trialEndsAt).getTime();
}
function frozenError(res) {
  return sendJson(res, 402, { error: 'Your 90-day free trial has ended. Add a payment method on the Billing tab to reactivate your account.', frozen: true });
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serveFile(res, file) { res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file)); }

// Minimal multipart/form-data parser (single file uploads only)
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const ctype = req.headers['content-type'] || '';
    const m = ctype.match(/boundary=(.+)$/);
    if (!m) return reject(new Error('not multipart'));
    const b = Buffer.from('--' + m[1].trim());
    const chunks = [];
    let size = 0;
    req.on('data', c => { chunks.push(c); size += c.length; if (size > 6 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const parts = [];
        let pos = 0, idx;
        while ((idx = buf.indexOf(b, pos)) !== -1) {
          const seg = buf.slice(pos, idx);
          pos = idx + b.length;
          if (seg.length < 10) continue;
          const headerEnd = seg.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;
          const headers = seg.slice(0, headerEnd).toString('latin1');
          let body = seg.slice(headerEnd + 4);
          if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) body = body.slice(0, -2);
          const nameM = headers.match(/name="([^"]+)"/);
          const fileM = headers.match(/filename="([^"]*)"/);
          const typeM = headers.match(/Content-Type:\s*([^\r\n;]+)/i);
          parts.push({ name: nameM && nameM[1], filename: fileM && fileM[1], contentType: typeM && typeM[1].trim().toLowerCase(), data: body });
        }
        resolve(parts);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (req.method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/uploads/')) logVisit(req, p);
  try {
    // ---------- Accounts ----------
    if (p === '/api/register' && req.method === 'POST') {
      const { name, email, password, role } = await parseBody(req);
      if (!name || !email || !password || !['owner', 'mechanic'].includes(role))
        return sendJson(res, 400, { error: 'Name, email, password, and account type are required.' });
      if (String(password).length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
      const users = usersStore.read();
      if (users.some(u => u.email === String(email).toLowerCase())) return sendJson(res, 409, { error: 'An account with this email already exists.' });
      const user = makeUser({ name: String(name).trim(), email: String(email).trim(), password: String(password), role });
      if (role === 'mechanic') {
        user.trialEndsAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
        user.billingStatus = 'trialing';
      }
      users.push(user); usersStore.write(users);
      return startSession(res, 201, user, { user: publicUser(user) });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const { email, password } = await parseBody(req);
      const user = usersStore.read().find(u => u.email === String(email || '').toLowerCase());
      if (!user || !verifyPassword(user, String(password || ''))) return sendJson(res, 401, { error: 'Email or password is incorrect.' });
      return startSession(res, 200, user, { user: publicUser(user) });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const match = (req.headers.cookie || '').match(/mmn_session=([a-f0-9]+)/);
      if (match) sessions.delete(match[1]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'mmn_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
      return res.end('{}');
    }
    if (p === '/api/me' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const me = publicUser(user);
      if (user.role === 'mechanic') {
        me.frozen = mechanicFrozen(user);
        me.daysLeft = user.trialEndsAt ? Math.max(0, Math.ceil((new Date(user.trialEndsAt) - Date.now()) / 86400000)) : 0;
        me.trialEndsAt = user.trialEndsAt || null;
        me.billingStatus = user.billingStatus || 'trialing';
      }
      return sendJson(res, 200, { user: me });
    }
    if (p === '/api/profile' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const { name, phone } = await parseBody(req);
      const users = usersStore.read();
      const row = users.find(u => u.id === user.id);
      if (!row) return sendJson(res, 404, { error: 'Not found.' });
      if (name && String(name).trim()) row.name = String(name).trim().slice(0, 120);
      row.phone = String(phone || '').trim().slice(0, 40);
      usersStore.write(users);
      return sendJson(res, 200, { user: publicUser(row) });
    }

    // ---------- Owner vehicles ----------
    if (p === '/api/vehicles/me' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'owner') return sendJson(res, 403, { error: 'Vehicle owners only.' });
      return sendJson(res, 200, { vehicles: vehiclesStore.read().filter(v => v.ownerId === user.id) });
    }
    if (p === '/api/vehicles' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'owner') return sendJson(res, 403, { error: 'Vehicle owners only.' });
      const { year, make, model } = await parseBody(req);
      if (!year || !make || !model) return sendJson(res, 400, { error: 'Year, make, and model are required.' });
      const vehicles = vehiclesStore.read();
      const v = { id: crypto.randomUUID(), ownerId: user.id, year: String(year).trim().slice(0, 10), make: String(make).trim().slice(0, 60), model: String(model).trim().slice(0, 60), createdAt: new Date().toISOString() };
      vehicles.push(v); vehiclesStore.write(vehicles);
      return sendJson(res, 201, { vehicle: v });
    }
    const vehicleDel = p.match(/^\/api\/vehicles\/([0-9a-f-]+)$/);
    if (vehicleDel && req.method === 'DELETE') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const vehicles = vehiclesStore.read();
      const ix = vehicles.findIndex(v => v.id === vehicleDel[1] && v.ownerId === user.id);
      if (ix === -1) return sendJson(res, 404, { error: 'Not found.' });
      vehicles.splice(ix, 1); vehiclesStore.write(vehicles);
      return sendJson(res, 200, {});
    }

    // ---------- Mechanic business profiles + directory ----------
    if (p === '/api/business' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Only mobile mechanic accounts have a business page.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const { name, city, state, serviceCities, services, about, published, phone, logoUrl, coverUrl, socials } = await parseBody(req);
      if (!name || !city || !state || !Array.isArray(services) || services.length === 0)
        return sendJson(res, 400, { error: 'Business name, city, state, and at least one service are required.' });
      const cleanServices = services.filter(s => SERVICES.includes(s));
      if (cleanServices.length === 0) return sendJson(res, 400, { error: 'Pick at least one valid service.' });
      const businesses = businessesStore.read();
      let biz = businesses.find(b => b.userId === user.id);
      const rawCities = Array.isArray(serviceCities) ? serviceCities.join(',') : String(serviceCities || '');
      const cleanCities = [...new Set(rawCities.split(/[,\n]/).map(s => s.trim()).filter(Boolean))];
      const cleanSocials = {};
      if (socials && typeof socials === 'object') for (const k of ['facebook', 'instagram', 'tiktok', 'youtube', 'x', 'website']) {
        const v = String(socials[k] || '').trim().slice(0, 300);
        if (v) cleanSocials[k] = v;
      }
      const fields = { name: String(name).trim(), city: String(city).trim(), state: String(state).trim().toUpperCase(), serviceCities: cleanCities, services: cleanServices, about: String(about || ''), phone: String(phone || '').trim(), published: !!published, socials: cleanSocials };
      if (typeof logoUrl === 'string' && logoUrl.startsWith('/uploads/')) fields.logoUrl = logoUrl;
      if (typeof coverUrl === 'string' && coverUrl.startsWith('/uploads/')) fields.coverUrl = coverUrl;
      if (biz) Object.assign(biz, fields); else { biz = { id: crypto.randomUUID(), userId: user.id, createdAt: new Date().toISOString(), ...fields }; businesses.push(biz); }
      businessesStore.write(businesses);
      return sendJson(res, 200, { business: publicBusiness(biz) });
    }
    if (p === '/api/business/me' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const biz = myBusiness(user.id);
      return sendJson(res, 200, { business: biz ? publicBusiness(biz) : null });
    }
    if (p === '/api/mechanics' && req.method === 'GET') {
      const city = (url.searchParams.get('city') || '').toLowerCase();
      const state = (url.searchParams.get('state') || '').toLowerCase();
      const service = url.searchParams.get('service') || '';
      if (city || state) {
        try {
          const searches = searchesStore.read();
          searches.push({ t: new Date().toISOString(), city, state, service, ip: clientIpHash(req) });
          if (searches.length > 20000) searches.splice(0, searches.length - 20000);
          searchesStore.write(searches);
        } catch (e) {}
      }
      const frozenIds = new Set(usersStore.read().filter(mechanicFrozen).map(u => u.id));
      let list = businessesStore.read().filter(b => b.published && !frozenIds.has(b.userId));
      if (state) list = list.filter(b => b.state.toLowerCase() === state);
      if (city) list = list.filter(b => b.city.toLowerCase() === city);
      if (service) list = list.filter(b => b.services.includes(service));
      return sendJson(res, 200, { mechanics: list.map(b => ({ ...publicBusiness(b), promotion: latestPromotion(b.id) })) });
    }
    if (p === '/api/services' && req.method === 'GET') return sendJson(res, 200, { services: SERVICES });

    // ---------- Quote requests ----------
    if (p === '/api/requests' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'owner') return sendJson(res, 403, { error: 'Only vehicle owner accounts can request quotes.' });
      const { city, state, service, vehicle, description, phone, date, vin } = await parseBody(req);
      if (!city || !state || !SERVICES.includes(service) || !vehicle || !description || !phone)
        return sendJson(res, 400, { error: 'City, state, service, vehicle, a description, and a phone number are required.' });
      let cleanVinValue = '';
      if (vin && String(vin).trim()) {
        cleanVinValue = cleanVin(vin);
        if (!cleanVinValue) return sendJson(res, 400, { error: 'VIN must be 17 characters (letters and numbers, no I, O, or Q).' });
      }
      const rows = requestsStore.read();
      const row = { id: crypto.randomUUID(), ownerId: user.id, ownerName: user.name, phone: String(phone).trim(), city: String(city).trim(), state: String(state).trim().toUpperCase(), service, vehicle: String(vehicle).trim(), vin: cleanVinValue, description: String(description).trim(), date: String(date || '').slice(0, 20), status: 'open', createdAt: new Date().toISOString() };
      rows.push(row); requestsStore.write(rows);
      const matches = businessesStore.read().filter(b => requestMatchesBusiness(row, b)).length;
      return sendJson(res, 201, { request: row, mechanicsNotified: matches });
    }
    if (p === '/api/requests/mine' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const quotes = quotesStore.read();
      const mine = requestsStore.read().filter(r => r.ownerId === user.id).map(r => ({
        ...r,
        quotes: quotes.filter(q => q.requestId === r.id).map(q => {
          const biz = businessesStore.read().find(b => b.id === q.businessId);
          return { ...q, businessName: biz ? biz.name : 'Mobile mechanic', businessCity: biz ? `${biz.city}, ${biz.state}` : '', businessLogo: biz && biz.logoUrl ? biz.logoUrl : '', businessPhone: biz ? (biz.phone || '') : '' };
        }),
      }));
      return sendJson(res, 200, { requests: mine });
    }
    if (p === '/api/requests/inbox' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const biz = myBusiness(user.id);
      if (!biz || !biz.published) return sendJson(res, 200, { requests: [], booked: [], needsBusiness: true });
      const quotes = quotesStore.read();
      const inbox = requestsStore.read()
        .filter(r => r.status === 'open' && requestMatchesBusiness(r, biz))
        .map(r => ({ ...r, myQuote: quotes.find(q => q.requestId === r.id && q.businessId === biz.id) || null }));
      const booked = requestsStore.read()
        .filter(r => r.status === 'accepted')
        .map(r => {
          const q = quotes.find(q => q.requestId === r.id && q.businessId === biz.id && q.status === 'accepted');
          return q ? { id: r.id, service: r.service, vehicle: r.vehicle, vin: r.vin || '', description: r.description, city: r.city, state: r.state, ownerName: r.ownerName, phone: r.phone, date: r.date || '', createdAt: r.createdAt, acceptedTotal: q.total != null ? q.total : q.price } : null;
        })
        .filter(Boolean);
      return sendJson(res, 200, { requests: inbox, booked });
    }

    // ---------- Quotes ----------
    if (p === '/api/quotes' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const biz = myBusiness(user.id);
      const { requestId, price, message, items, notes } = await parseBody(req);
      const row = requestsStore.read().find(r => r.id === requestId);
      if (!row || row.status !== 'open' || !requestMatchesBusiness(row, biz))
        return sendJson(res, 400, { error: 'That request is not open in your service area.' });
      let cleanItems = [];
      if (Array.isArray(items)) for (const it of items.slice(0, 50)) {
        const desc = String((it && it.desc) || '').trim().slice(0, 200);
        const amount = Math.round(Number(it && it.amount) * 100) / 100;
        if (desc && amount > 0) cleanItems.push({ desc, amount });
      }
      let total;
      if (cleanItems.length) total = Math.round(cleanItems.reduce((s, i) => s + i.amount, 0) * 100) / 100;
      else {
        const amount = Number(price);
        if (!amount || amount <= 0) return sendJson(res, 400, { error: 'Add at least one line item to your quote.' });
        total = amount;
      }
      const quotes = quotesStore.read();
      if (quotes.some(q => q.requestId === requestId && q.businessId === biz.id && q.status === 'pending'))
        return sendJson(res, 409, { error: 'You already quoted this request.' });
      const quote = { id: crypto.randomUUID(), requestId, businessId: biz.id, mechanicId: user.id, items: cleanItems, notes: String(notes || '').slice(0, 1000), total, price: total, message: String(message || ''), status: 'pending', createdAt: new Date().toISOString() };
      quotes.push(quote); quotesStore.write(quotes);
      return sendJson(res, 201, { quote });
    }
    const quoteAction = p.match(/^\/api\/quotes\/([0-9a-f-]+)\/(accept|decline)$/);
    if (quoteAction && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const quotes = quotesStore.read();
      const quote = quotes.find(q => q.id === quoteAction[1]);
      if (!quote) return sendJson(res, 404, { error: 'Quote not found.' });
      const rows = requestsStore.read();
      const row = rows.find(r => r.id === quote.requestId);
      if (!row || row.ownerId !== user.id) return sendJson(res, 403, { error: 'That is not your request.' });
      if (row.status !== 'open' || quote.status !== 'pending') return sendJson(res, 400, { error: 'That quote can no longer be changed.' });
      if (quoteAction[2] === 'accept') {
        quote.status = 'accepted'; row.status = 'accepted';
        quotes.forEach(q => { if (q.requestId === row.id && q.id !== quote.id && q.status === 'pending') q.status = 'declined'; });
      } else quote.status = 'declined';
      quotesStore.write(quotes); requestsStore.write(rows);
      return sendJson(res, 200, { quote, requestStatus: row.status });
    }

    // ---------- Logo / cover photo uploads (mechanics only) ----------
    if (p === '/api/upload' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const biz = myBusiness(user.id);
      if (!biz) return sendJson(res, 400, { error: 'Save your business page first.' });
      let parts;
      try { parts = await parseMultipart(req); } catch (e) { return sendJson(res, 400, { error: 'Upload failed.' }); }
      const kindPart = parts.find(x => x.name === 'kind' && !x.filename);
      const filePart = parts.find(x => x.filename);
      const kind = kindPart ? kindPart.data.toString().trim() : '';
      if (!['logo', 'cover', 'gallery'].includes(kind) || !filePart) return sendJson(res, 400, { error: 'Choose a logo, cover photo, or gallery photo to upload.' });
      const allowed = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
      const ext = allowed[filePart.contentType];
      if (!ext) return sendJson(res, 400, { error: 'Only JPG, PNG, WebP or GIF images.' });
      if (filePart.data.length > 5 * 1024 * 1024) return sendJson(res, 400, { error: 'Image must be under 5 MB.' });
      const dir = path.join(DATA_DIR, 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      let fname;
      if (kind === 'gallery') {
        fname = biz.id + '-gallery-' + crypto.randomBytes(8).toString('hex') + '.' + ext;
      } else {
        for (const f of fs.readdirSync(dir)) if (f.startsWith(biz.id + '-' + kind + '.')) fs.unlinkSync(path.join(dir, f));
        fname = biz.id + '-' + kind + '.' + ext;
      }
      fs.writeFileSync(path.join(dir, fname), filePart.data);
      const url = '/uploads/' + fname;
      const businesses = businessesStore.read();
      const row = businesses.find(b => b.id === biz.id);
      if (row) {
        if (kind === 'gallery') row.gallery = [...(row.gallery || []), url];
        else row[kind === 'logo' ? 'logoUrl' : 'coverUrl'] = url;
        businessesStore.write(businesses);
      }
      return sendJson(res, 200, { url });
    }
    if (p === '/api/gallery/remove' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const { url } = await parseBody(req);
      const businesses = businessesStore.read();
      const biz = businesses.find(b => b.userId === user.id);
      if (!biz || !Array.isArray(biz.gallery) || !biz.gallery.includes(url)) return sendJson(res, 404, { error: 'Not found.' });
      biz.gallery = biz.gallery.filter(u => u !== url);
      businessesStore.write(businesses);
      const fname = path.basename(String(url || ''));
      if (/^[0-9a-f-]+-gallery-[0-9a-f]+\.(jpg|png|webp|gif)$/.test(fname)) {
        const f = path.join(DATA_DIR, 'uploads', fname);
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
      return sendJson(res, 200, {});
    }
    if (p.startsWith('/uploads/') && req.method === 'GET') {
      const fname = path.basename(p);
      if (!/^[0-9a-f-]+\-(logo|cover|gallery\-[0-9a-f]+)\.(jpg|png|webp|gif)$/.test(fname)) { res.writeHead(404); return res.end('Not found'); }
      const file = path.join(DATA_DIR, 'uploads', fname);
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
      return serveFile(res, file);
    }

    // ---------- Promotions ----------
    if (p === '/api/promotions' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const biz = myBusiness(user.id);
      if (!biz) return sendJson(res, 400, { error: 'Save your business page first.' });
      const { title, description, validUntil } = await parseBody(req);
      if (!title || !description) return sendJson(res, 400, { error: 'Title and description are required.' });
      const promos = promotionsStore.read();
      const promo = { id: crypto.randomUUID(), businessId: biz.id, mechanicId: user.id, title: String(title).trim().slice(0, 120), description: String(description).trim().slice(0, 500), validUntil: String(validUntil || '').trim().slice(0, 60), createdAt: new Date().toISOString() };
      promos.push(promo); promotionsStore.write(promos);
      return sendJson(res, 201, { promotion: promo });
    }
    if (p === '/api/promotions/me' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const biz = myBusiness(user.id);
      const promos = promotionsStore.read().filter(x => x.mechanicId === user.id && (!biz || x.businessId === biz.id));
      return sendJson(res, 200, { promotions: promos });
    }
    const promoDel = p.match(/^\/api\/promotions\/([0-9a-f-]+)$/);
    if (promoDel && req.method === 'DELETE') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const promos = promotionsStore.read();
      const ix = promos.findIndex(x => x.id === promoDel[1] && x.mechanicId === user.id);
      if (ix === -1) return sendJson(res, 404, { error: 'Not found.' });
      promos.splice(ix, 1); promotionsStore.write(promos);
      return sendJson(res, 200, {});
    }

    // ---------- Tickets (estimates / invoices / receipts) ----------
    if (p === '/api/tickets' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const biz = myBusiness(user.id);
      if (!biz) return sendJson(res, 400, { error: 'Save your business page first.' });
      const { type, customerName, vehicle, items, notes, laborDesc, laborAmount, taxRate, warranty, vin } = await parseBody(req);
      if (!['estimate', 'invoice', 'receipt'].includes(type)) return sendJson(res, 400, { error: 'Pick estimate, invoice, or receipt.' });
      if (!customerName || !Array.isArray(items) || !items.length) return sendJson(res, 400, { error: 'Customer name and at least one line item are required.' });
      let ticketVin = '';
      if (vin && String(vin).trim()) {
        ticketVin = cleanVin(vin);
        if (!ticketVin) return sendJson(res, 400, { error: 'VIN must be 17 characters (letters and numbers, no I, O, or Q).' });
      }
      if ((type === 'invoice' || type === 'receipt') && !ticketVin)
        return sendJson(res, 400, { error: 'A VIN is required on invoices and receipts.' });
      const cleanItems = items.slice(0, 50)
        .map(it => ({ desc: String(it.desc || '').trim().slice(0, 200), qty: Math.max(0, Number(it.qty) || 0), price: Math.max(0, Number(it.price) || 0) }))
        .filter(it => it.desc && it.qty > 0 && it.price >= 0);
      if (!cleanItems.length) return sendJson(res, 400, { error: 'Add at least one line item with a quantity and price.' });
      const r2 = n => Math.round(n * 100) / 100;
      const partsSubtotal = r2(cleanItems.reduce((s, it) => s + it.qty * it.price, 0));
      const labor = { desc: String(laborDesc || '').trim().slice(0, 200), amount: r2(Math.max(0, Number(laborAmount) || 0)) };
      const rate = Math.max(0, Math.min(100, Number(taxRate) || 0));
      const taxable = r2(partsSubtotal + labor.amount);
      const taxAmount = r2(taxable * rate / 100);
      const total = r2(partsSubtotal + labor.amount + taxAmount);
      const tickets = ticketsStore.read();
      const ticket = { id: crypto.randomUUID(), businessId: biz.id, mechanicId: user.id, type, customerName: String(customerName).trim().slice(0, 120), vehicle: String(vehicle || '').trim().slice(0, 120), vin: ticketVin, items: cleanItems, laborDesc: labor.desc, laborAmount: labor.amount, taxRate: rate, subtotal: partsSubtotal, taxAmount, notes: String(notes || '').trim().slice(0, 1000), warranty: String(warranty || '').trim().slice(0, 2000), total, createdAt: new Date().toISOString() };
      tickets.push(ticket); ticketsStore.write(tickets);
      return sendJson(res, 201, { ticket });
    }
    if (p === '/api/tickets/me' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const tickets = ticketsStore.read().filter(t => t.mechanicId === user.id);
      return sendJson(res, 200, { tickets });
    }
    const ticketConvert = p.match(/^\/api\/tickets\/([0-9a-f-]+)\/convert$/);
    if (ticketConvert && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const tickets = ticketsStore.read();
      const t = tickets.find(x => x.id === ticketConvert[1] && x.mechanicId === user.id);
      if (!t) return sendJson(res, 404, { error: 'Not found.' });
      if (t.type !== 'estimate') return sendJson(res, 400, { error: 'Only estimates can be converted to invoices.' });
      const { vin } = await parseBody(req);
      let v = t.vin || '';
      if (!v && vin && String(vin).trim()) {
        v = cleanVin(vin);
        if (!v) return sendJson(res, 400, { error: 'VIN must be 17 characters (letters and numbers, no I, O, or Q).' });
      }
      if (!v) return sendJson(res, 400, { error: 'A VIN is required on invoices.' });
      t.vin = v; t.type = 'invoice';
      ticketsStore.write(tickets);
      return sendJson(res, 200, { ticket: t });
    }
    const ticketPaid = p.match(/^\/api\/tickets\/([0-9a-f-]+)\/paid$/);
    if (ticketPaid && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const tickets = ticketsStore.read();
      const t = tickets.find(x => x.id === ticketPaid[1] && x.mechanicId === user.id);
      if (!t) return sendJson(res, 404, { error: 'Not found.' });
      if (t.type !== 'invoice') return sendJson(res, 400, { error: 'Only invoices can be marked as paid.' });
      t.type = 'receipt'; t.paidAt = new Date().toISOString();
      ticketsStore.write(tickets);
      return sendJson(res, 200, { ticket: t });
    }
    const ticketDel = p.match(/^\/api\/tickets\/([0-9a-f-]+)$/);
    if (ticketDel && req.method === 'DELETE') {      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const tickets = ticketsStore.read();
      const ix = tickets.findIndex(x => x.id === ticketDel[1] && x.mechanicId === user.id);
      if (ix === -1) return sendJson(res, 404, { error: 'Not found.' });
      tickets.splice(ix, 1); ticketsStore.write(tickets);
      return sendJson(res, 200, {});
    }
    if (p === '/api/ticket' && req.method === 'GET') {
      const user = getSessionUser(req);
      const t = ticketsStore.read().find(x => x.id === url.searchParams.get('id'));
      if (!t || !user || t.mechanicId !== user.id) return sendJson(res, 404, { error: 'Not found.' });
      const biz = businessesStore.read().find(b => b.id === t.businessId);
      return sendJson(res, 200, { ticket: t, business: biz ? publicBusiness(biz) : null });
    }

    // ---------- Billing (90-day free trial, then Stripe subscription) ----------
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
    const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
    const STRIPE_PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY || '';
    const STRIPE_PRICE_YEARLY = process.env.STRIPE_PRICE_YEARLY || '';
    const stripeConfigured = !!(STRIPE_SECRET_KEY && STRIPE_PRICE_MONTHLY && STRIPE_PRICE_YEARLY);
    function stripeRequest(path, params) {
      return new Promise((resolve, reject) => {
        const body = new URLSearchParams(params).toString();
        const req = https.request({
          hostname: 'api.stripe.com', path, method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from(STRIPE_SECRET_KEY + ':').toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
        }, (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(data) }); } catch (e) { reject(new Error('Stripe response error.')); } });
        });
        req.on('error', reject);
        req.end(body);
      });
    }
    if (p === '/api/billing' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const daysLeft = user.trialEndsAt ? Math.max(0, Math.ceil((new Date(user.trialEndsAt) - Date.now()) / 86400000)) : 0;
      return sendJson(res, 200, {
        configured: stripeConfigured,
        status: user.billingStatus || 'trialing',
        trialEndsAt: user.trialEndsAt || null,
        daysLeft,
        plans: [
          { id: 'monthly', label: '$24.99 / month' },
          { id: 'yearly', label: '$200 / year' },
        ],
      });
    }
    if (p === '/api/billing/checkout' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (!stripeConfigured) return sendJson(res, 400, { error: 'Online payments are not set up yet.' });
      const { plan } = await parseBody(req);
      const price = plan === 'yearly' ? STRIPE_PRICE_YEARLY : STRIPE_PRICE_MONTHLY;
      const base = 'https://' + req.headers.host;
      const trialEnd = user.trialEndsAt ? Math.floor(new Date(user.trialEndsAt).getTime() / 1000) : undefined;
      try {
        const params = {
          'payment_method_types[]': 'card',
          mode: 'subscription',
          'line_items[0][price]': price,
          'line_items[0][quantity]': '1',
          success_url: base + '/mechanic?billing=success',
          cancel_url: base + '/mechanic?billing=cancelled',
          customer_email: user.email,
          'metadata[userId]': user.id,
        };
        if (trialEnd && trialEnd > Math.floor(Date.now() / 1000)) params['subscription_data[trial_end]'] = String(trialEnd);
        const r = await stripeRequest('/v1/checkout/sessions', params);
        if (r.status !== 200 || !r.json.url) return sendJson(res, 400, { error: (r.json.error && r.json.error.message) || 'Could not start checkout.' });
        return sendJson(res, 200, { url: r.json.url });
      } catch (e) { return sendJson(res, 500, { error: 'Could not start checkout.' }); }
    }
    if (p === '/api/billing/webhook' && req.method === 'POST') {
      if (!STRIPE_WEBHOOK_SECRET) { res.writeHead(400); return res.end('webhook not configured'); }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks);
          const sig = req.headers['stripe-signature'] || '';
          const t = (sig.match(/t=(\d+)/) || [])[1];
          const v1 = (sig.match(/v1=([a-f0-9]+)/) || [])[1];
          if (!t || !v1) { res.writeHead(400); return res.end('bad signature'); }
          const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(t + '.' + raw.toString('utf8')).digest('hex');
          if (expected.length !== v1.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))) { res.writeHead(400); return res.end('bad signature'); }
          const event = JSON.parse(raw.toString('utf8'));
          const users = usersStore.read();
          const findByMeta = (obj) => {
            const uid = obj && obj.metadata && obj.metadata.userId;
            return uid ? users.find(u => u.id === uid) : null;
          };
          if (event.type === 'checkout.session.completed') {
            const s = event.data.object;
            const u = findByMeta(s) || users.find(x => x.email === (s.customer_email || '').toLowerCase());
            if (u) { u.stripeCustomerId = s.customer; u.stripeSubscriptionId = s.subscription; u.billingStatus = 'active'; usersStore.write(users); }
          } else if (event.type === 'customer.subscription.deleted') {
            const sub = event.data.object;
            const u = users.find(x => x.stripeSubscriptionId === sub.id || x.stripeCustomerId === sub.customer);
            if (u) { u.billingStatus = 'canceled'; usersStore.write(users); }
          } else if (event.type === 'invoice.payment_failed') {
            const inv = event.data.object;
            const u = users.find(x => x.stripeSubscriptionId === inv.subscription || x.stripeCustomerId === inv.customer);
            if (u) { u.billingStatus = 'past_due'; usersStore.write(users); }
          }
          res.writeHead(200); return res.end('ok');
        } catch (e) { res.writeHead(400); return res.end('webhook error'); }
      });
      return;
    }

    // ---------- Founder admin (token-gated, or signed-in admin user) ----------
    function adminAuthed(req) {
      const match = (req.headers.cookie || '').match(/mmn_admin=([a-f0-9]+)/);
      if (match && adminSessions.has(match[1])) return true;
      const u = getSessionUser(req);
      return !!(u && u.isAdmin);
    }
    if (p === '/api/admin/login' && req.method === 'POST') {
      const { token } = await parseBody(req);
      let ok = false;
      if (ADMIN_TOKEN && typeof token === 'string' && token.length === ADMIN_TOKEN.length) {
        ok = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
      }
      if (!ok) return sendJson(res, 401, { error: 'Not authorized.' });
      const t = crypto.randomBytes(32).toString('hex');
      adminSessions.add(t);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `mmn_admin=${t}; HttpOnly; SameSite=Lax; Path=/` });
      return res.end('{}');
    }
    if (p === '/api/admin/logout' && req.method === 'POST') {
      const match = (req.headers.cookie || '').match(/mmn_admin=([a-f0-9]+)/);
      if (match) adminSessions.delete(match[1]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'mmn_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
      return res.end('{}');
    }
    if (p === '/api/admin/promote' && req.method === 'POST') {
      if (!adminAuthed(req)) return sendJson(res, 401, { error: 'Not authorized.' });
      const { email, isAdmin } = await parseBody(req);
      const users = usersStore.read();
      const user = users.find(u => u.email === String(email || '').toLowerCase());
      if (!user) return sendJson(res, 404, { error: 'No account with that email.' });
      user.isAdmin = !!isAdmin;
      usersStore.write(users);
      return sendJson(res, 200, { ok: true, user: publicUser(user) });
    }
    if (p === '/api/admin/data' && req.method === 'GET') {
      if (!adminAuthed(req)) return sendJson(res, 401, { error: 'Not authorized.' });
      const businesses = businessesStore.read();
      const requests = requestsStore.read();
      const quotes = quotesStore.read();
      const users = usersStore.read();
      const visits = visitsStore.read();
      const searches = searchesStore.read();
      const dayOf = iso => String(iso || '').slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      const byDay = {};
      for (const v of visits) {
        const k = dayOf(v.t);
        byDay[k] = byDay[k] || { visits: 0, ips: new Set() };
        byDay[k].visits++; byDay[k].ips.add(v.ip);
      }
      const todayStats = byDay[today] || { visits: 0, ips: new Set() };
      const pageCounts = {};
      for (const v of visits) pageCounts[v.path] = (pageCounts[v.path] || 0) + 1;
      const cityCounts = {};
      for (const s of searches) {
        const k = [s.city, s.state].filter(Boolean).join(', ');
        if (k) cityCounts[k] = (cityCounts[k] || 0) + 1;
      }
      return sendJson(res, 200, {
        counts: {
          owners: users.filter(u => u.role === 'owner').length,
          mechanics: users.filter(u => u.role === 'mechanic').length,
          businesses: businesses.length,
          publishedBusinesses: businesses.filter(b => b.published).length,
          requests: requests.length,
          quotes: quotes.length,
        },
        analytics: {
          totalVisits: visits.length,
          uniqueVisitors: new Set(visits.map(v => v.ip)).size,
          visitsToday: todayStats.visits,
          uniquesToday: todayStats.ips.size,
          totalSearches: searches.length,
          byDay: Object.keys(byDay).sort().slice(-14).map(k => ({ date: k, visits: byDay[k].visits, uniques: byDay[k].ips.size })),
          topPages: Object.entries(pageCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, count]) => ({ path, count })),
          topCities: Object.entries(cityCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([city, count]) => ({ city, count })),
          recentSearches: searches.slice(-50).reverse().map(s => ({ t: s.t, city: s.city, state: s.state, service: s.service })),
        },
        users: users.map(publicUser),
        businesses: businesses.map(b => ({ ...publicBusiness(b), published: !!b.published, createdAt: b.createdAt })),
        requests: requests.map(r => ({ id: r.id, ownerName: r.ownerName, phone: r.phone, city: r.city, state: r.state, service: r.service, vehicle: r.vehicle, status: r.status, createdAt: r.createdAt })),
        quotes: quotes.map(q => ({ id: q.id, requestId: q.requestId, price: q.price, status: q.status, createdAt: q.createdAt })),
      });
    }
    const adminBizToggle = p.match(/^\/api\/admin\/business\/([0-9a-f-]+)$/);
    if (adminBizToggle && req.method === 'POST') {
      if (!adminAuthed(req)) return sendJson(res, 401, { error: 'Not authorized.' });
      const { published } = await parseBody(req);
      const businesses = businessesStore.read();
      const biz = businesses.find(b => b.id === adminBizToggle[1]);
      if (!biz) return sendJson(res, 404, { error: 'Business not found.' });
      biz.published = !!published;
      businessesStore.write(businesses);
      return sendJson(res, 200, { business: { id: biz.id, published: biz.published } });
    }
    const adminUserDel = p.match(/^\/api\/admin\/users\/([0-9a-f-]+)$/);
    if (adminUserDel && req.method === 'DELETE') {
      if (!adminAuthed(req)) return sendJson(res, 401, { error: 'Not authorized.' });
      const uid = adminUserDel[1];
      const users = usersStore.read();
      const idx = users.findIndex(u => u.id === uid);
      if (idx === -1) return sendJson(res, 404, { error: 'Account not found.' });
      users.splice(idx, 1); usersStore.write(users);
      const businesses = businessesStore.read();
      const doomed = businesses.filter(b => b.userId === uid);
      const bizIds = doomed.map(b => b.id);
      for (const b of doomed) for (const url of [b.logoUrl, b.coverUrl, ...(b.gallery || [])]) {
        if (typeof url === 'string' && url.startsWith('/uploads/')) {
          const name = url.slice('/uploads/'.length);
          if (/^[A-Za-z0-9._-]+$/.test(name)) { try { fs.unlinkSync(path.join(DATA_DIR, 'uploads', name)); } catch (e) {} }
        }
      }
      businessesStore.write(businesses.filter(b => b.userId !== uid));
      promotionsStore.write(promotionsStore.read().filter(x => !bizIds.includes(x.businessId)));
      ticketsStore.write(ticketsStore.read().filter(x => x.userId !== uid));
      const requests = requestsStore.read();
      const reqIds = requests.filter(r => r.ownerId === uid).map(r => r.id);
      requestsStore.write(requests.filter(r => r.ownerId !== uid));
      quotesStore.write(quotesStore.read().filter(q => q.mechanicId !== uid && !reqIds.includes(q.requestId)));
      vehiclesStore.write(vehiclesStore.read().filter(v => v.ownerId !== uid));
      for (const [tok, sessUid] of sessions) if (sessUid === uid) sessions.delete(tok);
      return sendJson(res, 200, { deleted: uid });
    }

    // ---------- Pages ----------
    if (p === '/account') return serveFile(res, path.join(PUBLIC_DIR, 'account.html'));
    if (p === '/find') return serveFile(res, path.join(PUBLIC_DIR, 'find.html'));
    if (p === '/admin') return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    if (p === '/mechanic') {
      const u = getSessionUser(req);
      if (!u) { res.writeHead(302, { Location: '/account' }); return res.end(); }
      if (u.role !== 'mechanic') { res.writeHead(302, { Location: '/dashboard' }); return res.end(); }
      return serveFile(res, path.join(PUBLIC_DIR, 'mechanic.html'));
    }
    if (p === '/ticket') {
      if (!getSessionUser(req)) { res.writeHead(302, { Location: '/account' }); return res.end(); }
      return serveFile(res, path.join(PUBLIC_DIR, 'ticket.html'));
    }
    if (p === '/mechanics') return serveFile(res, path.join(PUBLIC_DIR, 'mechanics.html'));
    if (p === '/request') return serveFile(res, path.join(PUBLIC_DIR, 'request.html'));
    if (p === '/dashboard') {
      if (!getSessionUser(req)) { res.writeHead(302, { Location: '/account' }); return res.end(); }
      return serveFile(res, path.join(PUBLIC_DIR, 'dashboard.html'));
    }

    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const filePath = path.join(PUBLIC_DIR, rel);
    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return serveFile(res, filePath);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    sendJson(res, 500, { error: 'Something went wrong.' });
  }
});

server.listen(PORT, () => console.log(`Mobile Mechanic Network site running on http://localhost:${PORT}`));
