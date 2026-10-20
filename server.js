// Mobile Mechanic Network — website server
// Stage 1: public site + accounts. Stage 2: mechanic business profiles + directory.
// Stage 3: quote requests matched by area + service, mechanic quotes, accept/decline.
// Dependency-free Node.js. Portable: runs on any host that runs Node.
// Storage is JSON files for the pre-deploy stage; swap for Postgres at deploy.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const SERVICES = ['Diagnostics', 'Brakes', 'Battery & starting', 'Oil & maintenance', 'Engine repair', 'Pre-purchase inspection'];

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
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // founder admin passphrase, set as env var on the host
const adminSessions = new Set(); // admin token strings (in-memory; re-login after each deploy)

function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function makeUser({ name, email, password, role }) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: crypto.randomUUID(), name, email: email.toLowerCase(), role, salt, passwordHash: hashPassword(password, salt), createdAt: new Date().toISOString() };
}
function verifyPassword(user, password) {
  return crypto.timingSafeEqual(Buffer.from(hashPassword(password, user.salt), 'hex'), Buffer.from(user.passwordHash, 'hex'));
}
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone || '', createdAt: u.createdAt }; }

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
  return biz && biz.published
    && biz.state.toLowerCase() === reqRow.state.toLowerCase()
    && biz.services.includes(reqRow.service)
    && servedCities(biz).includes(reqRow.city.toLowerCase());
}
function publicBusiness(b) {
  const owner = usersStore.read().find(u => u.id === b.userId);
  return { id: b.id, name: b.name, city: b.city, state: b.state, serviceCities: b.serviceCities || [], services: b.services, about: b.about, phone: b.phone || '', logoUrl: b.logoUrl || '', coverUrl: b.coverUrl || '', gallery: b.gallery || [], mechanicName: owner ? owner.name : '' };
}
function latestPromotion(businessId) {
  const all = promotionsStore.read().filter(x => x.businessId === businessId);
  all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const p = all[0];
  return p ? { title: p.title, description: p.description, validUntil: p.validUntil } : null;
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
      return sendJson(res, 200, { user: publicUser(user) });
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
      const { name, city, state, serviceCities, services, about, published, phone, logoUrl, coverUrl } = await parseBody(req);
      if (!name || !city || !state || !Array.isArray(services) || services.length === 0)
        return sendJson(res, 400, { error: 'Business name, city, state, and at least one service are required.' });
      const cleanServices = services.filter(s => SERVICES.includes(s));
      if (cleanServices.length === 0) return sendJson(res, 400, { error: 'Pick at least one valid service.' });
      const businesses = businessesStore.read();
      let biz = businesses.find(b => b.userId === user.id);
      const rawCities = Array.isArray(serviceCities) ? serviceCities.join(',') : String(serviceCities || '');
      const cleanCities = [...new Set(rawCities.split(/[,\n]/).map(s => s.trim()).filter(Boolean))];
      const fields = { name: String(name).trim(), city: String(city).trim(), state: String(state).trim().toUpperCase(), serviceCities: cleanCities, services: cleanServices, about: String(about || ''), phone: String(phone || '').trim(), published: !!published };
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
      let list = businessesStore.read().filter(b => b.published);
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
      const { city, state, service, vehicle, description, phone } = await parseBody(req);
      if (!city || !state || !SERVICES.includes(service) || !vehicle || !description || !phone)
        return sendJson(res, 400, { error: 'City, state, service, vehicle, a description, and a phone number are required.' });
      const rows = requestsStore.read();
      const row = { id: crypto.randomUUID(), ownerId: user.id, ownerName: user.name, phone: String(phone).trim(), city: String(city).trim(), state: String(state).trim().toUpperCase(), service, vehicle: String(vehicle).trim(), description: String(description).trim(), status: 'open', createdAt: new Date().toISOString() };
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
          return { ...q, businessName: biz ? biz.name : 'Mobile mechanic', businessCity: biz ? `${biz.city}, ${biz.state}` : '' };
        }),
      }));
      return sendJson(res, 200, { requests: mine });
    }
    if (p === '/api/requests/inbox' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const biz = myBusiness(user.id);
      if (!biz || !biz.published) return sendJson(res, 200, { requests: [], needsBusiness: true });
      const quotes = quotesStore.read();
      const inbox = requestsStore.read()
        .filter(r => r.status === 'open' && requestMatchesBusiness(r, biz))
        .map(r => ({ ...r, myQuote: quotes.find(q => q.requestId === r.id && q.businessId === biz.id) || null }));
      return sendJson(res, 200, { requests: inbox });
    }

    // ---------- Quotes ----------
    if (p === '/api/quotes' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const biz = myBusiness(user.id);
      const { requestId, price, message } = await parseBody(req);
      const row = requestsStore.read().find(r => r.id === requestId);
      if (!row || row.status !== 'open' || !requestMatchesBusiness(row, biz))
        return sendJson(res, 400, { error: 'That request is not open in your service area.' });
      const amount = Number(price);
      if (!amount || amount <= 0) return sendJson(res, 400, { error: 'Enter a price for your quote.' });
      const quotes = quotesStore.read();
      if (quotes.some(q => q.requestId === requestId && q.businessId === biz.id && q.status === 'pending'))
        return sendJson(res, 409, { error: 'You already quoted this request.' });
      const quote = { id: crypto.randomUUID(), requestId, businessId: biz.id, mechanicId: user.id, price: amount, message: String(message || ''), status: 'pending', createdAt: new Date().toISOString() };
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
      const biz = myBusiness(user.id);
      if (!biz) return sendJson(res, 400, { error: 'Save your business page first.' });
      const { type, customerName, vehicle, items, notes } = await parseBody(req);
      if (!['estimate', 'invoice', 'receipt'].includes(type)) return sendJson(res, 400, { error: 'Pick estimate, invoice, or receipt.' });
      if (!customerName || !Array.isArray(items) || !items.length) return sendJson(res, 400, { error: 'Customer name and at least one line item are required.' });
      const cleanItems = items.slice(0, 50)
        .map(it => ({ desc: String(it.desc || '').trim().slice(0, 200), amount: Math.max(0, Number(it.amount) || 0) }))
        .filter(it => it.desc);
      if (!cleanItems.length) return sendJson(res, 400, { error: 'Add at least one line item.' });
      const tickets = ticketsStore.read();
      const ticket = { id: crypto.randomUUID(), businessId: biz.id, mechanicId: user.id, type, customerName: String(customerName).trim().slice(0, 120), vehicle: String(vehicle || '').trim().slice(0, 120), items: cleanItems, notes: String(notes || '').trim().slice(0, 1000), total: Math.round(cleanItems.reduce((s, it) => s + it.amount, 0) * 100) / 100, createdAt: new Date().toISOString() };
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
    const ticketDel = p.match(/^\/api\/tickets\/([0-9a-f-]+)$/);
    if (ticketDel && req.method === 'DELETE') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
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

    // ---------- Founder admin (token-gated; set ADMIN_TOKEN env var on the host) ----------
    function adminAuthed(req) {
      const match = (req.headers.cookie || '').match(/mmn_admin=([a-f0-9]+)/);
      return !!match && adminSessions.has(match[1]);
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
    if (p === '/api/admin/data' && req.method === 'GET') {
      if (!adminAuthed(req)) return sendJson(res, 401, { error: 'Not authorized.' });
      const businesses = businessesStore.read();
      const requests = requestsStore.read();
      const quotes = quotesStore.read();
      const users = usersStore.read();
      return sendJson(res, 200, {
        counts: {
          owners: users.filter(u => u.role === 'owner').length,
          mechanics: users.filter(u => u.role === 'mechanic').length,
          businesses: businesses.length,
          publishedBusinesses: businesses.filter(b => b.published).length,
          requests: requests.length,
          quotes: quotes.length,
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

    // ---------- Pages ----------
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
