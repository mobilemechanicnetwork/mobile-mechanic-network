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

const sessions = new Map(); // token -> userId (in-memory at this stage)

function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function makeUser({ name, email, password, role }) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: crypto.randomUUID(), name, email: email.toLowerCase(), role, salt, passwordHash: hashPassword(password, salt), createdAt: new Date().toISOString() };
}
function verifyPassword(user, password) {
  return crypto.timingSafeEqual(Buffer.from(hashPassword(password, user.salt), 'hex'), Buffer.from(user.passwordHash, 'hex'));
}
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt }; }

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
  return { id: b.id, name: b.name, city: b.city, state: b.state, serviceCities: b.serviceCities || [], services: b.services, about: b.about, mechanicName: owner ? owner.name : '' };
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serveFile(res, file) { res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file)); }

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

    // ---------- Mechanic business profiles + directory ----------
    if (p === '/api/business' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Only mobile mechanic accounts have a business page.' });
      const { name, city, state, serviceCities, services, about, published } = await parseBody(req);
      if (!name || !city || !state || !Array.isArray(services) || services.length === 0)
        return sendJson(res, 400, { error: 'Business name, city, state, and at least one service are required.' });
      const cleanServices = services.filter(s => SERVICES.includes(s));
      if (cleanServices.length === 0) return sendJson(res, 400, { error: 'Pick at least one valid service.' });
      const businesses = businessesStore.read();
      let biz = businesses.find(b => b.userId === user.id);
      const rawCities = Array.isArray(serviceCities) ? serviceCities.join(',') : String(serviceCities || '');
      const cleanCities = [...new Set(rawCities.split(/[,\n]/).map(s => s.trim()).filter(Boolean))];
      const fields = { name: String(name).trim(), city: String(city).trim(), state: String(state).trim().toUpperCase(), serviceCities: cleanCities, services: cleanServices, about: String(about || ''), published: !!published };
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
      return sendJson(res, 200, { mechanics: list.map(publicBusiness) });
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

    // ---------- Pages ----------
    if (p === '/account') return serveFile(res, path.join(PUBLIC_DIR, 'account.html'));
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
