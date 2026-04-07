const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = 3001;
const API_KEY = process.env.API_KEY || 'changeme';

app.use(cors());
app.use(express.json());

const db = new Database('/data/irrigation.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    relay_on INTEGER DEFAULT 0,
    relay_remaining INTEGER DEFAULT 0,
    time_synced INTEGER DEFAULT 0,
    sd_ok INTEGER DEFAULT 0,
    wifi_ok INTEGER DEFAULT 0,
    schedule_count INTEGER DEFAULT 0,
    last_event TEXT DEFAULT '',
    current_time TEXT DEFAULT '',
    updated_at TEXT DEFAULT ''
  );
  INSERT OR IGNORE INTO status (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hour INTEGER,
    minute INTEGER,
    duration_sec INTEGER,
    enabled INTEGER,
    fired_today INTEGER
  );

  CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT,
    params TEXT,
    done INTEGER DEFAULT 0,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    time TEXT,
    duration INTEGER,
    reason TEXT
  );
`);

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── ESP32 ROUTES ──────────────────────────────────────────────────────────────

// ESP32 posts its full state here every 10 seconds
app.post('/api/status', auth, (req, res) => {
  const d = req.body;
  db.prepare(`UPDATE status SET
    relay_on=?, relay_remaining=?, time_synced=?, sd_ok=?,
    wifi_ok=?, schedule_count=?, last_event=?, current_time=?, updated_at=?
    WHERE id=1`).run(
    d.relay_on ? 1 : 0,
    d.relay_remaining || 0,
    d.time_synced ? 1 : 0,
    d.sd_ok ? 1 : 0,
    d.wifi_ok ? 1 : 0,
    d.schedule_count || 0,
    d.last_event || '',
    d.current_time || '',
    new Date().toISOString()
  );
  res.json({ ok: true });
});

// ESP32 posts schedules list here
app.post('/api/schedules', auth, (req, res) => {
  const list = req.body.schedules || [];
  db.prepare('DELETE FROM schedules').run();
  const ins = db.prepare('INSERT INTO schedules (hour,minute,duration_sec,enabled,fired_today) VALUES (?,?,?,?,?)');
  for (const s of list) ins.run(s.hour, s.minute, s.duration_sec, s.enabled ? 1 : 0, s.fired_today ? 1 : 0);
  res.json({ ok: true });
});

// ESP32 posts a cycle event here
app.post('/api/cycle', auth, (req, res) => {
  const d = req.body;
  db.prepare('INSERT INTO cycles (date,time,duration,reason) VALUES (?,?,?,?)')
    .run(d.date, d.time, d.duration, d.reason || '');
  res.json({ ok: true });
});

// ESP32 polls here for pending commands
app.get('/api/commands', auth, (req, res) => {
  const cmd = db.prepare("SELECT * FROM commands WHERE done=0 ORDER BY id ASC LIMIT 1").get();
  if (!cmd) return res.json({ command: null });
  db.prepare('UPDATE commands SET done=1 WHERE id=?').run(cmd.id);
  res.json({ command: cmd.command, params: JSON.parse(cmd.params || '{}') });
});

// ── DASHBOARD ROUTES ──────────────────────────────────────────────────────────

app.get('/api/state', (req, res) => {
  const status = db.prepare('SELECT * FROM status WHERE id=1').get();
  const schedules = db.prepare('SELECT * FROM schedules').all();
  const cycles = db.prepare('SELECT * FROM cycles ORDER BY id DESC LIMIT 500').all();
  res.json({ status, schedules, cycles });
});

app.post('/api/command', (req, res) => {
  const { command, params } = req.body;
  const allowed = ['trigger', 'stop', 'resync', 'add_schedule', 'delete_schedule', 'toggle_schedule'];
  if (!allowed.includes(command)) return res.status(400).json({ error: 'Unknown command' });
  db.prepare('INSERT INTO commands (command, params, done, created_at) VALUES (?,?,0,?)')
    .run(command, JSON.stringify(params || {}), new Date().toISOString());
  res.json({ ok: true });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── ESP PROXY ROUTES ──────────────────────────────────────────────────────────
// These forward requests to the ESP32's SD-backed endpoints.
// Falls back gracefully when ESP is offline.
const ESP_BASE = 'http://172.23.6.200';
const espFetch = (url, opts = {}) =>
  fetch(url, { signal: AbortSignal.timeout(5000), ...opts });

app.get('/api/presets', async (req, res) => {
  try {
    const r = await espFetch(`${ESP_BASE}/presets`);
    res.json(await r.json());
  } catch(e) { res.json({ presets: [], offline: true }); }
});

app.post('/api/presets/add', async (req, res) => {
  const { duration_sec, label } = req.body;
  try {
    await espFetch(`${ESP_BASE}/presets/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `dur=${encodeURIComponent(duration_sec)}&label=${encodeURIComponent(label || '')}`
    });
    res.json({ ok: true });
  } catch(e) { res.status(503).json({ error: 'ESP offline' }); }
});

app.post('/api/presets/delete', async (req, res) => {
  const { index } = req.body;
  try {
    await espFetch(`${ESP_BASE}/presets/delete?i=${index}`);
    res.json({ ok: true });
  } catch(e) { res.status(503).json({ error: 'ESP offline' }); }
});

app.get('/api/log', async (req, res) => {
  try {
    const r = await espFetch(`${ESP_BASE}/log.txt`);
    res.type('text/plain').send(await r.text());
  } catch(e) { res.status(503).send(''); }
});

// ── CYCLE SYNC ────────────────────────────────────────────────────────────────

async function sendTelegram(msg) {
  const token = process.env.TG_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: '[Farm] ' + msg })
    });
  } catch(e) { console.error('Telegram error:', e.message); }
}

const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000;
let offlineAlertSent = false;

setInterval(async () => {
  const row = db.prepare('SELECT updated_at FROM status WHERE id=1').get();
  if (!row || !row.updated_at) return;
  const lastSeen = new Date(row.updated_at).getTime();
  const diff = Date.now() - lastSeen;
  if (diff > OFFLINE_THRESHOLD_MS && !offlineAlertSent) {
    offlineAlertSent = true;
    const mins = Math.floor(diff / 60000);
    await sendTelegram(`ESP32 has been offline for ${mins} minutes — possible power cut at the farm.`);
  }
  if (diff < OFFLINE_THRESHOLD_MS && offlineAlertSent) {
    offlineAlertSent = false;
    await sendTelegram('ESP32 is back online.');
  }
}, 60000);

app.listen(PORT, () => console.log(`Irrigation server running on port ${PORT}`));
