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

app.listen(PORT, () => console.log(`Irrigation server running on port ${PORT}`));
