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

const SERVICES = ['Diagnostics', 'Brakes', 'Battery & starting', 'Oil & maintenance', 'Pre-purchase inspection', 'Complete vehicle inspection', 'Other'];

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
const calendarStore = store('calendar.json');
const vehiclesStore = store('vehicles.json');
const helpStore = store('help.json');
const smsCodeStore = store('smscodes.json'); // password-reset + 2FA + login-challenge codes
const ppiStore = store('ppi.json');
const reviewsStore = store('reviews.json');

const sessions = new Map(); // token -> userId (in-memory at this stage)

// US city,state dataset for autocomplete (bundled with the code, not in DATA_DIR)
let US_CITIES = [];
try { US_CITIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'us-cities.json'), 'utf8')); } catch (e) { US_CITIES = []; }
// ---------- Vehicle year/make/model data (NHTSA vPIC, US 1980-now) ----------
let VEHICLES = null;
try { VEHICLES = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'us-vehicles.json'), 'utf8')); } catch (e) { VEHICLES = null; }
// Vehicle types: car (NHTSA), motorcycle (NHTSA), commercial (NHTSA),
// smallengine (curated brand list, client-side)
const VTYPES = ['car', 'motorcycle', 'commercial', 'smallengine'];
const VTYPE_LABELS = { car: 'cars and trucks', motorcycle: 'motorcycles', commercial: 'buses and commercial vehicles', smallengine: 'small engines' };
function vehicleYears() { return (VEHICLES && VEHICLES.years) || []; }
function vehicleTypeOf(make) {
  if (!VEHICLES || !VEHICLES.types) return ['car'];
  const t = VEHICLES.types[String(make || '')];
  if (Array.isArray(t)) return t;
  return t ? [t] : ['car'];
}
function vehicleMakes(year, type) {
  if (!VEHICLES) return [];
  const y = String(year || ''), t = String(type || 'car');
  const set = {};
  for (const k of Object.keys(VEHICLES.models)) {
    if (k.indexOf(y + '|') !== 0) continue;
    const mk = k.slice(y.length + 1);
    if (!vehicleTypeOf(mk).includes(t)) continue;
    set[mk] = true;
  }
  return Object.keys(set).sort((a, b) => a.localeCompare(b));
}
function vehicleModels(year, make, type) {
  if (!VEHICLES) return [];
  const v = VEHICLES.models[String(year || '') + '|' + String(make || '')];
  if (!v) return [];
  // spanning makes (Honda, BMW, Suzuki, Triumph) store {car: [...], motorcycle: [...]}
  if (!Array.isArray(v)) return v[String(type || 'car')] || [];
  return v;
}
// Derive a garage vehicle {year, make, model, type} from a quote request.
// Prefers structured fields saved at request time; falls back to parsing
// the "YEAR MAKE MODEL" string against the known makes list. Returns null
// when it cannot be split reliably (e.g. small-engine free text).
function vehicleFromRequest(r) {
  const type = VTYPES.includes(r.vehicleType) ? r.vehicleType : 'car';
  if (r.vehicleMake && r.vehicleModel) {
    return { year: String(r.vehicleYear || '').slice(0, 10), make: String(r.vehicleMake).slice(0, 60), model: String(r.vehicleModel).slice(0, 60), type };
  }
  const str = String(r.vehicle || '').trim();
  const m = str.match(/^(\d{4})\s+(.+)$/);
  if (!m || type === 'smallengine') return null;
  const rest = m[2];
  let make = '', model = '';
  if (VEHICLES && Array.isArray(VEHICLES.makes)) {
    const low = rest.toLowerCase();
    let best = '';
    for (const mk of VEHICLES.makes) {
      if (low.startsWith(mk.toLowerCase() + ' ') || low === mk.toLowerCase()) {
        if (mk.length > best.length) best = mk;
      }
    }
    if (best) { make = best; model = rest.slice(best.length).trim(); }
  }
  if (!make) { const parts = rest.split(/\s+/); make = parts[0] || ''; model = parts.slice(1).join(' '); }
  if (!make || !model) return null;
  return { year: m[1], make: make.slice(0, 60), model: model.slice(0, 60), type };
}
function searchCities(q, state, limit) {
  q = String(q || '').trim().toLowerCase();
  state = String(state || '').trim().toUpperCase();
  limit = Math.min(10, Math.max(1, parseInt(limit, 10) || 8));
  if (q.length < 2) return [];
  const starts = [], contains = [];
  for (const pair of US_CITIES) {
    const name = pair[0], st = pair[1];
    if (state && st !== state) continue;
    const ln = name.toLowerCase();
    if (ln.startsWith(q)) { if (starts.length < limit) starts.push({ city: name, state: st }); }
    else if (ln.includes(q)) { if (contains.length < limit) contains.push({ city: name, state: st }); }
    if (starts.length >= limit && contains.length >= limit) break;
  }
  return starts.concat(contains).slice(0, limit);
}
const visitsStore = store('visits.json');
const searchesStore = store('searches.json');
const notificationsStore = store('notifications.json');
const quoteDraftsStore = store('quote-drafts.json');
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
const guestReqLog = new Map(); // iphash -> [timestamps], guest quote-request rate limiting
function guestRateOk(req) {
  const h = clientIpHash(req);
  const now = Date.now();
  const arr = (guestReqLog.get(h) || []).filter(t => now - t < 3600 * 1000);
  if (arr.length >= 5) return false;
  arr.push(now);
  guestReqLog.set(h, arr);
  return true;
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

// ---------- SMS auth helpers (password reset + 2FA via Twilio) ----------
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}
function maskPhone(e164) {
  const d = String(e164 || '').replace(/\D/g, '');
  return d.length >= 4 ? '***-***-' + d.slice(-4) : '***';
}
function twilioConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}
function sixDigitCode() { return String(crypto.randomInt(100000, 1000000)); }
function hashSmsCode(code, salt) { return crypto.scryptSync(String(code), salt, 64).toString('hex'); }
function smsCodesPrune() {
  try {
    const rows = smsCodeStore.read();
    const now = Date.now();
    const kept = rows.filter(r => r.expiresAt > now);
    if (kept.length !== rows.length) smsCodeStore.write(kept);
  } catch (e) {}
}
function safeCodeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a), 'hex'), bb = Buffer.from(String(b), 'hex');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch (e) { return false; }
}
function newBackupCodes() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const codes = [];
  for (let i = 0; i < 10; i++) {
    let c = '';
    for (let j = 0; j < 8; j++) c += alphabet[crypto.randomInt(alphabet.length)];
    codes.push(c.slice(0, 4) + '-' + c.slice(4));
  }
  return codes;
}
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, role: u.role, isAdmin: !!u.isAdmin, phone: u.phone || '', twoFactorEnabled: !!u.twoFactorEnabled, createdAt: u.createdAt }; }

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
  const user = userId ? usersStore.read().find(u => u.id === userId) || null : null;
  if (user) ensureTrial(user);
  return user;
}
function startSession(res, status, user, payload) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, user.id);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Set-Cookie': `mmn_session=${token}; HttpOnly; SameSite=Lax; Path=/` });
  res.end(JSON.stringify(payload));
}
function myBusiness(userId) { return businessesStore.read().find(b => b.userId === userId) || null; }

// Backfill the 60-day trial for mechanic accounts created before trials existed.
function ensureTrial(user) {
  if (!user || user.role !== 'mechanic' || user.trialEndsAt) return false;
  const base = user.createdAt ? new Date(user.createdAt).getTime() : Date.now();
  user.trialEndsAt = new Date(base + 60 * 24 * 3600 * 1000).toISOString();
  if (!user.billingStatus) user.billingStatus = 'trialing';
  const users = usersStore.read();
  const ix = users.findIndex(u => u.id === user.id);
  if (ix !== -1) { users[ix] = user; usersStore.write(users); }
  return true;
}

// Validate and normalize ticket fields. Returns {error} or the cleaned fields.
function ownerByPhone(phone) {
  const e164 = normalizePhone(phone);
  if (!e164) return null;
  return usersStore.read().find(u => u.role === 'owner' && normalizePhone(u.phone) === e164) || null;
}
function pushOwnerNote(ownerId, note) {
  if (!ownerId) return false;
  try {
    const notes = notificationsStore.read();
    notes.push({ id: crypto.randomUUID(), userId: ownerId, read: false, createdAt: new Date().toISOString(), ...note });
    notificationsStore.write(notes);
    return true;
  } catch (e) { return false; }
}
function cleanTicketBody(body, type) {
  const { customerName, vehicle, items, notes, laborDesc, laborAmount, taxRate, warranty, vin, mileage, paymentMethod, jobAddress, comments, phone } = body || {};
  if (!customerName || !String(customerName).trim()) return { error: 'Customer name is required.' };
  if (!Array.isArray(items) || !items.length) return { error: 'At least one line item is required.' };
  let ticketVin = '';
  if (vin && String(vin).trim()) {
    ticketVin = cleanVin(vin);
    if (!ticketVin) return { error: 'VIN must be 17 characters (letters and numbers, no I, O, or Q).' };
  }
  let ticketMileage = '';
  if (mileage !== undefined && mileage !== null && String(mileage).trim() !== '') {
    const m = Number(String(mileage).replace(/[^0-9]/g, ''));
    if (!Number.isFinite(m) || m < 0 || m > 9999999) return { error: 'Enter a valid vehicle mileage.' };
    ticketMileage = m;
  }
  if ((type === 'invoice' || type === 'receipt') && !ticketVin)
    return { error: 'A VIN is required on invoices and receipts.' };
  if (type === 'receipt' && ticketMileage === '')
    return { error: 'A vehicle mileage is required on receipts.' };
  const r2 = n => Math.round(n * 100) / 100;
  const cleanItems = items.slice(0, 50)
    .map(it => ({ desc: String(it.desc || '').trim().slice(0, 200), qty: Math.max(0, Number(it.qty) || 0), price: Math.max(0, Number(it.price) || 0) }))
    .filter(it => it.desc && it.qty > 0 && it.price >= 0);
  if (!cleanItems.length) return { error: 'Add at least one line item with a quantity and price.' };
  const partsSubtotal = r2(cleanItems.reduce((s, it) => s + it.qty * it.price, 0));
  const laborAmountNum = r2(Math.max(0, Number(laborAmount) || 0));
  const rate = Math.max(0, Math.min(100, Number(taxRate) || 0));
  const taxAmount = r2(r2(partsSubtotal + laborAmountNum) * rate / 100);
  const total = r2(partsSubtotal + laborAmountNum + taxAmount);
  return {
    customerName: String(customerName).trim().slice(0, 120),
    vehicle: String(vehicle || '').trim().slice(0, 120),
    vin: ticketVin, mileage: ticketMileage, items: cleanItems,
    laborDesc: String(laborDesc || '').trim().slice(0, 200), laborAmount: laborAmountNum,
    taxRate: rate, subtotal: partsSubtotal, taxAmount,
    notes: String(notes || '').trim().slice(0, 1000),
    warranty: String(warranty || '').trim().slice(0, 2000),
    ...(paymentMethod !== undefined ? { paymentMethod: String(paymentMethod || '').trim().slice(0, 50) } : {}),
    ...(phone !== undefined ? { phone: String(phone || '').trim().slice(0, 25) } : {}),
    ...(jobAddress !== undefined ? { jobAddress: String(jobAddress || '').trim().slice(0, 200) } : {}),
    ...(comments !== undefined ? { comments: String(comments || '').trim().slice(0, 2000) } : {}),
    total
  };
}
// Build an invoice from an accepted quote. Returns the ticket object or null.
// Ticket numbers are sequential per business, starting at 1, in the
// order tickets were created, shown as the shop's abbreviation plus the
// number (Alternative Auto -> AA-1). Both are assigned at creation and
// stored on the ticket, so a printed ticket always matches the portal
// record even if the shop later renames itself.
function businessAbbrev(name) {
  const words = String(name || '').match(/[A-Za-z0-9]+/g) || [];
  let abbr = words.map(w => w[0].toUpperCase()).join('');
  if (abbr.length < 2) abbr = String(name || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
  if (abbr.length > 4) abbr = abbr.slice(0, 4);
  return abbr || 'SHOP';
}
function nextTicketNumber(businessId, tickets) {
  const list = tickets || ticketsStore.read();
  const nums = list.filter(t => t.businessId === businessId && Number.isFinite(Number(t.number))).map(t => Number(t.number));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}
// One-time backfill for tickets created before numbering existed: they
// get numbers in createdAt order, after any number already assigned, so
// no existing ticket is ever renumbered.
function backfillTicketNumbers() {
  const tickets = ticketsStore.read();
  const businesses = businessesStore.read();
  let changed = false;
  const byBiz = {};
  tickets.forEach(t => { (byBiz[t.businessId] = byBiz[t.businessId] || []).push(t); });
  Object.values(byBiz).forEach(list => {
    list.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    let next = Math.max(0, ...list.filter(t => Number.isFinite(Number(t.number))).map(t => Number(t.number)));
    const biz = businesses.find(b => b.id === list[0].businessId);
    const abbr = businessAbbrev(biz ? biz.name : '');
    list.forEach(t => {
      if (!Number.isFinite(Number(t.number))) { t.number = ++next; changed = true; }
      if (!t.label) { t.label = abbr + '-' + t.number; changed = true; }
    });
  });
  if (changed) ticketsStore.write(tickets);
}
function ticketFromAcceptedQuote(quote, row) {
  const r2 = n => Math.round(n * 100) / 100;
  let items = (quote.items || [])
    .map(it => ({ desc: String(it.desc || '').trim().slice(0, 200), qty: 1, price: r2(Math.max(0, Number(it.amount) || 0)) }))
    .filter(it => it.desc && it.price > 0);
  if (!items.length && Number(quote.total) > 0)
    items = [{ desc: row.service, qty: 1, price: r2(Number(quote.total)) }];
  if (!items.length) return null;
  const subtotal = r2(items.reduce((s, it) => s + it.qty * it.price, 0));
  const biz = businessesStore.read().find(b => b.id === quote.businessId);
  const number = nextTicketNumber(quote.businessId);
  return { id: crypto.randomUUID(), businessId: quote.businessId, mechanicId: quote.mechanicId, type: 'invoice', number, label: businessAbbrev(biz ? biz.name : '') + '-' + number, customerName: row.ownerName, vehicle: row.vehicle || '', vin: row.vin || '', mileage: '', items, laborDesc: '', laborAmount: 0, taxRate: 0, subtotal, taxAmount: 0, notes: String(quote.notes || '').slice(0, 1000), warranty: biz && biz.warranty ? String(biz.warranty).slice(0, 2000) : '', requestId: row.id, quoteId: quote.id, total: subtotal, createdAt: new Date().toISOString() };
}
// Total a customer would owe if they approve extra lines on an invoice.
// Uses the exact rounding the acceptance handlers use, so the total the
// customer sees before approving is the total they get after approving.
function invoiceTotalsAfter(t, lines) {
  const r2 = n => Math.round(n * 100) / 100;
  const itemsSum = (t.items || []).reduce((s, it) => s + (it.qty != null ? Number(it.qty) : 1) * Number(it.price != null ? it.price : (it.amount || 0)), 0);
  const parts = r2(itemsSum);
  const labor = Number(t.laborAmount || 0);
  const rate = Number(t.taxRate || 0);
  const totalFor = extra => {
    const p = r2(parts + extra);
    const tax = r2(r2(p + labor) * rate / 100);
    return r2(p + labor + tax);
  };
  const pending = (lines || []).reduce((s, l) => s + Number(l.price || 0), 0);
  return {
    approvedTotal: r2(Number(t.total || 0)),
    pendingTotal: r2(pending),
    newTotalAll: totalFor(pending),
    perLineNewTotals: (lines || []).map(l => totalFor(Number(l.price || 0)))
  };
}
// Service areas are stored as "City, ST" strings so a mechanic can serve
// cities in other states (e.g. Slidell, LA serving Picayune, MS).
// Legacy bare city names are treated as being in the business's base state.
function parseCityState(entry, fallbackState) {
  const m = String(entry || '').trim().match(/^(.+?),\s*([A-Za-z]{2})$/);
  if (m) return { city: m[1].trim(), state: m[2].toUpperCase() };
  const bare = String(entry || '').trim();
  if (!bare) return null;
  return { city: bare, state: String(fallbackState || '').toUpperCase() };
}
function servedCityKeys(biz) {
  const list = [biz.city + ', ' + biz.state, ...(Array.isArray(biz.serviceCities) ? biz.serviceCities : [])];
  const keys = [];
  for (const c of list) {
    const p = parseCityState(c, biz.state);
    if (p && p.city) keys.push(p.city.toLowerCase() + '|' + p.state);
  }
  return keys;
}
function requestMatchesBusiness(reqRow, biz) {
  if (!biz) return false;
  if (reqRow.businessId && reqRow.businessId !== biz.id) return false;
  if (!reqRow.businessId && reqRow.urgent && !biz.acceptUrgent) return false;
  const owner = usersStore.read().find(u => u.id === biz.userId);
  if (mechanicFrozen(owner)) return false;
  const vt = reqRow.vehicleType || 'car';
  const bizTypes = Array.isArray(biz.vehicleTypes) && biz.vehicleTypes.length ? biz.vehicleTypes : ['car'];
  if (!bizTypes.includes(vt)) return false;
  return biz.services.includes(reqRow.service)
    && servedCityKeys(biz).includes(String(reqRow.city || '').toLowerCase() + '|' + String(reqRow.state || '').toUpperCase());
}
function publicBusiness(b) {
  const owner = usersStore.read().find(u => u.id === b.userId);
  const rating = businessRating(b.id);
  return { id: b.id, name: b.name, city: b.city, state: b.state, serviceCities: b.serviceCities || [], services: b.services, vehicleTypes: Array.isArray(b.vehicleTypes) && b.vehicleTypes.length ? b.vehicleTypes : ['car'], about: b.about, phone: b.phone || '', logoUrl: b.logoUrl || '', coverUrl: b.coverUrl || '', coverPosition: b.coverPosition || '50% 50%', gallery: b.gallery || [], socials: b.socials || {}, warranty: b.warranty || '', acceptUrgent: !!b.acceptUrgent, certifications: b.certifications || [], prices: b.prices || [], avgRating: rating.avg, reviewCount: rating.count, fastResponder: isFastResponder(b.id), mechanicName: owner ? owner.name : '' };
}
function businessRating(businessId) {
  const revs = reviewsStore.read().filter(r => r.businessId === businessId);
  if (!revs.length) return { avg: 0, count: 0 };
  const avg = revs.reduce((s, r) => s + r.rating, 0) / revs.length;
  return { avg: Math.round(avg * 10) / 10, count: revs.length };
}
function isFastResponder(businessId) {
  // Median time from request to this business's first quote, over recent requests.
  const quotes = quotesStore.read().filter(q => q.businessId === businessId);
  if (!quotes.length) return false;
  const reqs = requestsStore.read();
  const firstByReq = {};
  quotes.forEach(q => { if (!firstByReq[q.requestId] || String(q.createdAt) < String(firstByReq[q.requestId])) firstByReq[q.requestId] = q.createdAt; });
  const mins = [];
  for (const rid of Object.keys(firstByReq)) {
    const r = reqs.find(x => x.id === rid);
    if (!r || !r.createdAt) continue;
    const m = (new Date(firstByReq[rid]) - new Date(r.createdAt)) / 60000;
    if (m >= 0 && m < 60 * 24 * 30) mins.push(m);
  }
  if (mins.length < 3) return false;
  mins.sort((a, b) => a - b);
  return mins[Math.floor(mins.length / 2)] <= 60;
}
function cleanCertifications(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split(/[\n,]/);
  return [...new Set(arr.map(s => String(s).trim().slice(0, 60)).filter(Boolean))].slice(0, 10);
}
// Twilio SMS. Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER env vars.
// Returns { sent: true } or { sent: false, reason } — never throws.
async function sendSms(to, body) {
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM_NUMBER;
    if (!sid || !tok || !from) return { sent: false, reason: 'twilio-not-configured' };
    const digits = String(to || '').replace(/\D/g, '');
    const e164 = digits.length === 10 ? '+1' + digits : digits.length === 11 && digits[0] === '1' ? '+' + digits : null;
    if (!e164) return { sent: false, reason: 'bad-phone' };
    const auth = Buffer.from(sid + ':' + tok).toString('base64');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: e164, From: from, Body: String(body).slice(0, 1500) }).toString(),
    });
    if (!r.ok) return { sent: false, reason: 'twilio-' + r.status };
    return { sent: true };
  } catch (e) { return { sent: false, reason: 'error' }; }
}
// Set prices: one price per service, kept only for services the mechanic
// currently offers. A price on a service rides onto one-to-one quote
// requests for that service.
function cleanPrices(prices, services) {
  if (!Array.isArray(prices)) return [];
  const out = [];
  for (const p of prices.slice(0, 30)) {
    if (!p || !SERVICES.includes(p.service)) continue;
    if (!services.includes(p.service)) continue;
    const v = Math.round(Number(p.price) * 100) / 100;
    if (!Number.isFinite(v) || v <= 0 || v > 1000000) continue;
    if (out.some(x => x.service === p.service)) continue;
    out.push({ service: p.service, price: v });
  }
  return out;
}

function latestPromotion(businessId) {
  const all = promotionsStore.read().filter(x => x.businessId === businessId);
  all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const p = all[0];
  return p ? { title: p.title, description: p.description, validUntil: p.validUntil } : null;
}
// A mechanic is frozen when the 60-day trial is over and no active subscription exists.
// Frozen mechanics are hidden from search, get no requests, and cannot write —
// but they can always sign in and reach the Billing tab to add payment.
function mechanicFrozen(user) {
  if (!user || user.role !== 'mechanic') return false;
  if (user.billingStatus === 'active') return false;
  if (!user.trialEndsAt) return false;
  return Date.now() > new Date(user.trialEndsAt).getTime();
}
function frozenError(res) {
  return sendJson(res, 402, { error: 'Your 60-day free trial has ended. Add a payment method on the Billing tab to reactivate your account.', frozen: true });
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
  if (req.method === 'GET' && p === '/terms') { res.writeHead(302, { Location: '/#terms' }); return res.end(); }
  if (req.method === 'GET' && p === '/contact') { res.writeHead(302, { Location: '/#contact' }); return res.end(); }
  if (req.method === 'GET' && p === '/privacy') { res.writeHead(302, { Location: '/#privacy' }); return res.end(); }
  try {
    // ---------- Accounts ----------
    if (p === '/api/register' && req.method === 'POST') {
      const { name, email, password, role, phone } = await parseBody(req);
      if (!name || !email || !password || !['owner', 'mechanic'].includes(role))
        return sendJson(res, 400, { error: 'Name, email, password, and account type are required.' });
      if (String(password).length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
      const e164 = normalizePhone(phone);
      if (!e164) return sendJson(res, 400, { error: 'A valid 10-digit US phone number is required.' });
      const users = usersStore.read();
      if (users.some(u => u.email === String(email).toLowerCase())) return sendJson(res, 409, { error: 'An account with this email already exists.' });
      const user = makeUser({ name: String(name).trim(), email: String(email).trim(), password: String(password), role });
      user.phone = e164;
      if (role === 'mechanic') {
        user.trialEndsAt = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
        user.billingStatus = 'trialing';
      }
      users.push(user); usersStore.write(users);
      if (role === 'owner') {
        try {
      const rows = requestsStore.read();
          let claimed = false;
          const claimedRows = [];
          rows.forEach(r => { if (!r.ownerId && r.phone === user.phone) { r.ownerId = user.id; r.ownerName = user.name; delete r.guest; claimed = true; claimedRows.push(r); } });
          if (claimed) requestsStore.write(rows);
          // The vehicle from their request goes into their garage.
          if (claimedRows.length) {
            const mine = vehiclesStore.read();
            let added = false;
            for (const r of claimedRows) {
              const gv = vehicleFromRequest(r);
              if (!gv) continue;
              const dup = mine.some(v => v.ownerId === user.id && v.year === gv.year && v.make.toLowerCase() === gv.make.toLowerCase() && v.model.toLowerCase() === gv.model.toLowerCase() && v.type === gv.type);
              if (dup) continue;
              mine.push({ id: crypto.randomUUID(), ownerId: user.id, ...gv, createdAt: new Date().toISOString() });
              added = true;
            }
            if (added) vehiclesStore.write(mine);
          }
        } catch (e) {}
      }
      return startSession(res, 201, user, { user: publicUser(user) });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const { email, password } = await parseBody(req);
      const user = usersStore.read().find(u => u.email === String(email || '').toLowerCase());
      if (!user || !verifyPassword(user, String(password || ''))) return sendJson(res, 401, { error: 'Email or password is incorrect.' });
      if (user.twoFactorEnabled) {
        if (!twilioConfigured()) return sendJson(res, 503, { error: 'Two-factor authentication is on, but text messaging is not set up. Please contact us for help signing in.' });
        if (!user.phone) return sendJson(res, 400, { error: 'Two-factor authentication is on, but this account has no phone number. Please contact us.' });
        smsCodesPrune();
        const code = sixDigitCode();
        const salt = crypto.randomBytes(16).toString('hex');
        const challengeToken = crypto.randomBytes(32).toString('hex');
        const rows = smsCodeStore.read().filter(r => !(r.userId === user.id && r.purpose === 'login'));
        rows.push({ id: challengeToken, userId: user.id, purpose: 'login', codeHash: hashSmsCode(code, salt), salt, expiresAt: Date.now() + 5 * 60 * 1000, attempts: 0, createdAt: new Date().toISOString() });
        smsCodeStore.write(rows);
        const sms = await sendSms(user.phone, `Mobile Mechanic Network: your login code is ${code}. It expires in 5 minutes.`);
        if (!sms.sent) return sendJson(res, 502, { error: 'Could not send the login code. Please try again.' });
        return sendJson(res, 200, { twoFactorRequired: true, challengeToken, maskedPhone: maskPhone(user.phone) });
      }
      return startSession(res, 200, user, { user: publicUser(user) });
    }
    if (p === '/api/login/verify-2fa' && req.method === 'POST') {
      const { challengeToken, code } = await parseBody(req);
      smsCodesPrune();
      const rows = smsCodeStore.read();
      const row = rows.find(r => r.id === String(challengeToken || '') && r.purpose === 'login');
      if (!row) return sendJson(res, 400, { error: 'This code has expired. Please log in again.' });
      const users = usersStore.read();
      const user = users.find(u => u.id === row.userId);
      if (!user) return sendJson(res, 400, { error: 'Account not found.' });
      let ok = safeCodeEqual(hashSmsCode(code, row.salt), row.codeHash);
      if (!ok && Array.isArray(user.twoFactorBackupCodes)) {
        const idx = user.twoFactorBackupCodes.findIndex(h => safeCodeEqual(hashSmsCode(String(code).toUpperCase().replace(/-/g, ''), user.salt), h));
        if (idx >= 0) { user.twoFactorBackupCodes.splice(idx, 1); ok = true; }
      }
      if (!ok) {
        row.attempts += 1;
        if (row.attempts >= 5) {
          smsCodeStore.write(rows.filter(r => r.id !== row.id));
          return sendJson(res, 400, { error: 'Too many wrong codes. Please log in again.' });
        }
        smsCodeStore.write(rows);
        return sendJson(res, 400, { error: 'That code is not correct. Try again.' });
      }
      smsCodeStore.write(rows.filter(r => r.id !== row.id));
      usersStore.write(users);
      return startSession(res, 200, user, { user: publicUser(user) });
    }

    // ---------- SMS password reset ----------
    if (p === '/api/forgot-password' && req.method === 'POST') {
      const { email } = await parseBody(req);
      const user = usersStore.read().find(u => u.email === String(email || '').toLowerCase());
      if (!user) return sendJson(res, 200, { ok: true }); // don't reveal which emails exist
      if (!user.phone) return sendJson(res, 400, { error: 'This account has no phone number on file. Please contact us for help.' });
      if (!twilioConfigured()) return sendJson(res, 503, { error: 'Text messaging is not set up yet. Please contact us and we will help you reset your password.' });
      smsCodesPrune();
      const existing = smsCodeStore.read().find(r => r.userId === user.id && r.purpose === 'reset');
      if (existing && Date.now() - new Date(existing.createdAt).getTime() < 60000)
        return sendJson(res, 429, { error: 'A code was just sent. Please wait a minute before requesting another.' });
      const code = sixDigitCode();
      const salt = crypto.randomBytes(16).toString('hex');
      const rows = smsCodeStore.read().filter(r => !(r.userId === user.id && r.purpose === 'reset'));
      rows.push({ id: crypto.randomUUID(), userId: user.id, purpose: 'reset', codeHash: hashSmsCode(code, salt), salt, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0, createdAt: new Date().toISOString() });
      smsCodeStore.write(rows);
      const sms = await sendSms(user.phone, `Mobile Mechanic Network: your password reset code is ${code}. It expires in 10 minutes.`);
      if (!sms.sent) return sendJson(res, 502, { error: 'Could not send the text. Please try again.' });
      return sendJson(res, 200, { ok: true, maskedPhone: maskPhone(user.phone) });
    }
    if (p === '/api/reset-password' && req.method === 'POST') {
      const { email, code, newPassword } = await parseBody(req);
      if (!newPassword || String(newPassword).length < 8)
        return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
      const users = usersStore.read();
      const user = users.find(u => u.email === String(email || '').toLowerCase());
      smsCodesPrune();
      const rows = smsCodeStore.read();
      const row = user && rows.find(r => r.userId === user.id && r.purpose === 'reset');
      if (!user || !row) return sendJson(res, 400, { error: 'That code is invalid or has expired.' });
      if (!safeCodeEqual(hashSmsCode(code, row.salt), row.codeHash)) {
        row.attempts += 1;
        if (row.attempts >= 5) {
          smsCodeStore.write(rows.filter(r => r.id !== row.id));
          return sendJson(res, 400, { error: 'Too many wrong codes. Please request a new one.' });
        }
        smsCodeStore.write(rows);
        return sendJson(res, 400, { error: 'That code is not correct. Try again.' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      user.salt = salt;
      user.passwordHash = hashPassword(String(newPassword), salt);
      usersStore.write(users);
      smsCodeStore.write(rows.filter(r => r.id !== row.id));
      return sendJson(res, 200, { ok: true });
    }

    // ---------- SMS two-factor authentication ----------
    if (p === '/api/2fa/enroll' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const users = usersStore.read();
      const row = users.find(u => u.id === user.id);
      if (!row) return sendJson(res, 404, { error: 'Not found.' });
      if (row.twoFactorEnabled) return sendJson(res, 400, { error: 'Two-factor authentication is already on.' });
      if (!row.phone) return sendJson(res, 400, { error: 'Add a phone number to your account first.' });
      if (!twilioConfigured()) return sendJson(res, 503, { error: 'Text messaging is not set up yet.' });
      smsCodesPrune();
      const code = sixDigitCode();
      const salt = crypto.randomBytes(16).toString('hex');
      const rows = smsCodeStore.read().filter(r => !(r.userId === row.id && r.purpose === 'enroll'));
      rows.push({ id: crypto.randomUUID(), userId: row.id, purpose: 'enroll', codeHash: hashSmsCode(code, salt), salt, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0, createdAt: new Date().toISOString() });
      smsCodeStore.write(rows);
      const sms = await sendSms(row.phone, `Mobile Mechanic Network: your verification code is ${code}. It expires in 10 minutes.`);
      if (!sms.sent) return sendJson(res, 502, { error: 'Could not send the text. Please try again.' });
      return sendJson(res, 200, { ok: true, maskedPhone: maskPhone(row.phone) });
    }
    if (p === '/api/2fa/confirm' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const { code } = await parseBody(req);
      smsCodesPrune();
      const rows = smsCodeStore.read();
      const row = rows.find(r => r.userId === user.id && r.purpose === 'enroll');
      if (!row) return sendJson(res, 400, { error: 'No verification in progress. Start again.' });
      if (!safeCodeEqual(hashSmsCode(code, row.salt), row.codeHash)) {
        row.attempts += 1;
        if (row.attempts >= 5) {
          smsCodeStore.write(rows.filter(r => r.id !== row.id));
          return sendJson(res, 400, { error: 'Too many wrong codes. Start again.' });
        }
        smsCodeStore.write(rows);
        return sendJson(res, 400, { error: 'That code is not correct. Try again.' });
      }
      const users = usersStore.read();
      const urow = users.find(u => u.id === user.id);
      const backupCodes = newBackupCodes();
      urow.twoFactorEnabled = true;
      urow.twoFactorBackupCodes = backupCodes.map(c => hashSmsCode(c.replace(/-/g, ''), urow.salt));
      usersStore.write(users);
      smsCodeStore.write(rows.filter(r => r.id !== row.id));
      return sendJson(res, 200, { ok: true, backupCodes });
    }
    if (p === '/api/2fa/disable' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const { password } = await parseBody(req);
      const users = usersStore.read();
      const row = users.find(u => u.id === user.id);
      if (!row || !verifyPassword(row, String(password || ''))) return sendJson(res, 401, { error: 'Password is incorrect.' });
      row.twoFactorEnabled = false;
      row.twoFactorBackupCodes = [];
      usersStore.write(users);
      return sendJson(res, 200, { ok: true });
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
      if (phone !== undefined) {
        const e164 = normalizePhone(phone);
        if (!e164) return sendJson(res, 400, { error: 'A valid 10-digit US phone number is required.' });
        row.phone = e164;
      }
      usersStore.write(users);
      return sendJson(res, 200, { user: publicUser(row) });
    }

    // ---------- Owner vehicles ----------
    // Wikimedia Commons photo for a vehicle: real, freely licensed photos of
    // the actual model. FRONT views only: rear/trunk/back shots are rejected,
    // front-titled shots rank first, side shots rank last.
    async function commonsVehiclePhoto(year, make, model) {
      const skip = /badge|interior|engine|wheel|detail|dashboard|headlight|taillight|tail light|charging|emblem|grille|logo|key|seat|bumper|\brear\b|\btrunk\b|tailgate|back view|rear view|rear end|from behind/i;
      const queries = [];
      if (year) queries.push({ q: year + ' ' + make + ' ' + model + ' front', requireYear: true });
      queries.push({ q: make + ' ' + model + ' front', requireYear: false });
      if (year) queries.push({ q: year + ' ' + make + ' ' + model, requireYear: false });
      queries.push({ q: make + ' ' + model, requireYear: false });
      for (const { q, requireYear } of queries) {
        try {
          const api = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=' + encodeURIComponent(q) + '&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url&iiurlwidth=400&format=json';
          const r = await fetch(api, { headers: { 'User-Agent': 'MobileMechanicNetwork/1.0 (contact: legal@mobilemechanicsinmyarea.com)' }, signal: AbortSignal.timeout(8000) });
          if (!r.ok) continue;
          const d = await r.json();
          const pages = Object.values((d.query && d.query.pages) || {});
          const good = pages.filter(pg => {
            const t = String(pg.title || '').replace(/^File:/i, '');
            if (skip.test(t)) return false;
            if (requireYear && !t.includes(String(year))) return false;
            if (!/\.(jpg|jpeg|png|webp|gif|svg)$/i.test(t)) return false;
            const low = t.toLowerCase();
            if (!low.includes(make.toLowerCase()) || !low.includes(model.toLowerCase())) return false;
            const ii = (pg.imageinfo || [])[0];
            return ii && ii.thumburl && ii.descriptionurl;
          });
          if (!good.length) continue;
          const score = (t) => {
            let s = 0;
            const low = t.toLowerCase();
            if (low.includes(make.toLowerCase()) && low.includes(model.toLowerCase())) s += 20;
            if (/\bfront\b/i.test(t)) s += 10;
            if (/three-quarter|three quarter/i.test(t)) s += 5;
            if (year && t.toLowerCase().startsWith(String(year).toLowerCase())) s += 5;
            if (/\bside\b/i.test(t)) s -= 3;
            return s;
          };
          good.sort((a, b) => score(String(b.title).replace(/^File:/i, '')) - score(String(a.title).replace(/^File:/i, '')));
          const ii = good[0].imageinfo[0];
          return { url: ii.thumburl, page: ii.descriptionurl, kind: 'vehicle' };
        } catch (e) { /* try the next query */ }
      }
      // Fallback: the make's logo when no photo of the vehicle itself exists.
      try {
        const api = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=' + encodeURIComponent(make + ' logo') + '&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url&iiurlwidth=400&format=json';
        const r = await fetch(api, { headers: { 'User-Agent': 'MobileMechanicNetwork/1.0 (contact: legal@mobilemechanicsinmyarea.com)' }, signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const d = await r.json();
          const pages = Object.values((d.query && d.query.pages) || {});
          const logoSkip = /dealership|dealer|sign|store|building|factory|racing|motorsport|history|vintage|old logo/i;
          const good = pages.filter(pg => {
            const t = String(pg.title || '').replace(/^File:/i, '');
            if (logoSkip.test(t)) return false;
            if (!/\.(jpg|jpeg|png|webp|gif|svg)$/i.test(t)) return false;
            const ii = (pg.imageinfo || [])[0];
            return ii && ii.thumburl && ii.descriptionurl;
          });
          if (good.length) {
            const lscore = (t) => {
              const base = t.replace(/\.(svg|png|jpg|jpeg|webp|gif)$/i, '').toLowerCase();
              let s = 0;
              if (base === make.toLowerCase() + ' logo') s += 20;
              else if (base.startsWith(make.toLowerCase() + ' logo')) s += 10;
              if (/\.svg$/i.test(t)) s += 5;
              return s;
            };
            good.sort((a, b) => lscore(String(b.title).replace(/^File:/i, '')) - lscore(String(a.title).replace(/^File:/i, '')));
            const ii = good[0].imageinfo[0];
            return { url: ii.thumburl, page: ii.descriptionurl, kind: 'logo' };
          }
        }
      } catch (e) {}
      return null;
    }
    if (p === '/api/vehicles/me' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'owner') return sendJson(res, 403, { error: 'Vehicle owners only.' });
      // Retroactive garage fill: vehicles from requests sent before the
      // account existed (claimed at signup) are added on first view, so
      // accounts created before the garage save existed get them too.
      if (user.createdAt) {
        try {
          const pre = requestsStore.read().filter(r => r.ownerId === user.id && r.createdAt && r.createdAt < user.createdAt);
          if (pre.length) {
            const mine = vehiclesStore.read();
            let added = false;
            for (const r of pre) {
              const gv = vehicleFromRequest(r);
              if (!gv) continue;
              const dup = mine.some(v => v.ownerId === user.id && v.year === gv.year && v.make.toLowerCase() === gv.make.toLowerCase() && v.model.toLowerCase() === gv.model.toLowerCase() && v.type === gv.type);
              if (dup) continue;
              mine.push({ id: crypto.randomUUID(), ownerId: user.id, ...gv, createdAt: new Date().toISOString() });
              added = true;
            }
            if (added) vehiclesStore.write(mine);
          }
        } catch (e) {}
      }
      // Lazy Commons photos, rule v2 (front views only): one lookup per
      // photo-less vehicle, remembered via photoRule so a miss is not
      // retried on every view. Vehicles picked under the old rule are
      // re-picked once so rear shots get replaced.
      let mine = vehiclesStore.read().filter(v => v.ownerId === user.id);
      const unchecked = mine.filter(v => !v.photoUrl && v.photoRule !== 2);
      if (unchecked.length) {
        const results = await Promise.all(unchecked.map(async (v) => ({ v, found: await commonsVehiclePhoto(v.year, v.make, v.model) })));
        const all = vehiclesStore.read();
        let changed = false;
        for (const { v, found } of results) {
          const row = all.find(x => x.id === v.id);
          if (!row) continue;
          row.photoChecked = true;
          row.photoRule = 2;
          if (found) { row.autoPhotoUrl = found.url; row.autoPhotoPage = found.page; row.photoKind = found.kind || 'vehicle'; }
          else { row.autoPhotoUrl = null; row.autoPhotoPage = null; row.photoKind = null; }
          changed = true;
        }
        if (changed) vehiclesStore.write(all);
        mine = all.filter(v => v.ownerId === user.id);
      }
      return sendJson(res, 200, { vehicles: mine.map(v => ({ ...v, photoUrl: v.photoUrl || v.autoPhotoUrl || null, photoSource: v.photoUrl ? 'upload' : (v.autoPhotoUrl ? 'commons' : null), photoPage: v.photoUrl ? null : (v.autoPhotoPage || null), photoKind: v.photoUrl ? 'upload' : (v.autoPhotoUrl ? (v.photoKind || 'vehicle') : null) })) });
    }
    if (p === '/api/vehicles' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'owner') return sendJson(res, 403, { error: 'Vehicle owners only.' });
      const { year, make, model, type } = await parseBody(req);
      if (!year || !make || !model) return sendJson(res, 400, { error: 'Year, make, and model are required.' });
      const vehicles = vehiclesStore.read();
      const v = { id: crypto.randomUUID(), ownerId: user.id, year: String(year).trim().slice(0, 10), make: String(make).trim().slice(0, 60), model: String(model).trim().slice(0, 60), type: VTYPES.includes(type) ? type : 'car', createdAt: new Date().toISOString() };
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
    const vehiclePhoto = p.match(/^\/api\/vehicles\/([0-9a-f-]+)\/photo$/);
    if (vehiclePhoto && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const vehicles = vehiclesStore.read();
      const row = vehicles.find(v => v.id === vehiclePhoto[1] && v.ownerId === user.id);
      if (!row) return sendJson(res, 404, { error: 'Not found.' });
      let parts;
      try { parts = await parseMultipart(req); } catch (e) { return sendJson(res, 400, { error: 'Upload failed.' }); }
      const filePart = parts.find(x => x.filename);
      if (!filePart) return sendJson(res, 400, { error: 'Choose a photo to upload.' });
      const allowed = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
      const ext = allowed[filePart.contentType];
      if (!ext) return sendJson(res, 400, { error: 'Only JPG, PNG, WebP or GIF images.' });
      if (filePart.data.length > 5 * 1024 * 1024) return sendJson(res, 400, { error: 'Image must be under 5 MB.' });
      const dir = path.join(DATA_DIR, 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(dir)) if (f.startsWith(row.id + '-photo.')) fs.unlinkSync(path.join(dir, f));
      const fname = row.id + '-photo.' + ext;
      fs.writeFileSync(path.join(dir, fname), filePart.data);
      row.photoUrl = '/uploads/' + fname;
      vehiclesStore.write(vehicles);
      return sendJson(res, 200, { url: row.photoUrl });
    }
    const vehiclePhotoRemove = p.match(/^\/api\/vehicles\/([0-9a-f-]+)\/photo\/remove$/);
    if (vehiclePhotoRemove && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const vehicles = vehiclesStore.read();
      const row = vehicles.find(v => v.id === vehiclePhotoRemove[1] && v.ownerId === user.id);
      if (!row) return sendJson(res, 404, { error: 'Not found.' });
      if (row.photoUrl) {
        const name = row.photoUrl.slice('/uploads/'.length);
        if (/^[A-Za-z0-9._-]+$/.test(name)) { try { fs.unlinkSync(path.join(DATA_DIR, 'uploads', name)); } catch (e) {} }
        row.photoUrl = null;
        vehiclesStore.write(vehicles);
      }
      return sendJson(res, 200, {});
    }

    // ---------- Mechanic business profiles + directory ----------
    if (p === '/api/business' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Only mobile mechanic accounts have a business page.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const { name, city, state, serviceCities, services, about, phone, logoUrl, coverUrl, coverPosition, socials, warranty, acceptUrgent, certifications, vehicleTypes, prices } = await parseBody(req);
      if (!name || !city || !state || !Array.isArray(services) || services.length === 0)
        return sendJson(res, 400, { error: 'Business name, city, state, and at least one service are required.' });
      const cleanServices = services.filter(s => SERVICES.includes(s));
      if (cleanServices.length === 0) return sendJson(res, 400, { error: 'Pick at least one valid service.' });
      const cleanTypes = Array.isArray(vehicleTypes) ? vehicleTypes.filter(t => VTYPES.includes(t)) : [];
      if (cleanTypes.length === 0) cleanTypes.push('car');
      const businesses = businessesStore.read();
      let biz = businesses.find(b => b.userId === user.id);
      const bizState = String(state).trim().toUpperCase();
      const rawList = Array.isArray(serviceCities) ? serviceCities : String(serviceCities || '').split(/[\n;]+/);
      const cleanCities = [];
      const seenCity = new Set();
      for (const entry of rawList) {
        const p = parseCityState(entry, bizState);
        if (!p || !p.city) continue;
        const norm = p.city + ', ' + p.state;
        const key = norm.toLowerCase();
        if (!seenCity.has(key)) { seenCity.add(key); cleanCities.push(norm); }
      }
      const cleanSocials = {};
      if (socials && typeof socials === 'object') for (const k of ['facebook', 'instagram', 'tiktok', 'youtube', 'x', 'website', 'google']) {
        const v = String(socials[k] || '').trim().slice(0, 300);
        if (v) cleanSocials[k] = v;
      }
      const fields = { name: String(name).trim(), city: String(city).trim(), state: String(state).trim().toUpperCase(), serviceCities: cleanCities, services: cleanServices, vehicleTypes: cleanTypes, about: String(about || ''), phone: String(phone || '').trim(), socials: cleanSocials, warranty: String(warranty || '').trim().slice(0, 2000), acceptUrgent: acceptUrgent === true, certifications: cleanCertifications(certifications), ...(prices !== undefined ? { prices: cleanPrices(prices, cleanServices) } : {}) };
      const cpm = String(coverPosition || '').trim().match(/^(\d{1,3}(?:\.\d+)?)% (\d{1,3}(?:\.\d+)?)%$/);
      if (cpm) fields.coverPosition = Math.min(100, Math.max(0, Math.round(parseFloat(cpm[1])))) + '% ' + Math.min(100, Math.max(0, Math.round(parseFloat(cpm[2])))) + '%';
      if (typeof logoUrl === 'string' && logoUrl.startsWith('/uploads/')) fields.logoUrl = logoUrl;
      if (typeof coverUrl === 'string' && coverUrl.startsWith('/uploads/')) fields.coverUrl = coverUrl;
      if (biz) Object.assign(biz, fields); else { biz = { id: crypto.randomUUID(), userId: user.id, createdAt: new Date().toISOString(), ...fields }; businesses.push(biz); }
      businessesStore.write(businesses);
      return sendJson(res, 200, { business: publicBusiness(biz) });
    }
    if (p === '/api/business/cover-position' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const businesses = businessesStore.read();
      const biz = businesses.find(b => b.userId === user.id);
      if (!biz) return sendJson(res, 404, { error: 'No business profile.' });
      const { coverPosition } = await parseBody(req);
      const m = String(coverPosition || '').trim().match(/^(\d{1,3}(?:\.\d+)?)% (\d{1,3}(?:\.\d+)?)%$/);
      if (!m) return sendJson(res, 400, { error: 'Invalid position.' });
      biz.coverPosition = Math.min(100, Math.max(0, Math.round(parseFloat(m[1])))) + '% ' + Math.min(100, Math.max(0, Math.round(parseFloat(m[2])))) + '%';
      businessesStore.write(businesses);
      return sendJson(res, 200, { coverPosition: biz.coverPosition });
    }
    if (p === '/api/business/me' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const biz = myBusiness(user.id);
      return sendJson(res, 200, { business: biz ? { ...publicBusiness(biz), promotion: latestPromotion(biz.id) } : null });
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
      let list = businessesStore.read().filter(b => !frozenIds.has(b.userId));
      if (state) list = list.filter(b => b.state.toLowerCase() === state);
      if (city) {
        const ck = state ? city + '|' + state.toUpperCase() : null;
        list = list.filter(b => b.city.toLowerCase() === city || (ck && servedCityKeys(b).includes(ck)));
      }
      if (service) list = list.filter(b => b.services.includes(service));
      const vtype = url.searchParams.get('type') || 'car';
      if (VTYPES.includes(vtype)) {
        list = list.filter(b => (Array.isArray(b.vehicleTypes) && b.vehicleTypes.length ? b.vehicleTypes : ['car']).includes(vtype));
      }
      return sendJson(res, 200, { mechanics: list.map(b => ({ ...publicBusiness(b), promotion: latestPromotion(b.id) })) });
    }
    if (p === '/api/business/public' && req.method === 'GET') {
      const id = String(url.searchParams.get('id') || '');
      const biz = businessesStore.read().find(b => b.id === id);
      if (!biz) return sendJson(res, 404, { error: 'Business not found.' });
      const owner = usersStore.read().find(u => u.id === biz.userId);
      if (mechanicFrozen(owner)) return sendJson(res, 404, { error: 'Business not found.' });
      return sendJson(res, 200, { business: { ...publicBusiness(biz), promotion: latestPromotion(biz.id) } });
    }
    if (p === '/api/services' && req.method === 'GET') return sendJson(res, 200, { services: SERVICES });
    if (p === '/api/cities' && req.method === 'GET') {
      return sendJson(res, 200, { cities: searchCities(url.searchParams.get('q'), url.searchParams.get('state'), url.searchParams.get('limit')) });
    }
    if (p === '/api/vehicles/years' && req.method === 'GET') {
      return sendJson(res, 200, { years: vehicleYears() });
    }
    if (p === '/api/vehicles/makes' && req.method === 'GET') {
      return sendJson(res, 200, { makes: vehicleMakes(url.searchParams.get('year'), url.searchParams.get('type')) });
    }
    if (p === '/api/vehicles/models' && req.method === 'GET') {
      return sendJson(res, 200, { models: vehicleModels(url.searchParams.get('year'), url.searchParams.get('make'), url.searchParams.get('type')) });
    }

    // ---------- Quote requests ----------
    if (p === '/api/requests' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (user && user.role !== 'owner') return sendJson(res, 403, { error: 'Only vehicle owner accounts can request quotes.' });
      const { city, state, service, vehicle, description, phone, date, vin, urgent, zip, businessId, vehicleType, vehicleYear, vehicleMake, vehicleModel, name, fromProfile } = await parseBody(req);
      const e164 = normalizePhone(phone);
      if (!city || !state || !SERVICES.includes(service) || !vehicle || !description || !e164)
        return sendJson(res, 400, { error: 'City, state, service, vehicle, a description, and a valid 10-digit phone number are required.' });
      const vt = VTYPES.includes(vehicleType) ? vehicleType : 'car';
      const guest = !user;
      if (guest && !guestRateOk(req)) return sendJson(res, 429, { error: 'Too many requests from this device. Please wait a bit before sending another.' });
      let targetBiz = null;
      if (businessId) {
        targetBiz = businessesStore.read().find(b => b.id === String(businessId));
        if (!targetBiz) return sendJson(res, 400, { error: 'That mechanic is no longer available.' });
        const tOwner = usersStore.read().find(u => u.id === targetBiz.userId);
        if (mechanicFrozen(tOwner)) return sendJson(res, 400, { error: 'That mechanic is no longer available.' });
        const tTypes = Array.isArray(targetBiz.vehicleTypes) && targetBiz.vehicleTypes.length ? targetBiz.vehicleTypes : ['car'];
        if (!tTypes.includes(vt)) return sendJson(res, 400, { error: 'That mechanic does not service ' + (VTYPE_LABELS[vt] || 'cars and trucks') + '.' });
      }
      let cleanVinValue = '';
      if (vin && String(vin).trim()) {
        cleanVinValue = cleanVin(vin);
        if (!cleanVinValue) return sendJson(res, 400, { error: 'VIN must be 17 characters (letters and numbers, no I, O, or Q).' });
      }
      const setPrice = (fromProfile === true && targetBiz && Array.isArray(targetBiz.prices)) ? (targetBiz.prices.find(pr => pr.service === service) || {}).price : null;
      const rows = requestsStore.read();
      const row = { id: crypto.randomUUID(), ownerId: user ? user.id : null, ownerName: user ? user.name : String(name || '').trim().slice(0, 100), guest: guest || undefined, phone: e164, city: String(city).trim(), state: String(state).trim().toUpperCase(), service, vehicle: String(vehicle).trim(), vehicleType: vt, vehicleYear: String(vehicleYear || '').slice(0, 10), vehicleMake: String(vehicleMake || '').slice(0, 60), vehicleModel: String(vehicleModel || '').slice(0, 60), vin: cleanVinValue, description: String(description).trim(), date: String(date || '').slice(0, 20), zip: String(zip || '').slice(0, 10), status: 'open', urgent: urgent === true, businessId: targetBiz ? targetBiz.id : null, ...(setPrice != null ? { setPrice } : {}), createdAt: new Date().toISOString() };
      rows.push(row); requestsStore.write(rows);
      const recipients = targetBiz ? [targetBiz] : businessesStore.read().filter(b => requestMatchesBusiness(row, b));
      // A request sitting silently in the inbox is not a notification.
      // Every matched mechanic gets a portal notification (and a text
      // when Twilio is configured). Neither may fail the request itself.
      try {
        const notes = notificationsStore.read();
        const users = usersStore.read();
        for (const biz of recipients) {
          notes.push({ id: crypto.randomUUID(), userId: biz.userId, type: 'request_received', title: (row.urgent ? 'URGENT — ' : '') + (row.ownerName ? `${row.ownerName} requested a quote` : 'New quote request'), service: row.service, vehicle: row.vehicle || '', customerName: row.ownerName || '', customerPhone: row.phone || '', requestId: row.id, urgent: row.urgent === true, read: false, createdAt: new Date().toISOString() });
          const mechUser = users.find(u => u.id === biz.userId);
          const to = (mechUser && mechUser.phone) || biz.phone || '';
          const d = String(row.phone || '').replace(/\D/g, '');
          const c = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
          const custPhone = c.length === 10 ? `(${c.slice(0, 3)}) ${c.slice(3, 6)}-${c.slice(6)}` : (row.phone || '');
          if (to) sendSms(to, `Mobile Mechanic Network: New quote request for ${row.service} (${row.vehicle}) in ${row.city}, ${row.state}. Customer phone: ${custPhone}. View it here: https://mobilemechanicsinmyarea.com/mechanic`);
        }
        notificationsStore.write(notes);
      } catch (e) {}
      return sendJson(res, 201, { request: row, mechanicsNotified: recipients.length });
    }
    if (p === '/api/requests/mine' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const quotes = quotesStore.read();
      const reviews = reviewsStore.read();
      const tickets = ticketsStore.read();
      const mine = requestsStore.read().filter(r => r.ownerId === user.id).map(r => {
        const reqBiz = r.businessId ? businessesStore.read().find(b => b.id === r.businessId) : null;
        const pendEst = tickets.find(t => t.requestId === r.id && t.type === 'invoice' && t.estimateStatus === 'pending');
        const inv = tickets.find(t => t.requestId === r.id && t.type === 'invoice');
        const pendTotals = pendEst ? invoiceTotalsAfter(pendEst, pendEst.estimateLines || []) : null;
        const jobTicket = tickets.find(t => t.requestId === r.id && (t.type === 'invoice' || t.type === 'receipt'));
        return {
          ...r,
          reviewed: reviews.some(x => x.requestId === r.id),
          paid: tickets.some(t => t.requestId === r.id && t.type === 'receipt'),
          ticketId: jobTicket ? jobTicket.id : null,
          ticketTotal: jobTicket ? jobTicket.total : null,
          pendingEstimate: pendEst ? { ticketId: pendEst.id, lines: (pendEst.estimateLines || []).map((l, i) => ({ desc: l.desc, price: l.price, newTotal: pendTotals.perLineNewTotals[i] })), total: pendTotals.pendingTotal, approvedTotal: pendTotals.approvedTotal, newTotalAll: pendTotals.newTotalAll } : null,
          businessName: reqBiz ? reqBiz.name : '',
          businessCity: reqBiz ? `${reqBiz.city}, ${reqBiz.state}` : '',
          businessLogo: reqBiz && reqBiz.logoUrl ? reqBiz.logoUrl : '',
          businessPhone: reqBiz ? (reqBiz.phone || '') : '',
          quotes: quotes.filter(q => q.requestId === r.id).map(q => {
            const biz = businessesStore.read().find(b => b.id === q.businessId);
            let extra = {};
            if (q.followUp && q.status === 'pending' && inv) {
              const nl = (q.items || []).map(it => ({ desc: String(it.desc || '').trim().slice(0, 200), price: Math.round(Math.max(0, Number(it.amount) || 0) * 100) / 100 })).filter(it => it.desc && it.price > 0);
              if (!nl.length && Number(q.total) > 0) nl.push({ desc: r.service, price: Math.round(Number(q.total) * 100) / 100 });
              const ft = invoiceTotalsAfter(inv, nl);
              extra = { approvedTotal: ft.approvedTotal, newTotalIfApproved: ft.newTotalAll };
            }
            return { ...q, businessName: biz ? biz.name : 'Mobile mechanic', businessCity: biz ? `${biz.city}, ${biz.state}` : '', businessLogo: biz && biz.logoUrl ? biz.logoUrl : '', businessPhone: biz ? (biz.phone || '') : '', businessWarranty: biz && biz.warranty ? biz.warranty : '', ...extra };
          }),
        };
      });
      return sendJson(res, 200, { requests: mine });
    }
    if (p === '/api/requests/inbox' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const biz = myBusiness(user.id);
      if (!biz) return sendJson(res, 200, { requests: [], booked: [], needsBusiness: true });
      const quotes = quotesStore.read();
      const myTickets = ticketsStore.read().filter(t => t.mechanicId === user.id);
      const allRequests = requestsStore.read();
      const normName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      // Service history with THIS mechanic only, newest first. Platform
      // jobs: this business's accepted quotes, matched by customer phone
      // or owner account. Walk-in tickets: no phone on file, so matched
      // by customer name; only billed work (invoice/receipt), never
      // estimates, and never a quote job's own ticket (it carries a
      // requestId and is already counted via its accepted quote).
      const historyFor = (phone, ownerId, ownerName, excludeId) => {
        const jobs = [];
        for (const q of quotes) {
          if (q.businessId !== biz.id || q.status !== 'accepted') continue;
          const pr = allRequests.find(r => r.id === q.requestId);
          if (!pr || pr.id === excludeId) continue;
          const samePhone = phone && pr.phone && pr.phone === phone;
          const sameOwner = ownerId && pr.ownerId && pr.ownerId === ownerId;
          if (!samePhone && !sameOwner) continue;
          jobs.push({ service: pr.service, vehicle: pr.vehicle, date: pr.date || (pr.createdAt || '').slice(0, 10), total: q.total != null ? q.total : q.price, paid: myTickets.some(t => t.requestId === pr.id && t.type === 'receipt'), ticketId: (myTickets.find(t => t.requestId === pr.id) || {}).id || null, createdAt: pr.createdAt || '' });
        }
        const wantName = normName(ownerName);
        if (wantName) {
          for (const t of myTickets) {
            if (t.requestId || (t.type !== 'invoice' && t.type !== 'receipt')) continue;
            if (normName(t.customerName) !== wantName) continue;
            const svc = (t.items || []).map(it => it.desc).filter(Boolean).join(', ') || t.laborDesc || 'Service';
            jobs.push({ service: svc, vehicle: t.vehicle || '', date: (t.createdAt || '').slice(0, 10), total: t.total, paid: t.type === 'receipt', ticketId: t.id, createdAt: t.createdAt || '' });
          }
        }
        jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return jobs;
      };
      const inbox = allRequests
        .filter(r => r.status === 'open' && requestMatchesBusiness(r, biz))
        .map(r => { const history = historyFor(r.phone, r.ownerId, r.ownerName, r.id); return { ...r, myQuote: quotes.find(q => q.requestId === r.id && q.businessId === biz.id) || null, history, returning: history.length > 0 }; });
      const booked = allRequests
        .filter(r => r.status === 'accepted')
        .map(r => {
          const q = quotes.find(q => q.requestId === r.id && q.businessId === biz.id && q.status === 'accepted');
          if (!q) return null;
          const history = historyFor(r.phone, r.ownerId, r.ownerName, r.id);
          const jobTicket = myTickets.find(t => t.requestId === r.id);
          // Lines for the card: the ticket's lines when one exists (items
          // plus labor and tax, so they add up to the total), otherwise
          // the accepted quote's lines. Pending estimate lines are not
          // included: they are not on the invoice until approved.
          const lines = jobTicket
            ? [...(jobTicket.items || []).map(it => ({ desc: it.desc, amount: (it.qty != null && it.price != null) ? Number(it.qty) * Number(it.price) : (it.amount != null ? it.amount : it.price) })),
               ...(jobTicket.laborAmount > 0 ? [{ desc: 'Labor' + (jobTicket.laborDesc ? ' — ' + jobTicket.laborDesc : ''), amount: jobTicket.laborAmount }] : []),
               ...(jobTicket.taxAmount > 0 ? [{ desc: 'Tax (' + jobTicket.taxRate + '%)', amount: jobTicket.taxAmount }] : [])]
            : (q.items || []).map(it => ({ desc: it.desc, amount: it.amount != null ? it.amount : it.price }));
          return { id: r.id, service: r.service, vehicle: r.vehicle, vin: r.vin || '', description: r.description, city: r.city, state: r.state, ownerName: r.ownerName, ownerId: r.ownerId || null, phone: r.phone, date: r.date || '', createdAt: r.createdAt, acceptedTotal: q.total != null ? q.total : q.price, ticketTotal: jobTicket ? jobTicket.total : null, lines, hasTicket: myTickets.some(t => t.requestId === r.id), ticketId: jobTicket ? jobTicket.id : null, address: jobTicket ? (jobTicket.jobAddress || '') : '', paid: myTickets.some(t => t.requestId === r.id && t.type === 'receipt'), pendingFollowUp: quotes.find(q2 => q2.requestId === r.id && q2.businessId === biz.id && q2.status === 'pending' && q2.followUp === true) || null, history, returning: history.length > 0 };
        })
        .filter(Boolean)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return sendJson(res, 200, { requests: inbox, booked });
    }


    // ---------- Calendar: the mechanic's upcoming-jobs list ----------
    // Booked jobs appear automatically (from the inbox); manual entries
    // here cover appointments set by phone, e.g. after a quote request.
    if (p === '/api/calendar' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const biz = myBusiness(user.id);
      if (!biz) return sendJson(res, 200, { entries: [] });
      const tickets = ticketsStore.read();
      const entries = calendarStore.read().filter(e => e.businessId === biz.id && !(e.ticketId && tickets.some(t => t.id === e.ticketId && t.type === 'receipt'))).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return sendJson(res, 200, { entries });
    }
    if (p === '/api/calendar' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const biz = myBusiness(user.id);
      if (!biz) return sendJson(res, 400, { error: 'Save your business page first.' });
      const { date, title, notes, ticketId, time } = await parseBody(req);
      let ticket = null;
      let ticketReq = null;
      if (ticketId) {
        ticket = ticketsStore.read().find(x => x.id === ticketId);
        if (!ticket || ticket.businessId !== biz.id) return sendJson(res, 400, { error: 'Ticket not found.' });
        if (ticket.type === 'receipt') return sendJson(res, 400, { error: 'Paid tickets can\'t be added to the calendar.' });
        if (ticket.requestId) ticketReq = requestsStore.read().find(x => x.id === ticket.requestId) || null;
        const existing = calendarStore.read().find(e => e.businessId === biz.id && e.ticketId === ticketId);
        if (existing) return sendJson(res, 200, { entry: existing });
      }
      const d = String(date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d + 'T00:00:00Z').getTime())) return sendJson(res, 400, { error: 'Pick a valid date.' });
      const tm = String(time || '').trim();
      if (tm && !/^([01]\d|2[0-3]):[0-5]\d$/.test(tm)) return sendJson(res, 400, { error: 'Pick a valid time.' });
      if (!title || !String(title).trim()) return sendJson(res, 400, { error: 'A job title is required.' });
      const entries = calendarStore.read();
      const entry = { id: crypto.randomUUID(), businessId: biz.id, date: d, time: tm, title: String(title).trim().slice(0, 120), notes: String(notes || '').trim().slice(0, 500), createdAt: new Date().toISOString(), ...(ticket ? { ticketId: ticket.id, customerName: ticket.customerName || '', vehicle: ticket.vehicle || '', service: ticketReq ? (ticketReq.service || '') : '', location: (ticket.jobAddress || '') || (ticketReq ? [ticketReq.city, ticketReq.state].filter(Boolean).join(', ') : '') } : {}) };
      entries.push(entry); calendarStore.write(entries);
      return sendJson(res, 200, { entry });
    }
    const calDel = p.match(/^\/api\/calendar\/([0-9a-f-]+)$/);
    if (calDel && req.method === 'DELETE') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const biz = myBusiness(user.id);
      const entries = calendarStore.read();
      const idx = entries.findIndex(e => e.id === calDel[1] && biz && e.businessId === biz.id);
      if (idx === -1) return sendJson(res, 404, { error: 'Not found.' });
      entries.splice(idx, 1); calendarStore.write(entries);
      return sendJson(res, 200, {});
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
      let followUp = false;
      if (!row) return sendJson(res, 400, { error: 'That request is not open in your service area.' });
      if (row.status === 'accepted') {
        // Follow-up quote on a booked job (diagnosis findings, extra work):
        // only the mechanic whose quote was accepted may add one, and only
        // while the job is not yet paid.
        const bookedQuote = quotesStore.read().find(q => q.requestId === row.id && q.status === 'accepted');
        const receipt = ticketsStore.read().find(t => t.requestId === row.id && t.type === 'receipt');
        if (!bookedQuote || bookedQuote.businessId !== biz.id || receipt)
          return sendJson(res, 400, { error: 'Only the booked mechanic can quote additional work, and only before the job is paid.' });
        followUp = true;
      } else if (row.status !== 'open' || !requestMatchesBusiness(row, biz)) {
        return sendJson(res, 400, { error: 'That request is not open in your service area.' });
      }
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
      if (ticketsStore.read().some(t => t.requestId === requestId && t.type === 'invoice' && t.estimateStatus === 'pending'))
        return sendJson(res, 409, { error: 'An estimate is already awaiting approval for this job.' });
      const quote = { id: crypto.randomUUID(), requestId, businessId: biz.id, mechanicId: user.id, items: cleanItems, notes: String(notes || '').slice(0, 1000), total, price: total, message: String(message || ''), status: 'pending', followUp, createdAt: new Date().toISOString() };
      quotes.push(quote); quotesStore.write(quotes);
      // The customer hears about every quote: a dashboard notification
      // when they have an account, plus a text to the request phone.
      // Never fails the quote itself.
      try {
        if (row.ownerId) pushOwnerNote(row.ownerId, { type: 'quote_received', title: `New quote from ${biz.name}`, service: row.service, vehicle: row.vehicle || '', total, requestId: row.id, businessName: biz.name || '' });
        await sendSms(row.phone, `Mobile Mechanic Network: New quote from ${biz.name} for ${row.service} (${row.vehicle}) — $${Number(total).toFixed(2)}.${followUp ? ' This covers additional work on your booked job.' : ''} See it in your dashboard: https://mobilemechanicsinmyarea.com/dashboard`);
      } catch (e) {}
      return sendJson(res, 201, { quote });
    }
    // Quote drafts: a mechanic's half-written quote, stored on the server
    // so it follows them to any device they sign in on. Drafts are
    // personal notes: they never reach the customer until sent as a quote.
    if (p === '/api/quote-drafts' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const biz = myBusiness(user.id);
      const quotes = quotesStore.read();
      const reqs = requestsStore.read();
      const rows = quoteDraftsStore.read().filter(d => d.userId === user.id);
      const live = rows.filter(d => {
        const row = reqs.find(r => r.id === d.requestId);
        if (!row || row.status !== 'open' || !requestMatchesBusiness(row, biz)) return false;
        if (quotes.some(q => q.requestId === d.requestId && q.businessId === biz.id && q.status === 'pending')) return false;
        return true;
      });
      if (live.length !== rows.length) quoteDraftsStore.write(quoteDraftsStore.read().filter(d => d.userId !== user.id || live.some(l => l.requestId === d.requestId)));
      return sendJson(res, 200, { drafts: live });
    }
    const draftMatch = p.match(/^\/api\/quote-drafts\/([0-9a-f-]+)$/);
    if (draftMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const biz = myBusiness(user.id);
      const requestId = draftMatch[1];
      const rows = quoteDraftsStore.read();
      const kept = rows.filter(d => !(d.userId === user.id && d.requestId === requestId));
      if (req.method === 'DELETE') { quoteDraftsStore.write(kept); return sendJson(res, 200, { ok: true }); }
      const { items, notes } = await parseBody(req);
      const row = requestsStore.read().find(r => r.id === requestId);
      if (!row || row.status !== 'open' || !requestMatchesBusiness(row, biz)) return sendJson(res, 400, { error: 'That request is not open in your service area.' });
      if (quotesStore.read().some(q => q.requestId === requestId && q.businessId === biz.id && q.status === 'pending')) return sendJson(res, 409, { error: 'You already quoted this request.' });
      let cleanItems = [];
      if (Array.isArray(items)) for (const it of items.slice(0, 50)) {
        const desc = String((it && it.desc) || '').trim().slice(0, 200);
        const amount = Math.round(Number(it && it.amount) * 100) / 100;
        if (desc && amount > 0) cleanItems.push({ desc, amount });
      }
      const cleanNotes = String(notes || '').slice(0, 1000);
      if (!cleanItems.length && !cleanNotes.trim()) { quoteDraftsStore.write(kept); return sendJson(res, 200, { ok: true, cleared: true }); }
      kept.push({ userId: user.id, requestId, items: cleanItems, notes: cleanNotes, updatedAt: new Date().toISOString() });
      quoteDraftsStore.write(kept);
      return sendJson(res, 200, { ok: true });
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
      const isFollowUp = row.status === 'accepted' && quote.followUp === true;
      if (quote.status !== 'pending' || (row.status !== 'open' && !isFollowUp)) return sendJson(res, 400, { error: 'That quote can no longer be changed.' });
      if (quoteAction[2] === 'accept') {
        quote.status = 'accepted';
        let autoTicket = null;
        if (isFollowUp) {
          // Additional work the customer approved: append it to the job's
          // invoice. Existing lines never change price; only approved
          // additions land on the invoice.
          const tickets = ticketsStore.read();
          const r2 = n => Math.round(n * 100) / 100;
          const inv = tickets.find(t => t.requestId === row.id && t.businessId === quote.businessId && t.type === 'invoice');
          const newLines = (quote.items || [])
            .map(it => ({ desc: String(it.desc || '').trim().slice(0, 200), qty: 1, price: r2(Math.max(0, Number(it.amount) || 0)) }))
            .filter(it => it.desc && it.price > 0);
          if (!newLines.length && Number(quote.total) > 0) newLines.push({ desc: row.service, qty: 1, price: r2(Number(quote.total)) });
          if (inv) {
            inv.items = [...(inv.items || []), ...newLines];
            const parts = r2(inv.items.reduce((s, it) => s + it.qty * it.price, 0));
            inv.subtotal = parts;
            inv.taxAmount = r2(r2(parts + (inv.laborAmount || 0)) * (inv.taxRate || 0) / 100);
            inv.total = r2(parts + (inv.laborAmount || 0) + inv.taxAmount);
            ticketsStore.write(tickets); autoTicket = inv;
          } else {
            const built = ticketFromAcceptedQuote(quote, row);
            if (built) { tickets.push(built); ticketsStore.write(tickets); autoTicket = built; }
          }
        } else {
          row.status = 'accepted';
          quotes.forEach(q => { if (q.requestId === row.id && q.id !== quote.id && q.status === 'pending') q.status = 'declined'; });
          // An accepted quote becomes the invoice directly: no estimate step.
          const built = ticketFromAcceptedQuote(quote, row);
          if (built) { const tickets = ticketsStore.read(); tickets.push(built); ticketsStore.write(tickets); autoTicket = built; }
        }
        quotesStore.write(quotes); requestsStore.write(rows);
        // Notify the mechanic: an acceptance is only useful if the
        // mechanic hears about it. SMS when Twilio is configured; the
        // accept itself never fails because of a text.
        let mechanicNotified = false;
        try {
          const mechUser = usersStore.read().find(u => u.id === quote.mechanicId);
          const biz = businessesStore.read().find(b => b.id === quote.businessId);
          const to = (mechUser && mechUser.phone) || (biz && biz.phone) || '';
          if (to) {
            const d = String(row.phone || '').replace(/\D/g, '');
            const c = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
            const custPhone = c.length === 10 ? `(${c.slice(0, 3)}) ${c.slice(3, 6)}-${c.slice(6)}` : (row.phone || '');
            const total = quote.total != null ? quote.total : quote.price;
            const sms = await sendSms(to, `Mobile Mechanic Network: ${row.ownerName || 'A customer'} accepted your ${isFollowUp ? 'additional ' : ''}quote for ${row.service} (${row.vehicle}) — $${Number(total).toFixed(2)}. Customer phone: ${custPhone}. See it here: https://mobilemechanicsinmyarea.com/mechanic`);
            mechanicNotified = sms.sent === true;
          }
        } catch (e) {}
        // In-portal notification for the mechanic, so the acceptance is
        // waiting on their profile even before they open a text.
        try {
          const notes = notificationsStore.read();
          notes.push({ id: crypto.randomUUID(), userId: quote.mechanicId, type: 'quote_accepted', title: `${row.ownerName || 'A customer'} accepted your ${isFollowUp ? 'additional ' : ''}quote`, service: row.service, vehicle: row.vehicle || '', total: quote.total != null ? quote.total : quote.price, customerName: row.ownerName || '', customerPhone: row.phone || '', requestId: row.id, quoteId: quote.id, read: false, createdAt: new Date().toISOString() });
          notificationsStore.write(notes);
        } catch (e) {}
        return sendJson(res, 200, { quote, requestStatus: row.status, ticket: autoTicket, mechanicNotified });
      } else {
        quote.status = 'declined';
        // A declined follow-up quote is denied extra work: keep it on the
        // job's invoice as denied repairs so the receipt shows it, never
        // charged. (Initial-quote declines have no invoice yet: skipped.)
        if (quote.followUp) {
          const tickets = ticketsStore.read();
          const inv = tickets.find(x => x.requestId === row.id && x.businessId === quote.businessId && x.type === 'invoice');
          if (inv) {
            const dl = (quote.items || []).map(it => ({ desc: String(it.desc || '').trim().slice(0, 200), price: Math.round(Math.max(0, Number(it.amount) || 0) * 100) / 100 })).filter(l => l.desc && l.price > 0);
            if (!dl.length && Number(quote.total) > 0) dl.push({ desc: row.service, price: Math.round(Number(quote.total) * 100) / 100 });
            if (dl.length) { inv.deniedLines = [...(inv.deniedLines || []), ...dl]; ticketsStore.write(tickets); }
          }
        }
      }
      quotesStore.write(quotes); requestsStore.write(rows);
      return sendJson(res, 200, { quote, requestStatus: row.status });
    }

    // ---------- Mechanic notifications ----------
    if (p === '/api/notifications' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (!['mechanic', 'owner'].includes(user.role)) return sendJson(res, 403, { error: 'Not allowed.' });
      const notes = notificationsStore.read().filter(n => n.userId === user.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return sendJson(res, 200, { notifications: notes, unread: notes.filter(n => !n.read).length });
    }
    if (p === '/api/notifications/read' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (!['mechanic', 'owner'].includes(user.role)) return sendJson(res, 403, { error: 'Not allowed.' });
      const notes = notificationsStore.read();
      let changed = false;
      for (const n of notes) if (n.userId === user.id && !n.read) { n.read = true; changed = true; }
      if (changed) notificationsStore.write(notes);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/notifications/clear' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (!['mechanic', 'owner'].includes(user.role)) return sendJson(res, 403, { error: 'Not allowed.' });
      notificationsStore.write(notificationsStore.read().filter(n => n.userId !== user.id));
      return sendJson(res, 200, { ok: true });
    }

    // ---------- Help requests ----------
    if (p === '/api/help' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const { subject, message } = await parseBody(req);
      if (!message || !String(message).trim()) return sendJson(res, 400, { error: 'Describe the issue.' });
      const rows = helpStore.read();
      const row = { id: crypto.randomUUID(), userId: user.id, name: user.name, email: user.email, role: user.role, subject: String(subject || '').trim().slice(0, 120), message: String(message).trim().slice(0, 2000), status: 'open', createdAt: new Date().toISOString() };
      rows.push(row); helpStore.write(rows);
      return sendJson(res, 201, { ok: true });
    }
    const adminHelp = p.match(/^\/api\/admin\/help\/([0-9a-f-]+)$/);
    if (adminHelp && req.method === 'POST') {
      if (!adminAuthed(req)) return sendJson(res, 401, { error: 'Not authorized.' });
      const { resolved } = await parseBody(req);
      const rows = helpStore.read();
      const h = rows.find(x => x.id === adminHelp[1]);
      if (!h) return sendJson(res, 404, { error: 'Not found.' });
      h.status = resolved ? 'resolved' : 'open';
      helpStore.write(rows);
      return sendJson(res, 200, { ok: true });
    }

    // ---------- Earnings stats ----------
    if (p === '/api/stats' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const r2s = n => Math.round(Number(n || 0) * 100) / 100;
      const quotes = quotesStore.read().filter(q => q.mechanicId === user.id);
      const tickets = ticketsStore.read().filter(t => t.mechanicId === user.id);
      const receipts = tickets.filter(t => t.type === 'receipt');
      const invoices = tickets.filter(t => t.type === 'invoice');
      const totalIncome = r2s(receipts.reduce((s, t) => s + (Number(t.total) || 0), 0));
      const outstanding = r2s(invoices.reduce((s, t) => s + (Number(t.total) || 0), 0));
      const byMonth = {};
      receipts.forEach(t => {
        const m = String(t.paidAt || t.createdAt || '').slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(m)) return;
        byMonth[m] = byMonth[m] || { income: 0, jobs: 0 };
        byMonth[m].income = r2s(byMonth[m].income + (Number(t.total) || 0));
        byMonth[m].jobs++;
      });
      const months = Object.keys(byMonth).sort().reverse().map(m => ({ month: m, income: byMonth[m].income, jobs: byMonth[m].jobs }));
      const accepted = quotes.filter(q => q.status === 'accepted').length;
      return sendJson(res, 200, {
        quotesSent: quotes.length,
        quotesAccepted: accepted,
        acceptanceRate: quotes.length ? Math.round(accepted / quotes.length * 100) : 0,
        jobsCompleted: receipts.length,
        totalIncome,
        outstanding,
        avgJobValue: receipts.length ? r2s(totalIncome / receipts.length) : 0,
        byMonth: months,
        recent: receipts.slice().sort((a, b) => String(b.paidAt || b.createdAt).localeCompare(String(a.paidAt || a.createdAt))).slice(0, 10)
          .map(t => ({ customerName: t.customerName, vehicle: t.vehicle, total: t.total, paidAt: t.paidAt, paymentMethod: t.paymentMethod || '' })),
      });
    }

    // ---------- Reviews ----------
    if (p === '/api/reviews' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'owner') return sendJson(res, 403, { error: 'Only vehicle owner accounts can leave reviews.' });
      const { requestId, rating, text } = await parseBody(req);
      const r = Math.round(Number(rating));
      if (!requestId || !(r >= 1 && r <= 5)) return sendJson(res, 400, { error: 'A star rating from 1 to 5 is required.' });
      const row = requestsStore.read().find(x => x.id === String(requestId));
      if (!row || row.ownerId !== user.id) return sendJson(res, 404, { error: 'Job not found.' });
      const paid = ticketsStore.read().some(t => t.requestId === row.id && t.type === 'receipt');
      if (!paid) return sendJson(res, 400, { error: 'You can review a job once it is paid.' });
      const reviews = reviewsStore.read();
      if (reviews.some(x => x.requestId === row.id)) return sendJson(res, 409, { error: 'You already reviewed this job.' });
      const q = quotesStore.read().find(x => x.requestId === row.id && x.status === 'accepted');
      if (!q) return sendJson(res, 400, { error: 'This job has no accepted quote yet.' });
      const rev = { id: crypto.randomUUID(), businessId: q.businessId, mechanicId: q.mechanicId, ownerId: user.id, ownerName: user.name || 'A vehicle owner', requestId: row.id, rating: r, text: String(text || '').trim().slice(0, 1000), createdAt: new Date().toISOString() };
      reviews.push(rev);
      reviewsStore.write(reviews);
      return sendJson(res, 200, { ok: true, review: rev });
    }
    if (p === '/api/reviews' && req.method === 'GET') {
      const businessId = String(url.searchParams.get('businessId') || '');
      if (!businessId) return sendJson(res, 400, { error: 'businessId is required.' });
      const list = reviewsStore.read().filter(x => x.businessId === businessId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map(x => ({ ownerName: x.ownerName, rating: x.rating, text: x.text, createdAt: x.createdAt }));
      return sendJson(res, 200, { reviews: list });
    }

    // ---------- Pre-purchase inspections ----------
    const PPI_STATUSES = ['good', 'needs_attention', 'fail'];
    const PPI_URGENCY = ['none', 'monitor', 'soon', 'immediate'];
    function cleanPpiCategories(raw) {
      const out = [];
      if (Array.isArray(raw)) for (const c of raw.slice(0, 30)) {
        const key = String((c && c.key) || '').trim().slice(0, 40);
        const label = String((c && c.label) || '').trim().slice(0, 80);
        if (!key || !label) continue;
        const detail = {};
        if (c.detail && typeof c.detail === 'object') for (const [k, v] of Object.entries(c.detail).slice(0, 24)) {
          const dv = String(v).trim();
          if (dv) detail[String(k).slice(0, 40)] = dv.slice(0, 300);
        }
        const photos = Array.isArray(c.photos) ? c.photos.filter(u => typeof u === 'string' && u.startsWith('/uploads/')).slice(0, 8) : [];
        const bands = {};
        if (c.bands && typeof c.bands === 'object') for (const [k, v] of Object.entries(c.bands).slice(0, 24)) {
          if (['red', 'yellow', 'green'].includes(v)) bands[String(k).slice(0, 40)] = v;
        }
        out.push({
          key, label,
          status: PPI_STATUSES.includes(c.status) ? c.status : 'good',
          urgency: PPI_URGENCY.includes(c.urgency) ? c.urgency : 'none',
          detail, bands, photos, notes: String((c && c.notes) || '').trim().slice(0, 1000),
        });
      }
      return out;
    }
    if (p === '/api/ppi' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const biz = myBusiness(user.id);
      if (!biz) return sendJson(res, 400, { error: 'Save your business page first.' });
      const { customerName, customerPhone, vehicle, vin, mileage, categories, generalNotes, kind } = await parseBody(req);
      if (kind !== undefined && kind !== 'ppi' && kind !== 'complete')
        return sendJson(res, 400, { error: 'Unknown inspection type.' });
      if (!customerName || !String(customerName).trim() || !vehicle || !String(vehicle).trim())
        return sendJson(res, 400, { error: 'Customer name and vehicle are required.' });
      let cleanVinValue = '';
      if (vin && String(vin).trim()) {
        cleanVinValue = cleanVin(vin);
        if (!cleanVinValue) return sendJson(res, 400, { error: 'VIN must be 17 characters (letters and numbers, no I, O, or Q).' });
      }
      const rows = ppiStore.read();
      const row = {
        id: crypto.randomUUID(), shareToken: crypto.randomBytes(16).toString('hex'),
        kind: kind === 'complete' ? 'complete' : 'ppi',
        businessId: biz.id, mechanicId: user.id,
        customerName: String(customerName).trim(), customerPhone: String(customerPhone || '').trim().slice(0, 30),
        vehicle: String(vehicle).trim().slice(0, 120), vin: cleanVinValue,
        mileage: String(mileage || '').trim().slice(0, 20),
        categories: cleanPpiCategories(categories),
        generalNotes: String(generalNotes || '').trim().slice(0, 2000),
        createdAt: new Date().toISOString(),
      };
      rows.push(row); ppiStore.write(rows);
      return sendJson(res, 201, { report: row });
    }
    if (p === '/api/ppi' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const mine = ppiStore.read().filter(r => r.mechanicId === user.id)
        .map(r => ({ id: r.id, shareToken: r.shareToken, kind: r.kind || 'ppi', customerName: r.customerName, vehicle: r.vehicle, createdAt: r.createdAt }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return sendJson(res, 200, { reports: mine });
    }
    const ppiOne = p.match(/^\/api\/ppi\/([0-9a-f-]+)$/);
    if (ppiOne && (req.method === 'GET' || req.method === 'PUT')) {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const rows = ppiStore.read();
      const row = rows.find(r => r.id === ppiOne[1] && r.mechanicId === user.id);
      if (!row) return sendJson(res, 404, { error: 'Not found.' });
      if (req.method === 'GET') return sendJson(res, 200, { report: row });
      if (mechanicFrozen(user)) return frozenError(res);
      const { customerName, customerPhone, vehicle, vin, mileage, categories, generalNotes } = await parseBody(req);
      if (customerName && String(customerName).trim()) row.customerName = String(customerName).trim();
      if (typeof customerPhone === 'string') row.customerPhone = customerPhone.trim().slice(0, 30);
      if (vehicle && String(vehicle).trim()) row.vehicle = String(vehicle).trim().slice(0, 120);
      if (typeof vin === 'string') {
        if (vin.trim()) {
          const v = cleanVin(vin);
          if (!v) return sendJson(res, 400, { error: 'VIN must be 17 characters (letters and numbers, no I, O, or Q).' });
          row.vin = v;
        } else row.vin = '';
      }
      if (typeof mileage === 'string') row.mileage = mileage.trim().slice(0, 20);
      if (Array.isArray(categories)) row.categories = cleanPpiCategories(categories);
      if (typeof generalNotes === 'string') row.generalNotes = generalNotes.trim().slice(0, 2000);
      ppiStore.write(rows);
      return sendJson(res, 200, { report: row });
    }
    if (ppiOne && req.method === 'DELETE') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const rows = ppiStore.read();
      const idx = rows.findIndex(r => r.id === ppiOne[1] && r.mechanicId === user.id);
      if (idx === -1) return sendJson(res, 404, { error: 'Not found.' });
      rows.splice(idx, 1); ppiStore.write(rows);
      return sendJson(res, 200, {});
    }
    if (p === '/api/ppi/public' && req.method === 'GET') {
      const id = String(url.searchParams.get('id') || ''), token = String(url.searchParams.get('token') || '');
      const row = ppiStore.read().find(r => r.id === id && r.shareToken === token);
      if (!row) return sendJson(res, 404, { error: 'Report not found.' });
      const biz = businessesStore.read().find(b => b.id === row.businessId);
      return sendJson(res, 200, { report: row, business: biz ? publicBusiness(biz) : null });
    }
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
      if (!['logo', 'cover', 'gallery', 'inspection'].includes(kind) || !filePart) return sendJson(res, 400, { error: 'Choose a logo, cover photo, or gallery photo to upload.' });
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
      if (row && kind !== 'inspection') {
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
      if (!/^[0-9a-f-]+\-(logo|cover|gallery\-[0-9a-f]+|photo|photo\-[0-9a-f]+)\.(jpg|png|webp|gif)$/.test(fname)) { res.writeHead(404); return res.end('Not found'); }
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
      const body = await parseBody(req);
      const { type } = body;
      if (!['estimate', 'invoice', 'receipt'].includes(type)) return sendJson(res, 400, { error: 'Pick estimate, invoice, or receipt.' });
      const clean = cleanTicketBody(body, type);
      if (clean.error) return sendJson(res, 400, { error: clean.error });
      if (!clean.warranty && biz.warranty) clean.warranty = String(biz.warranty).slice(0, 2000);
      const tickets = ticketsStore.read();
      const number = nextTicketNumber(biz.id, tickets);
      const ticket = { id: crypto.randomUUID(), businessId: biz.id, mechanicId: user.id, type, number, label: businessAbbrev(biz.name) + '-' + number, ...clean, createdAt: new Date().toISOString() };
      tickets.push(ticket); ticketsStore.write(tickets);
      // Optional sends, chosen on the create form. Never fail the ticket.
      const sent = { text: 'skipped', notified: false };
      try {
        const phoneE164 = normalizePhone(ticket.phone);
        if (body.sendText && phoneE164) {
          const r = await sendSms(phoneE164, `Mobile Mechanic Network: ${biz.name} sent you a ${type} for ${ticket.vehicle} — $${Number(ticket.total).toFixed(2)}. Ticket ${ticket.label}.`);
          sent.text = r.sent ? 'sent' : (r.reason || 'failed');
        } else if (body.sendText) sent.text = 'no-phone';
        // Dashboard notices are automatic, not a button: any customer
        // with an account gets one whenever a ticket is created for them.
        const owner = ownerByPhone(phoneE164);
        sent.notified = pushOwnerNote(owner ? owner.id : null, { type: 'ticket_received', title: `${biz.name} sent you a ${type}`, vehicle: ticket.vehicle || '', total: ticket.total, ticketId: ticket.id, ticketLabel: ticket.label || '', businessName: biz.name || '' });
      } catch (e) {}
      return sendJson(res, 201, { ticket, sent });
    }
    const ticketSend = p.match(/^\/api\/tickets\/([0-9a-f-]+)\/send$/);
    if (ticketSend && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const tickets = ticketsStore.read();
      const t = tickets.find(x => x.id === ticketSend[1] && x.mechanicId === user.id);
      if (!t) return sendJson(res, 404, { error: 'Not found.' });
      const biz = myBusiness(user.id);
      const body = await parseBody(req);
      const row = t.requestId ? requestsStore.read().find(r => r.id === t.requestId) : null;
      const phoneE164 = normalizePhone(t.phone) || (row ? normalizePhone(row.phone) : '');
      const sent = { text: 'skipped', notified: false };
      try {
        if (body.text && phoneE164) {
          const r = await sendSms(phoneE164, `Mobile Mechanic Network: ${biz ? biz.name : 'Your mechanic'} sent you a ${t.type} for ${t.vehicle} — $${Number(t.total).toFixed(2)}. Ticket ${t.label || ''}.`);
          sent.text = r.sent ? 'sent' : (r.reason || 'failed');
        } else if (body.text) sent.text = 'no-phone';
        // Dashboard notices are automatic: sending a ticket to a customer
        // with an account notifies them there too, no button needed.
        const owner = row && row.ownerId ? usersStore.read().find(u => u.id === row.ownerId) : ownerByPhone(phoneE164);
        sent.notified = pushOwnerNote(owner ? owner.id : null, { type: 'ticket_received', title: `${biz ? biz.name : 'Your mechanic'} sent you a ${t.type}`, vehicle: t.vehicle || '', total: t.total, ticketId: t.id, ticketLabel: t.label || '', businessName: biz ? biz.name : '' });
      } catch (e) {}
      return sendJson(res, 200, { sent });
    }
    const ticketUpdate = p.match(/^\/api\/tickets\/([0-9a-f-]+)$/);
    if (ticketUpdate && (req.method === 'PUT' || req.method === 'PATCH')) {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const tickets = ticketsStore.read();
      const t = tickets.find(x => x.id === ticketUpdate[1] && x.mechanicId === user.id);
      if (!t) return sendJson(res, 404, { error: 'Not found.' });
      // Once a ticket is paid, it cannot be edited at all: not prices,
      // not details, not notes or comments. The receipt is final.
      if (t.type === 'receipt') {
        return sendJson(res, 400, { error: 'Paid receipts cannot be edited.' });
      }
      const body = await parseBody(req);
      const clean = cleanTicketBody(body, t.type);
      if (clean.error) return sendJson(res, 400, { error: clean.error });
      if (t.type === 'invoice') {
        // Invoices are locked: the accepted price never changes. Only
        // customer-approved follow-up quotes add lines, never edits.
        // Legacy tickets store {desc, amount} with no qty/price and may lack
        // labor/tax fields; normalize the stored side so unchanged old
        // invoices don't trip the lock when only details change.
        const sameItems = (clean.items || []).length === (t.items || []).length &&
          (clean.items || []).every((it, i) => t.items[i] && it.desc === t.items[i].desc && Number(it.qty) === Number(t.items[i].qty ?? 1) && Number(it.price) === Number(t.items[i].price ?? t.items[i].amount ?? 0));
        if (!sameItems || clean.laborAmount !== Number(t.laborAmount ?? 0) || clean.taxRate !== Number(t.taxRate ?? 0))
          return sendJson(res, 400, { error: 'Invoice prices are locked. Additional work needs customer approval first.' });
      }
      Object.assign(t, clean, { updatedAt: new Date().toISOString() });
      ticketsStore.write(tickets);
      return sendJson(res, 200, { ticket: t });
    }

    // Ticket photos: attached by the mechanic, saved on the ticket, and
    // shown on both ticket views and in the shared/printed document.
    // Receipts are final, so no photos are added to or removed from them.
    const ticketPhoto = p.match(/^\/api\/tickets\/([0-9a-f-]+)\/photo$/);
    if (ticketPhoto && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const tickets = ticketsStore.read();
      const t = tickets.find(x => x.id === ticketPhoto[1] && x.mechanicId === user.id);
      if (!t) return sendJson(res, 404, { error: 'Not found.' });
      if (t.type === 'receipt') return sendJson(res, 400, { error: 'Paid receipts cannot be edited.' });
      let parts;
      try { parts = await parseMultipart(req); } catch (e) { return sendJson(res, 400, { error: 'Upload failed.' }); }
      const filePart = parts.find(x => x.filename);
      if (!filePart) return sendJson(res, 400, { error: 'Choose a photo to upload.' });
      const allowed = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
      const ext = allowed[filePart.contentType];
      if (!ext) return sendJson(res, 400, { error: 'Only JPG, PNG, WebP or GIF images.' });
      if (filePart.data.length > 5 * 1024 * 1024) return sendJson(res, 400, { error: 'Image must be under 5 MB.' });
      const existing = Array.isArray(t.photos) ? t.photos.filter(u => typeof u === 'string' && u.startsWith('/uploads/')) : [];
      if (existing.length >= 12) return sendJson(res, 400, { error: 'At most 12 photos per ticket.' });
      const dir = path.join(DATA_DIR, 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      const fname = t.id + '-photo-' + crypto.randomBytes(8).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(dir, fname), filePart.data);
      t.photos = [...existing, '/uploads/' + fname];
      t.updatedAt = new Date().toISOString();
      ticketsStore.write(tickets);
      return sendJson(res, 200, { photos: t.photos });
    }
    if (ticketPhoto && req.method === 'DELETE') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const { url } = await parseBody(req);
      const tickets = ticketsStore.read();
      const t = tickets.find(x => x.id === ticketPhoto[1] && x.mechanicId === user.id);
      if (!t) return sendJson(res, 404, { error: 'Not found.' });
      if (t.type === 'receipt') return sendJson(res, 400, { error: 'Paid receipts cannot be edited.' });
      if (!Array.isArray(t.photos) || !t.photos.includes(url)) return sendJson(res, 404, { error: 'Not found.' });
      t.photos = t.photos.filter(u => u !== url);
      t.updatedAt = new Date().toISOString();
      ticketsStore.write(tickets);
      const fname = path.basename(String(url || ''));
      if (/^[0-9a-f-]+-photo-[0-9a-f]+\.(jpg|png|webp|gif)$/.test(fname)) {
        const f = path.join(DATA_DIR, 'uploads', fname);
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
      return sendJson(res, 200, { photos: t.photos });
    }
    if (p === '/api/tickets/me' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const tickets = ticketsStore.read().filter(t => t.mechanicId === user.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
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
    const ticketFromReq = p.match(/^\/api\/tickets\/from-request\/([0-9a-f-]+)$/);
    if (ticketFromReq && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      const biz = myBusiness(user.id);
      if (!biz) return sendJson(res, 400, { error: 'Save your business page first.' });
      const row = requestsStore.read().find(r => r.id === ticketFromReq[1]);
      if (!row || row.status !== 'accepted') return sendJson(res, 404, { error: 'Not found.' });
      const quote = quotesStore.read().find(q => q.requestId === row.id && q.businessId === biz.id && q.status === 'accepted');
      if (!quote) return sendJson(res, 404, { error: 'No accepted quote for that job.' });
      const tickets = ticketsStore.read();
      const existing = tickets.find(t => t.requestId === row.id && t.mechanicId === user.id);
      if (existing) return sendJson(res, 200, { ticket: existing, already: true });
      const t = ticketFromAcceptedQuote(quote, row);
      if (!t) return sendJson(res, 400, { error: 'That quote has no priced items.' });
      tickets.push(t); ticketsStore.write(tickets);
      return sendJson(res, 201, { ticket: t });
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
      if (t.estimateStatus === 'pending') return sendJson(res, 400, { error: 'An estimate is still awaiting customer approval, so this invoice cannot be marked paid yet.' });
      const { paymentMethod, vin, mileage } = await parseBody(req);
      const pm = String(paymentMethod || '').trim().slice(0, 50);
      if (!pm) return sendJson(res, 400, { error: 'Say how it was paid (cash, card, check, etc.).' });
      if (!t.vin) {
        const v = vin ? cleanVin(vin) : '';
        if (!v) return sendJson(res, 400, { error: 'A VIN is required before this invoice can be marked paid.' });
        t.vin = v;
      }
      if (mileage !== undefined && mileage !== null && String(mileage).trim() !== '') {
        const m = Number(String(mileage).replace(/[^0-9]/g, ''));
        if (!Number.isFinite(m) || m < 0 || m > 9999999) return sendJson(res, 400, { error: 'Enter a valid vehicle mileage.' });
        t.mileage = m;
      } else if (t.mileage === '' || t.mileage == null) {
        return sendJson(res, 400, { error: 'A vehicle mileage is required before this invoice can be marked paid.' });
      }
      // An unsent draft was never customer-facing: it drops off at payment.
      // Denied lines stay on the ticket and show on the receipt.
      if (t.estimateStatus === 'draft') { t.estimateLines = []; t.estimateStatus = 'none'; }
      t.type = 'receipt'; t.paidAt = new Date().toISOString(); t.paymentMethod = pm;
      ticketsStore.write(tickets);
      // Review prompt: text the customer a review link when a job tied to a request is paid.
      let smsSent = false;
      if (t.requestId) {
        const row = requestsStore.read().find(x => x.id === t.requestId);
        const already = reviewsStore.read().some(x => x.requestId === t.requestId);
        if (row && row.phone && !already) {
          const biz = businessesStore.read().find(b => b.id === t.businessId);
          const r = await sendSms(row.phone, `Thanks for choosing ${biz ? biz.name : 'your mobile mechanic'}! How was your experience? Leave a review: https://mobilemechanicsinmyarea.com/dashboard`);
          smsSent = r.sent;
        }
      }
      return sendJson(res, 200, { ticket: t, smsSent });
    }
    // ---------- Ticket estimate lines (extra work on a booked job) ----------
    // An accepted quote's lines stay invoiced. The mechanic can add extra
    // lines at the bottom of the same repair order as an estimate, send it
    // for a second customer approval, and approved lines join the invoice.
    // Denied lines are kept as a permanent record and show on the receipt
    // as denied repairs, never charged: the mechanic is paid only for
    // accepted work (the original quote plus any approved additions).
    const cleanEstimateLines = (lines) => {
      const out = [];
      if (Array.isArray(lines)) for (const it of lines.slice(0, 50)) {
        const desc = String((it && it.desc) || '').trim().slice(0, 200);
        const price = Math.round(Number(it && (it.price ?? it.amount)) * 100) / 100;
        if (desc && price > 0) out.push({ desc, price });
      }
      return out;
    };
    const estimateRoute = p.match(/^\/api\/tickets\/([0-9a-f-]+)\/estimate(\/(send|accept|decline))?$/);
    if (estimateRoute && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const tickets = ticketsStore.read();
      const t = tickets.find(x => x.id === estimateRoute[1]);
      if (!t) return sendJson(res, 404, { error: 'Not found.' });
      const action = estimateRoute[3] || 'save';
      if (action === 'accept' || action === 'decline') {
        // Customer decision on a pending estimate, per line or whole.
        // Body {line: n} decides one line; no line decides the whole
        // remaining estimate. Decided lines leave the estimate: approved
        // lines join the invoice, denied lines join the denied record.
        // Undecided lines stay pending until the customer decides them.
        // The ticket's mechanic may also record a decision the customer
        // gave by phone; those are logged on the ticket as phone decisions.
        if (!t.requestId) return sendJson(res, 400, { error: 'This ticket has no job to approve.' });
        const row = requestsStore.read().find(r => r.id === t.requestId);
        const isOwner = row && row.ownerId === user.id;
        const isMechanic = user.role === 'mechanic' && t.mechanicId === user.id;
        if (!row || (!isOwner && !isMechanic)) return sendJson(res, 403, { error: 'That is not your job.' });
        if (isMechanic && !isOwner && mechanicFrozen(user)) return frozenError(res);
        if (t.type !== 'invoice' || t.estimateStatus !== 'pending') return sendJson(res, 400, { error: 'No estimate is awaiting approval on this job.' });
        if (tickets.some(x => x.requestId === t.requestId && x.type === 'receipt')) return sendJson(res, 400, { error: 'This job is already paid.' });
        const lines = t.estimateLines || [];
        const body = await parseBody(req);
        let lineIdx = body.line;
        if (lineIdx !== undefined && lineIdx !== null) {
          lineIdx = Number(lineIdx);
          if (!Number.isInteger(lineIdx) || lineIdx < 0 || lineIdx >= lines.length) return sendJson(res, 400, { error: 'That estimate line no longer exists.' });
        } else lineIdx = null;
        const acted = lineIdx === null ? lines : [lines[lineIdx]];
        const remaining = lineIdx === null ? [] : lines.filter((_, i) => i !== lineIdx);
        if (action === 'accept') {
          const r2 = n => Math.round(n * 100) / 100;
          t.items = [...(t.items || []), ...acted.map(l => ({ desc: l.desc, qty: 1, price: l.price }))];
          const parts = r2(t.items.reduce((s, it) => s + it.qty * it.price, 0));
          t.subtotal = parts;
          t.taxAmount = r2(r2(parts + (t.laborAmount || 0)) * (t.taxRate || 0) / 100);
          t.total = r2(parts + (t.laborAmount || 0) + t.taxAmount);
          t.estimateLines = remaining; t.estimateStatus = remaining.length ? 'pending' : 'none';
        } else {
          t.deniedLines = [...(t.deniedLines || []), ...acted];
          t.estimateLines = remaining; t.estimateStatus = remaining.length ? 'pending' : 'none';
        }
        if (isMechanic && !isOwner) {
          t.phoneApprovals = [...(t.phoneApprovals || []), { action, lines: acted.map(l => l.desc), total: acted.reduce((s, l) => s + Number(l.price || 0), 0), at: new Date().toISOString() }];
        }
        ticketsStore.write(tickets);
        // Notify the mechanic, same pattern as a quote acceptance: the
        // mechanic is the one waiting on this decision. Skipped when the
        // mechanic recorded the decision themselves by phone.
        if (isOwner) {
        try {
          const notes = notificationsStore.read();
          notes.push({ id: crypto.randomUUID(), userId: t.mechanicId, type: action === 'accept' ? 'estimate_accepted' : 'estimate_declined', title: `Customer ${action === 'accept' ? 'approved' : 'denied'} your estimate${lineIdx === null ? '' : ' line'}`, service: row.service, vehicle: row.vehicle || '', total: acted.reduce((s, l) => s + Number(l.price || 0), 0), customerName: row.ownerName || '', customerPhone: row.phone || '', requestId: row.id, ticketId: t.id, read: false, createdAt: new Date().toISOString() });
          notificationsStore.write(notes);
        } catch (e) {}
        try {
          const mechUser = usersStore.read().find(u => u.id === t.mechanicId);
          const biz = businessesStore.read().find(b => b.id === t.businessId);
          const to = (mechUser && mechUser.phone) || (biz && biz.phone) || '';
          if (to) await sendSms(to, `Mobile Mechanic Network: ${row.ownerName || 'A customer'} ${action === 'accept' ? 'approved' : 'denied'} your estimate${lineIdx === null ? '' : ' line'} for ${row.service} (${row.vehicle}). See it here: https://mobilemechanicsinmyarea.com/mechanic`);
        } catch (e) {}
        }
        return sendJson(res, 200, { ticket: t });
      }
      // Mechanic save/send.
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      if (mechanicFrozen(user)) return frozenError(res);
      if (t.mechanicId !== user.id) return sendJson(res, 404, { error: 'Not found.' });
      if (t.type !== 'invoice' || !t.requestId) return sendJson(res, 400, { error: 'Estimates can only be added to an unpaid invoice from an accepted quote.' });
      if (t.estimateStatus === 'pending') return sendJson(res, 409, { error: 'An estimate is already awaiting approval for this job.' });
      const body = await parseBody(req);
      const lines = cleanEstimateLines(body.lines);
      if (action === 'send') {
        if (!lines.length) return sendJson(res, 400, { error: 'Add at least one estimate line before sending.' });
        if (tickets.some(x => x.requestId === t.requestId && x.type === 'receipt')) return sendJson(res, 400, { error: 'This job is already paid.' });
        if (quotesStore.read().some(q => q.requestId === t.requestId && q.businessId === t.businessId && q.status === 'pending' && q.followUp === true))
          return sendJson(res, 409, { error: 'A quote is already awaiting approval for this job.' });
        t.estimateLines = lines; t.estimateStatus = 'pending';
      } else {
        // Save draft (empty lines clears the draft).
        t.estimateLines = lines; t.estimateStatus = lines.length ? 'draft' : 'none';
      }
      ticketsStore.write(tickets);
      if (action === 'send') {
        // Sending an estimate for approval notifies the customer the same
        // way a quote does: dashboard note plus a text. Never fails send.
        try {
          const row = t.requestId ? requestsStore.read().find(r => r.id === t.requestId) : null;
          const biz = myBusiness(user.id);
          const estTotal = Math.round(lines.reduce((s, l) => s + Number(l.price || 0), 0) * 100) / 100;
          const phone = row ? row.phone : t.phone;
          const owner = row && row.ownerId ? usersStore.read().find(u => u.id === row.ownerId) : ownerByPhone(phone);
          if (owner) pushOwnerNote(owner.id, { type: 'estimate_received', title: `${biz ? biz.name : 'Your mechanic'} sent an estimate for approval`, service: row ? row.service : '', vehicle: t.vehicle || '', total: estTotal, requestId: t.requestId || null, ticketId: t.id, businessName: biz ? biz.name : '' });
          await sendSms(phone, `Mobile Mechanic Network: ${biz ? biz.name : 'Your mechanic'} sent an estimate for additional work on ${t.vehicle} — $${Number(estTotal).toFixed(2)}. Approve or deny it in your dashboard: https://mobilemechanicsinmyarea.com/dashboard`);
        } catch (e) {}
      }
      return sendJson(res, 200, { ticket: t });
    }
    // Customers tab: prior customers with this mechanic, with their
    // service history. Platform jobs (accepted quotes) key by phone;
    // billed walk-in tickets key by name, joining a phone-keyed customer
    // of the same name when one exists. Estimates alone do not create a
    // customer record: history is booked and billed work only.
    if (p === '/api/mechanic/customers' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const biz = myBusiness(user.id);
      if (!biz) return sendJson(res, 200, { customers: [] });
      const myTickets = ticketsStore.read().filter(t => t.mechanicId === user.id);
      const allRequests = requestsStore.read();
      const allQuotes = quotesStore.read();
      const normName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const byKey = new Map();
      const getCust = (key, name, phone, city, state) => {
        if (!byKey.has(key)) byKey.set(key, { name: name || '', phone: phone || '', city: city || '', state: state || '', jobs: [] });
        const c = byKey.get(key);
        if (name && !c.name) c.name = name;
        if (phone && !c.phone) c.phone = phone;
        if (city && !c.city) { c.city = city; c.state = state || ''; }
        return c;
      };
      for (const q of allQuotes) {
        if (q.businessId !== biz.id || q.status !== 'accepted') continue;
        const pr = allRequests.find(r => r.id === q.requestId);
        if (!pr) continue;
        const ticket = myTickets.find(t => t.requestId === pr.id);
        const c = getCust('phone:' + (pr.phone || pr.ownerId || q.requestId), pr.ownerName, pr.phone, pr.city, pr.state);
        c.jobs.push({ service: pr.service, vehicle: pr.vehicle || '', date: (pr.createdAt || '').slice(0, 10), total: ticket ? ticket.total : (q.total != null ? q.total : q.price), paid: myTickets.some(t => t.requestId === pr.id && t.type === 'receipt'), ticketId: ticket ? ticket.id : null, address: ticket ? (ticket.jobAddress || '') : '', vin: ticket ? (ticket.vin || '') : '', createdAt: pr.createdAt || '' });
      }
      for (const t of myTickets) {
        if (t.requestId || (t.type !== 'invoice' && t.type !== 'receipt')) continue;
        const want = normName(t.customerName);
        if (!want) continue;
        let c = [...byKey.values()].find(x => normName(x.name) === want);
        if (!c) c = getCust('name:' + want, t.customerName, '', '', '');
        c.jobs.push({ service: (t.items || []).map(it => it.desc).filter(Boolean).join(', ') || t.laborDesc || 'Service', vehicle: t.vehicle || '', date: (t.createdAt || '').slice(0, 10), total: t.total, paid: t.type === 'receipt', ticketId: t.id, address: t.jobAddress || '', vin: t.vin || '', createdAt: t.createdAt || '' });
      }
      const customers = [...byKey.values()].map(c => {
        c.jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return { name: c.name, phone: c.phone, city: c.city, state: c.state, jobs: c.jobs, lastJob: c.jobs.length ? c.jobs[0].createdAt : '' };
      }).filter(c => c.name).sort((a, b) => String(b.lastJob).localeCompare(String(a.lastJob)));
      return sendJson(res, 200, { customers });
    }
    if (p === '/api/tickets/customers' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      if (user.role !== 'mechanic') return sendJson(res, 403, { error: 'Mechanics only.' });
      const map = new Map();
      for (const t of ticketsStore.read().filter(t => t.mechanicId === user.id)) {
        const name = String(t.customerName || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!map.has(key)) map.set(key, { name, vehicles: new Map() });
        const v = String(t.vehicle || '').trim();
        if (v) {
          const vk = v.toLowerCase();
          const entry = map.get(key);
          if (!entry.vehicles.has(vk)) entry.vehicles.set(vk, { vehicle: v, vin: t.vin || '' });
          else if (t.vin && !entry.vehicles.get(vk).vin) entry.vehicles.get(vk).vin = t.vin;
        }
      }
      const customers = [...map.values()].map(c => ({ name: c.name, vehicles: [...c.vehicles.values()] }));
      return sendJson(res, 200, { customers });
    }
    const ticketDel = p.match(/^\/api\/tickets\/([0-9a-f-]+)$/);
    if (ticketDel && req.method === 'DELETE') {
      return sendJson(res, 403, { error: 'Tickets cannot be deleted.' });
    }
    if (p === '/api/ticket' && req.method === 'GET') {
      const user = getSessionUser(req);
      const t = ticketsStore.read().find(x => x.id === url.searchParams.get('id'));
      if (!t || !user || t.mechanicId !== user.id) return sendJson(res, 404, { error: 'Not found.' });
      const biz = businessesStore.read().find(b => b.id === t.businessId);
      const reqRow = t.requestId ? requestsStore.read().find(r => r.id === t.requestId) : null;
      return sendJson(res, 200, { ticket: t, business: biz ? publicBusiness(biz) : null, requestDate: reqRow ? (reqRow.date || '') : '' });
    }
    // Customer view of their own job's ticket. Owner-only: the ticket must
    // belong to a request owned by the signed-in user. Mechanic actions
    // live on /ticket; this endpoint only feeds the customer view.
    if (p === '/api/job-ticket' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const t = ticketsStore.read().find(x => x.id === url.searchParams.get('id'));
      if (!t || !t.requestId) return sendJson(res, 404, { error: 'Not found.' });
      const row = requestsStore.read().find(x => x.id === t.requestId);
      if (!row || row.ownerId !== user.id) return sendJson(res, 404, { error: 'Not found.' });
      const biz = businessesStore.read().find(b => b.id === t.businessId);
      const totals = (t.type === 'invoice' && t.estimateStatus === 'pending') ? invoiceTotalsAfter(t, t.estimateLines || []) : null;
      return sendJson(res, 200, { ticket: t, business: biz ? publicBusiness(biz) : null, totals });
    }
    // Printable quote document. The mechanic who quoted it and the
    // request's owner may open it; anyone else (including guests with no
    // account) gets a 404, and shares the PDF file itself instead.
    if (p === '/api/quote' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const q = quotesStore.read().find(x => x.id === url.searchParams.get('id'));
      if (!q) return sendJson(res, 404, { error: 'Not found.' });
      const row = requestsStore.read().find(r => r.id === q.requestId);
      if (!row) return sendJson(res, 404, { error: 'Not found.' });
      const biz = myBusiness(user.id);
      const isMechanic = user.role === 'mechanic' && biz && q.businessId === biz.id;
      const isOwner = user.role === 'owner' && row.ownerId === user.id;
      if (!isMechanic && !isOwner) return sendJson(res, 404, { error: 'Not found.' });
      const b = businessesStore.read().find(x => x.id === q.businessId);
      return sendJson(res, 200, { quote: q, request: row, business: b ? publicBusiness(b) : null });
    }
    // Customer sets the repair location on their own booked ticket.
    // Address is never required at quote-request time; it is only added
    // here, once the job is approved, by the customer or the mechanic.
    const jobTicketAddr = p.match(/^\/api\/job-ticket\/([0-9a-f-]+)\/address$/);
    if (jobTicketAddr && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const tickets = ticketsStore.read();
      const t = tickets.find(x => x.id === jobTicketAddr[1]);
      if (t && t.type === 'receipt') return sendJson(res, 400, { error: 'Paid receipts cannot be edited.' });
      if (!t || !t.requestId || t.type !== 'invoice') return sendJson(res, 404, { error: 'Not found.' });
      const row = requestsStore.read().find(x => x.id === t.requestId);
      if (!row || row.ownerId !== user.id) return sendJson(res, 404, { error: 'Not found.' });
      const body = await parseBody(req);
      t.jobAddress = String(body.jobAddress || '').trim().slice(0, 200);
      t.updatedAt = new Date().toISOString();
      ticketsStore.write(tickets);
      return sendJson(res, 200, { ticket: t });
    }

    // ---------- Billing (60-day free trial, then Stripe subscription) ----------
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
          { id: 'monthly', label: '$39.99 / month' },
          { id: 'yearly', label: '$400 / year' },
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
      const smatch = (req.headers.cookie || '').match(/mmn_session=([a-f0-9]+)/);
      if (smatch) sessions.delete(smatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': ['mmn_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', 'mmn_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'] });
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
      const frozenIds = new Set(users.filter(mechanicFrozen).map(u => u.id));
      return sendJson(res, 200, {
        counts: {
          owners: users.filter(u => u.role === 'owner').length,
          mechanics: users.filter(u => u.role === 'mechanic').length,
          businesses: businesses.length,
          visibleBusinesses: businesses.filter(b => !frozenIds.has(b.userId)).length,
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
        businesses: businesses.map(b => ({ ...publicBusiness(b), frozen: frozenIds.has(b.userId), createdAt: b.createdAt })),
        requests: requests.map(r => ({ id: r.id, ownerName: r.ownerName, phone: r.phone, city: r.city, state: r.state, service: r.service, vehicle: r.vehicle, status: r.status, createdAt: r.createdAt })),
        quotes: quotes.map(q => ({ id: q.id, requestId: q.requestId, price: q.price, status: q.status, createdAt: q.createdAt })),
        help: helpStore.read().slice().reverse(),
      });
    }
    if (p === '/api/admin/export' && req.method === 'GET') {
      if (!adminAuthed(req)) return sendJson(res, 401, { error: 'Not authorized.' });
      const dump = {
        exportedAt: new Date().toISOString(),
        users: usersStore.read(),
        businesses: businessesStore.read(),
        requests: requestsStore.read(),
        quotes: quotesStore.read(),
        promotions: promotionsStore.read(),
        tickets: ticketsStore.read(),
        vehicles: vehiclesStore.read(),
        help: helpStore.read(),
        ppi: ppiStore.read(),
        reviews: reviewsStore.read(),
        visits: visitsStore.read(),
        searches: searchesStore.read(),
        notifications: notificationsStore.read(),
      };
      const body = JSON.stringify(dump);
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="mmn-backup-' + stamp + '.json"',
        'Content-Length': Buffer.byteLength(body),
      });
      return res.end(body);
    }
    if (p === '/api/admin/clear-analytics' && req.method === 'POST') {
      if (!adminAuthed(req)) return sendJson(res, 401, { error: 'Not authorized.' });
      visitsStore.write([]);
      searchesStore.write([]);
      return sendJson(res, 200, { ok: true });
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
      for (const v of vehiclesStore.read().filter(v => v.ownerId === uid)) {
        if (typeof v.photoUrl === 'string' && v.photoUrl.startsWith('/uploads/')) {
          const name = v.photoUrl.slice('/uploads/'.length);
          if (/^[A-Za-z0-9._-]+$/.test(name)) { try { fs.unlinkSync(path.join(DATA_DIR, 'uploads', name)); } catch (e) {} }
        }
      }
      vehiclesStore.write(vehiclesStore.read().filter(v => v.ownerId !== uid));
      for (const [tok, sessUid] of sessions) if (sessUid === uid) sessions.delete(tok);
      return sendJson(res, 200, { deleted: uid });
    }

    // ---------- Pages ----------
    if (p === '/account') return serveFile(res, path.join(PUBLIC_DIR, 'account.html'));
    if (p === '/find') return serveFile(res, path.join(PUBLIC_DIR, 'find.html'));
    if (p === '/admin') return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    if (p === '/security') {
      if (!getSessionUser(req)) { res.writeHead(302, { Location: '/account' }); return res.end(); }
      return serveFile(res, path.join(PUBLIC_DIR, 'security.html'));
    }
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
    if (p === '/job-ticket') {
      return serveFile(res, path.join(PUBLIC_DIR, 'customer-ticket.html'));
    }
    if (p === '/quote') {
      return serveFile(res, path.join(PUBLIC_DIR, 'quote.html'));
    }
    if (p === '/mechanics') return serveFile(res, path.join(PUBLIC_DIR, 'mechanics.html'));
    if (p === '/request') return serveFile(res, path.join(PUBLIC_DIR, 'request.html'));
    if (p === '/dashboard') {
      const u = getSessionUser(req);
      if (!u) { res.writeHead(302, { Location: '/account' }); return res.end(); }
      if (u.role === 'mechanic') { res.writeHead(302, { Location: '/mechanic' }); return res.end(); }
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

backfillTicketNumbers();
server.listen(PORT, () => console.log(`Mobile Mechanic Network site running on http://localhost:${PORT}`));
