const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const ROOT = path.join(__dirname, '..');

// Environment-configurable storage and DB locations
const STORAGE_DIR = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : path.join(ROOT, 'storage');
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(ROOT, 'db.json');
const SALT_ROUNDS = process.env.PASSCODE_SALT_ROUNDS ? parseInt(process.env.PASSCODE_SALT_ROUNDS, 10) : 10;

// Trust proxy (if running behind a reverse proxy/container)
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// Basic middleware
app.use(helmet());
app.use(cors());
if (process.env.NODE_ENV !== 'test') app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static assets with caching
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1d' }));

// Ensure storage and DB exist
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ items: [] }, null, 2));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, STORAGE_DIR),
  filename: (req, file, cb) => {
    const id = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${id}-${safe}`);
  }
});
const upload = multer({ storage });

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { items: [] };
  }
}

function writeDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function generateKeyphrase() {
  const words = ['apple','river','sun','moon','blue','green','cloud','stone','forest','star','sky','leaf','fox','lake','wind'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${pick()}`;
}

// Migration: hash any legacy plain-text passcodes into passcodeHash and remove plain passcode
async function migratePlainPasscodes() {
  const db = readDB();
  let changed = false;
  for (const it of db.items) {
    if (it.passcode && !it.passcodeHash) {
      try {
        const hash = await bcrypt.hash(String(it.passcode), SALT_ROUNDS);
        it.passcodeHash = hash;
        delete it.passcode;
        changed = true;
      } catch (err) {
        console.error('failed to hash passcode for item', it.id, err);
      }
    }
  }
  if (changed) writeDB(db);
}

// verify passcode with backward compatibility
async function verifyPasscode(item, passcodePlain) {
  if (!item) return false;
  if (item.passcodeHash) {
    try {
      return await bcrypt.compare(String(passcodePlain), item.passcodeHash);
    } catch (_) {
      return false;
    }
  }
  // legacy fallback if still present
  if (item.passcode) return String(passcodePlain) === String(item.passcode);
  return false;
}

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: process.env.RATE_LIMIT_WINDOW_MS ? parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) : 15 * 60 * 1000,
  max: process.env.RATE_LIMIT_MAX ? parseInt(process.env.RATE_LIMIT_MAX, 10) : 200,
  standardHeaders: true,
  legacyHeaders: false,
});

const hostLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.HOST_RATE_LIMIT_MAX ? parseInt(process.env.HOST_RATE_LIMIT_MAX, 10) : 10,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Startup migration
(async () => {
  try {
    await migratePlainPasscodes();
    console.log('migration: passcodes hashed where needed');
  } catch (err) {
    console.error('migration error', err);
  }
})();

// Create a new hosted item (text or file)
app.post('/api/host', hostLimiter, upload.single('file'), async (req, res) => {
  try {
    const db = readDB();
    const id = uuidv4();
    const providedKey = req.body.keyphrase && req.body.keyphrase.trim();
    const keyphrase = providedKey || generateKeyphrase();
    // generate a zero-padded 4-digit numeric passcode (0000-9999)
    const passcode = crypto.randomInt(0, 10000).toString().padStart(4, '0');

    const passcodeHash = await bcrypt.hash(passcode, SALT_ROUNDS);

    const item = {
      id,
      title: req.body.title || (req.file ? req.file.originalname : 'untitled'),
      type: req.file ? 'file' : 'text',
      filename: req.file ? req.file.filename : undefined,
      mimeType: req.file ? req.file.mimetype : undefined,
      text: req.body.text || undefined,
      keyphrase,
      passcodeHash,
      createdAt: new Date().toISOString()
    };

    db.items.push(item);
    writeDB(db);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const shareUrl = `${baseUrl}/view?keyphrase=${encodeURIComponent(keyphrase)}&passcode=${encodeURIComponent(passcode)}`;
    // return plain passcode only in response (one-time). Not stored in DB as plaintext.
    res.json({ success: true, id: item.id, keyphrase: item.keyphrase, passcode, shareUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to host item' });
  }
});

// Helper: authorize items by keyphrase+passcode (async)
async function getAuthorizedItems(keyphrase, passcode) {
  const db = readDB();
  const candidates = db.items.filter(it => it.keyphrase === keyphrase);
  const out = [];
  for (const it of candidates) {
    if (await verifyPasscode(it, passcode)) out.push(it);
  }
  return out;
}

// List items matching keyphrase+passcode
app.get('/api/items', async (req, res) => {
  const { keyphrase, passcode } = req.query;
  if (!keyphrase || !passcode) return res.status(400).json({ error: 'keyphrase and passcode required' });
  const matches = await getAuthorizedItems(keyphrase, passcode);
  const out = matches.map(it => {
    const item = { id: it.id, title: it.title, type: it.type, createdAt: it.createdAt };
    if (it.type === 'file' && it.filename) {
      const ext = path.extname(it.filename).toLowerCase();
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
        item.previewType = 'image';
        item.previewUrl = `${baseUrl}/api/file/${it.id}?keyphrase=${encodeURIComponent(keyphrase)}&passcode=${encodeURIComponent(passcode)}`;
      } else if (['.mp4', '.webm', '.ogg', '.mov'].includes(ext)) {
        item.previewType = 'video';
        item.previewUrl = `${baseUrl}/api/file/${it.id}?keyphrase=${encodeURIComponent(keyphrase)}&passcode=${encodeURIComponent(passcode)}`;
      } else if (['.mp3', '.wav', '.m4a'].includes(ext)) {
        item.previewType = 'audio';
        item.previewUrl = `${baseUrl}/api/file/${it.id}?keyphrase=${encodeURIComponent(keyphrase)}&passcode=${encodeURIComponent(passcode)}`;
      }
    }
    return item;
  });
  res.json({ items: out });
});

// Get item metadata (requires creds)
app.get('/api/item/:id', async (req, res) => {
  const { keyphrase, passcode } = req.query;
  const id = req.params.id;
  if (!keyphrase || !passcode) return res.status(400).json({ error: 'keyphrase and passcode required' });
  const db = readDB();
  const it = db.items.find(x => x.id === id && x.keyphrase === keyphrase);
  if (!it) return res.status(404).json({ error: 'not found or invalid credentials' });
  if (!(await verifyPasscode(it, passcode))) return res.status(404).json({ error: 'not found or invalid credentials' });
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const downloadUrl = it.type === 'file' ? `${baseUrl}/api/file/${it.id}?keyphrase=${encodeURIComponent(keyphrase)}&passcode=${encodeURIComponent(passcode)}` : undefined;
  res.json({ id: it.id, title: it.title, type: it.type, text: it.text, downloadUrl });
});

// Serve file content (requires creds)
app.get('/api/file/:id', async (req, res) => {
  const { keyphrase, passcode } = req.query;
  const id = req.params.id;
  if (!keyphrase || !passcode) return res.status(400).send('keyphrase and passcode required');
  const db = readDB();
  const it = db.items.find(x => x.id === id && x.keyphrase === keyphrase);
  if (!it) return res.status(404).send('not found or invalid credentials');
  if (!(await verifyPasscode(it, passcode))) return res.status(404).send('not found or invalid credentials');
  if (it.type !== 'file' || !it.filename) return res.status(400).send('item is not a file');
  const p = path.join(STORAGE_DIR, it.filename);
  if (!fs.existsSync(p)) return res.status(404).send('file not found');
  res.sendFile(p);
});

// Convenience route: serve the viewer at /view
app.get('/view', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'view.html'));
});

// Redirect legacy /public/view.html requests to the correct location
app.get('/public/view.html', (req, res) => {
  res.redirect('/view.html');
});

// Basic error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error', err);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`Hoster app listening on http://localhost:${PORT}`);
});
