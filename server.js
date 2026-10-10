'use strict';
/* LaunchWise — Node.js + Express backend
 * Questionnaire sessions + consent-based insurance leads, email notifications.
 * MySQL when DB_HOST is set, SQLite fallback otherwise (works standalone).
 */
const path = require('path');
const express = require('express');

// ---------------- Config ----------------
const CFG = {
  port: parseInt(process.env.PORT || '3000', 10),
  brand: process.env.BRAND_NAME || 'LaunchWise',
  notifyEmail: process.env.NOTIFY_EMAIL || 'you@example.com',
  mailFrom: process.env.MAIL_FROM || 'no-reply@launchwise.example',
  ga4Id: process.env.GA4_ID || 'G-XXXXXXXXXX',
  smtpUrl: process.env.SMTP_URL || '', // e.g. smtp://user:pass@smtp.host:587
};

const STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

// ---------------- Database ----------------
let db; // { query(sql, params) -> {rows, insertId} }
const useMysql = !!process.env.DB_HOST;

async function initDb() {
  if (useMysql) {
    const mysql = require('mysql2/promise');
    const pool = mysql.createPool({
      host: process.env.DB_HOST,
      database: process.env.DB_NAME || 'launchwise',
      user: process.env.DB_USER || 'launchwise',
      password: process.env.DB_PASS || 'launchwise_secret',
      waitForConnections: true,
      connectionLimit: 5,
    });
    db = {
      async query(sql, params = []) {
        const [res] = await pool.query(sql, params);
        return Array.isArray(res)
          ? { rows: res, insertId: null }
          : { rows: [], insertId: res.insertId };
      },
    };
    const idDef = 'INT UNSIGNED AUTO_INCREMENT PRIMARY KEY';
    var auto = idDef;
  } else {
    const Database = require('better-sqlite3');
    const fs = require('fs');
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    const sqlite = new Database(path.join(__dirname, 'data', 'app.sqlite'));
    db = {
      async query(sql, params = []) {
        const stmt = sqlite.prepare(sql);
        if (/^\s*select/i.test(sql)) return { rows: stmt.all(...params), insertId: null };
        const info = stmt.run(...params);
        return { rows: [], insertId: /^\s*insert/i.test(sql) ? Number(info.lastInsertRowid) : null };
      },
    };
    var auto = 'INTEGER PRIMARY KEY AUTOINCREMENT';
  }

  await db.query(`CREATE TABLE IF NOT EXISTS questionnaire_sessions (
    id ${auto},
    stage VARCHAR(100), industry VARCHAR(100), employees VARCHAR(50),
    revenue VARCHAR(50), state VARCHAR(50), timeline VARCHAR(100),
    insurance_interests TEXT, completed TINYINT DEFAULT 0,
    ip VARCHAR(64), user_agent VARCHAR(500), created_at VARCHAR(20)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS insurance_leads (
    id ${auto},
    session_id INT NULL, first_name VARCHAR(100), last_name VARCHAR(100),
    email VARCHAR(200), phone VARCHAR(50), business_name VARCHAR(200),
    state VARCHAR(50), coverage_types TEXT, notes TEXT,
    consent_contact TINYINT DEFAULT 0, consent_tcpa TINYINT DEFAULT 0,
    consent_timestamp VARCHAR(20), ip VARCHAR(64), user_agent VARCHAR(500),
    created_at VARCHAR(20)
  )`);
}

// ---------------- Email ----------------
let mailer = null;
async function getMailer() {
  if (mailer) return mailer;
  const nodemailer = require('nodemailer');
  mailer = CFG.smtpUrl
    ? nodemailer.createTransport(CFG.smtpUrl)
    : nodemailer.createTransport({ jsonTransport: true }); // logs instead of sending
  return mailer;
}
async function notify(subject, text) {
  try {
    const t = await getMailer();
    const info = await t.sendMail({ from: CFG.mailFrom, to: CFG.notifyEmail, subject, text });
    if (!CFG.smtpUrl) console.log('[notify:preview]', subject);
  } catch (e) {
    console.error('[notify:error]', e.message);
  }
}

// ---------------- App ----------------
const app = express();
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '64kb' }));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: '1h' }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const view = (name, title) => (req, res) =>
  res.render(name, { brand: CFG.brand, ga4Id: CFG.ga4Id, states: STATES, pageTitle: title, year: new Date().getFullYear(), today: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), mailFrom: CFG.mailFrom });

app.get('/', view('index', null));
app.get('/privacy', view('privacy', 'Privacy Policy'));
app.get('/disclaimer', view('disclaimer', 'Legal Disclaimers'));

const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => clean(x, 100));
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const ip = (req) => req.ip || '';
const ua = (req) => (req.headers['user-agent'] || '').slice(0, 500);

// Basic in-memory rate limiter: max `limit` requests per IP per `windowMs`.
function rateLimit(limit, windowMs) {
  const hits = new Map(); // ip -> { count, reset }
  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const t = Date.now();
    const key = ip(req);
    let h = hits.get(key);
    if (!h || h.reset <= t) { h = { count: 0, reset: t + windowMs }; hits.set(key, h); }
    if (++h.count > limit) {
      res.set('Retry-After', String(Math.ceil((h.reset - t) / 1000)));
      return res.status(429).json({ ok: false, error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}

app.post('/api/questionnaire', rateLimit(20, 15 * 60 * 1000), async (req, res) => {
  if (clean(req.body.website) !== '') return res.json({ ok: true }); // honeypot
  try {
    const interests = list(req.body.insurance_interests);
    const v = {
      stage: clean(req.body.stage, 100), industry: clean(req.body.industry, 100),
      employees: clean(req.body.employees, 50), revenue: clean(req.body.revenue, 50),
      state: clean(req.body.state, 50), timeline: clean(req.body.timeline, 100),
    };
    const { insertId } = await db.query(
      `INSERT INTO questionnaire_sessions
       (stage, industry, employees, revenue, state, timeline, insurance_interests, completed, ip, user_agent, created_at)
       VALUES (?,?,?,?,?,?,?,1,?,?,?)`,
      [v.stage, v.industry, v.employees, v.revenue, v.state, v.timeline, JSON.stringify(interests), ip(req), ua(req), now()]
    );
    notify(`${CFG.brand}: new questionnaire completed`,
      `A visitor completed the startup questionnaire.\n\n` +
      `Stage: ${v.stage}\nIndustry: ${v.industry}\nEmployees: ${v.employees}\nRevenue: ${v.revenue}\n` +
      `State: ${v.state}\nTimeline: ${v.timeline}\nInsurance interests: ${interests.join(', ')}\n` +
      `Session ID: ${insertId}\nTime (UTC): ${now()}`);
    res.json({ ok: true, session_id: insertId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Server error. Please try again later.' });
  }
});

app.post('/api/lead', rateLimit(5, 15 * 60 * 1000), async (req, res) => {
  if (clean(req.body.website) !== '') return res.json({ ok: true });
  try {
    const first = clean(req.body.first_name, 100);
    const email = clean(req.body.email, 200);
    const consentContact = !!req.body.consent_contact;
    const consentTcpa = !!req.body.consent_tcpa;

    const errors = [];
    if (!first) errors.push('First name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('A valid email is required.');
    if (!consentContact || !consentTcpa) errors.push('Both consent checkboxes are required.');
    if (errors.length) return res.status(422).json({ ok: false, error: errors.join(' ') });

    const coverage = list(req.body.coverage_types);
    const v = {
      last: clean(req.body.last_name, 100), phone: clean(req.body.phone, 50),
      biz: clean(req.body.business_name, 200), state: clean(req.body.state, 50),
      notes: clean(req.body.notes, 2000),
      sessionId: parseInt(clean(req.body.session_id, 20), 10) || null,
    };
    const { insertId } = await db.query(
      `INSERT INTO insurance_leads
       (session_id, first_name, last_name, email, phone, business_name, state,
        coverage_types, notes, consent_contact, consent_tcpa, consent_timestamp, ip, user_agent, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [v.sessionId, first, v.last, email, v.phone, v.biz, v.state,
       JSON.stringify(coverage), v.notes, 1, 1, now(), ip(req), ua(req), now()]
    );
    notify(`${CFG.brand}: new insurance lead`,
      `New consent-based insurance lead.\n\n` +
      `Name: ${first} ${v.last}\nEmail: ${email}\nPhone: ${v.phone}\nBusiness: ${v.biz}\nState: ${v.state}\n` +
      `Coverage requested: ${coverage.join(', ')}\nNotes: ${v.notes}\n\n` +
      `Consent given: contact=YES, TCPA=YES at ${now()} UTC\nLead ID: ${insertId}`);
    res.json({ ok: true, lead_id: insertId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Server error. Please try again later.' });
  }
});

initDb()
  .then(() => app.listen(CFG.port, () => console.log(`${CFG.brand} listening on :${CFG.port} (${useMysql ? 'MySQL' : 'SQLite'})`)))
  .catch((e) => { console.error('DB init failed:', e); process.exit(1); });
