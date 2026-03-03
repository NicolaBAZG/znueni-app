const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const MAX_ZNUENI = 4;
const COOLDOWN_MS = 120 * 1000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create tables if they don't exist
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      claimed INTEGER DEFAULT 0,
      CHECK (id = 1)
    );
    INSERT INTO state (id, claimed) VALUES (1, 0) ON CONFLICT DO NOTHING;

    CREATE TABLE IF NOT EXISTS winners (
      id SERIAL PRIMARY KEY,
      name VARCHAR(30) NOT NULL,
      claimed_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

// In-memory cooldown tracker: ip -> timestamp
const cooldowns = {};

// GET current state
app.get('/api/state', async (req, res) => {
  try {
    const stateRes = await pool.query('SELECT claimed FROM state WHERE id = 1');
    const winnersRes = await pool.query('SELECT name, TO_CHAR(claimed_at, \'HH24:MI\') as time FROM winners ORDER BY id');
    res.json({
      claimed: stateRes.rows[0].claimed,
      max: MAX_ZNUENI,
      winners: winnersRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// POST claim a Znüni
app.post('/api/claim', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const now = Date.now();

  if (cooldowns[ip] && now - cooldowns[ip] < COOLDOWN_MS) {
    return res.status(429).json({ error: 'cooldown' });
  }

  try {
    const stateRes = await pool.query('SELECT claimed FROM state WHERE id = 1');
    const claimed = stateRes.rows[0].claimed;

    if (claimed >= MAX_ZNUENI) {
      return res.status(400).json({ error: 'sold_out' });
    }

    const updated = await pool.query(
      'UPDATE state SET claimed = claimed + 1 WHERE id = 1 RETURNING claimed'
    );

    cooldowns[ip] = now;
    res.json({ success: true, claimed: updated.rows[0].claimed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// POST submit name
app.post('/api/submit-name', async (req, res) => {
  const { name } = req.body;
  try {
    const stateRes = await pool.query('SELECT claimed FROM state WHERE id = 1');
    const winnersRes = await pool.query('SELECT COUNT(*) as count FROM winners');
    const claimed = stateRes.rows[0].claimed;
    const winnersCount = parseInt(winnersRes.rows[0].count);

    if (winnersCount >= claimed) {
      return res.status(400).json({ error: 'no_pending_claim' });
    }

    const cleanName = (name || 'Anonym').trim().slice(0, 30) || 'Anonym';
    await pool.query('INSERT INTO winners (name) VALUES ($1)', [cleanName]);

    const allWinners = await pool.query(
      'SELECT name, TO_CHAR(claimed_at, \'HH24:MI\') as time FROM winners ORDER BY id'
    );
    res.json({ success: true, winners: allWinners.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// POST db-view (password protected state view)
app.post('/api/db-view', async (req, res) => {
  const { secret } = req.body;
  if (secret !== (process.env.RESET_SECRET || 'znueni-reset')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const stateRes = await pool.query('SELECT claimed FROM state WHERE id = 1');
    const winnersRes = await pool.query('SELECT name, TO_CHAR(claimed_at, \'HH24:MI\') as time FROM winners ORDER BY id');
    res.json({
      claimed: stateRes.rows[0].claimed,
      max: MAX_ZNUENI,
      winners: winnersRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// POST reset
app.post('/api/reset', async (req, res) => {
  const { secret } = req.body;
  if (secret !== (process.env.RESET_SECRET || 'znueni-reset')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    await pool.query('UPDATE state SET claimed = 0 WHERE id = 1');
    await pool.query('DELETE FROM winners');
    Object.keys(cooldowns).forEach(k => delete cooldowns[k]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`Znüni server running on port ${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
