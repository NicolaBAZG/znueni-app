const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const DATA_FILE = path.join(__dirname, 'data.json');
const MAX_ZNUENI = 4;
const COOLDOWN_MS = 30 * 1000; // 30 seconds per IP

// Load or initialize data
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  return { claimed: 0, winners: [] };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// In-memory cooldown tracker: ip -> timestamp of last claim
const cooldowns = {};

// GET current state
app.get('/api/state', (req, res) => {
  const data = loadData();
  res.json({ claimed: data.claimed, max: MAX_ZNUENI, winners: data.winners });
});

// POST claim a Znüni
app.post('/api/claim', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const now = Date.now();

  // Check cooldown
  if (cooldowns[ip] && now - cooldowns[ip] < COOLDOWN_MS) {
    return res.status(429).json({ error: 'cooldown' });
  }

  const data = loadData();
  if (data.claimed >= MAX_ZNUENI) {
    return res.status(400).json({ error: 'sold_out' });
  }

  // Reserve a slot
  cooldowns[ip] = now;
  data.claimed++;
  saveData(data);

  res.json({ success: true, claimed: data.claimed });
});

// POST submit name after claim
app.post('/api/submit-name', (req, res) => {
  const { name } = req.body;
  const data = loadData();

  // Only accept if there's an unclaimed winner slot
  const winnersCount = data.winners.length;
  if (winnersCount >= data.claimed) {
    return res.status(400).json({ error: 'no_pending_claim' });
  }

  const cleanName = (name || 'Anonym').trim().slice(0, 30) || 'Anonym';
  data.winners.push({ name: cleanName, time: new Date().toLocaleTimeString('de-CH') });
  saveData(data);

  res.json({ success: true, winners: data.winners });
});

// POST reset (optional, for admin)
app.post('/api/reset', (req, res) => {
  const { secret } = req.body;
  if (secret !== (process.env.RESET_SECRET || 'znueni-reset')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  saveData({ claimed: 0, winners: [] });
  Object.keys(cooldowns).forEach(k => delete cooldowns[k]);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Znüni server running on port ${PORT}`));
