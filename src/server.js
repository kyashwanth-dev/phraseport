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
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const ROOT = path.join(__dirname, '..');

// Environment-configurable storage and DB locations
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(ROOT, 'db.json');
const SALT_ROUNDS = process.env.PASSCODE_SALT_ROUNDS ? parseInt(process.env.PASSCODE_SALT_ROUNDS, 10) : 10;

// AWS S3 configuration
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET;
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const s3 = new S3Client({ region: AWS_REGION });

// Postgres (RDS) configuration — use DATABASE_URL if provided
// Support providing the DB CA bundle as a PEM string in `PG_SSL_CERT` (useful for serverless/hosted envs)
const poolConfig = {};
if (process.env.DATABASE_URL) poolConfig.connectionString = process.env.DATABASE_URL;
const pgSslCertEnv = process.env.PG_SSL_CERT || process.env.DB_SSL_CERT;
const pgSslCaPath = process.env.PG_SSL_CA_PATH || process.env.DB_SSL_CA_PATH;
// If PG_SSL_CERT (PEM content) is provided, prefer that and enable strict verification
if (pgSslCertEnv) {
  poolConfig.ssl = { rejectUnauthorized: true, ca: pgSslCertEnv };
} else if (pgSslCaPath) {
  try {
    const ca = fs.readFileSync(path.resolve(pgSslCaPath));
    poolConfig.ssl = { rejectUnauthorized: true, ca };
  } catch (err) {
    console.error('Failed to read PG SSL CA file at', pgSslCaPath, err.message || err);
  }
} else {
  // Backwards compatible behavior: allow disabling verification in non-production or via env flags
  const allowSelfSignedEnv = process.env.PGSSLMODE === 'no-verify' || process.env.DB_SSL_ALLOW_SELF_SIGNED === '1' || process.env.DB_SSL_REJECT_UNAUTHORIZED === '0';
  const devDefaultAllow = process.env.NODE_ENV !== 'production';
  const allowSelfSigned = allowSelfSignedEnv || devDefaultAllow;
  if (allowSelfSigned) {
    console.warn('WARNING: Postgres SSL certificate verification is disabled (rejectUnauthorized=false).\n' +
      'This is insecure and should only be used in development or when you understand the risks.\n' +
      'To enable verification, set DB_SSL=true and provide a valid CA or set PGSSLMODE=require.');
    poolConfig.ssl = { rejectUnauthorized: false };
    // This is only for local/dev convenience. Do NOT enable in production.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.warn('WARNING: NODE_TLS_REJECT_UNAUTHORIZED set to 0 for development (TLS cert verification disabled)');
  } else if (process.env.DB_SSL === 'true' || process.env.PGSSLMODE === 'require') {
    poolConfig.ssl = { rejectUnauthorized: true };
  }
}

const pool = new Pool(poolConfig);

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

// Multer in-memory storage (we upload files to S3 instead of local disk)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: process.env.MAX_FILE_SIZE ? parseInt(process.env.MAX_FILE_SIZE, 10) : 10 * 1024 * 1024 } });

// Database helpers (Postgres)
async function initDb() {
  // create table if not exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      title TEXT,
      type TEXT,
      filename TEXT,
      mimetype TEXT,
      text TEXT,
      keyphrase TEXT,
      passcodehash TEXT,
      createdat TIMESTAMP WITHOUT TIME ZONE
    )
  `);

  // Optional import from JSON file if table empty and DATA_FILE present
  try {
    const r = await pool.query('SELECT count(*)::int as c FROM items');
    const count = r.rows[0].c;
    if (count === 0 && fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.items)) {
        for (const it of parsed.items) {
          // skip file items since we don't have their file data in S3
          if (it.type === 'file' && it.filename) continue;
          const passHash = it.passcodeHash || (it.passcode ? await bcrypt.hash(String(it.passcode), SALT_ROUNDS) : null);
          await pool.query(
            `INSERT INTO items(id,title,type,filename,mimetype,text,keyphrase,passcodehash,createdat)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (id) DO NOTHING`,
            [it.id, it.title, it.type, null, it.mimeType || null, it.text || null, it.keyphrase || null, passHash, it.createdAt ? new Date(it.createdAt) : new Date()]
          );
        }
        console.log('Imported text items from', DATA_FILE);
      }
    }
  } catch (err) {
    console.warn('DB init/import warning:', err.message || err);
  }
}

function rowToItem(row) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    filename: row.filename,
    mimeType: row.mimetype,
    text: row.text,
    keyphrase: row.keyphrase,
    passcodeHash: row.passcodehash,
    createdAt: row.createdat ? new Date(row.createdat).toISOString() : null
  };
}

async function insertItemToDb(item) {
  const sql = `INSERT INTO items(id,title,type,filename,mimetype,text,keyphrase,passcodehash,createdat)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
  const params = [item.id, item.title, item.type, item.filename || null, item.mimeType || null, item.text || null, item.keyphrase, item.passcodeHash, new Date(item.createdAt)];
  try {
    await pool.query(sql, params);
  } catch (err) {
    console.error('insertItemToDb error:', err.stack || err);
    console.error('SQL:', sql);
    try { console.error('Params:', JSON.stringify(params)); } catch (_) { console.error('Params: [unserializable]'); }
    throw err;
  }
}

async function findItemsByKeyphrase(keyphrase) {
  const r = await pool.query('SELECT * FROM items WHERE keyphrase = $1 ORDER BY createdat DESC', [keyphrase]);
  return r.rows.map(rowToItem);
}

async function getItemById(id) {
  const r = await pool.query('SELECT * FROM items WHERE id = $1', [id]);
  if (r.rows.length === 0) return null;
  return rowToItem(r.rows[0]);
}

// (Old JSON file helpers removed — we use Postgres RDS now)

function generateKeyphrase() {
  const words = ['apple','river','sun','moon','blue','green','cloud','stone','forest','star','sky','leaf','fox','lake','wind'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${pick()}`;
}

// No-op: passcode migration handled during DB import/initialization

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
    await initDb();
    console.log('DB initialized');
  } catch (err) {
    console.error('DB init error', err);
  }
})();

// Create a new hosted item (text or file)
app.post('/api/host', hostLimiter, upload.single('file'), async (req, res) => {
  try {
    const id = uuidv4();
    const providedKey = req.body.keyphrase && req.body.keyphrase.trim();
    const keyphrase = providedKey || generateKeyphrase();
    // generate a zero-padded 4-digit numeric passcode (0000-9999)
    const passcode = crypto.randomInt(0, 10000).toString().padStart(4, '0');

    const passcodeHash = await bcrypt.hash(passcode, SALT_ROUNDS);

    let filename = undefined;
    let mimeType = undefined;

    if (req.file) {
      if (!S3_BUCKET) return res.status(500).json({ error: 'S3_BUCKET not configured' });
      const safe = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      const key = `${id}-${safe}`;
      try {
        await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype }));
        filename = key;
        mimeType = req.file.mimetype;
      } catch (err) {
        console.error('S3 upload failed', err.stack || err);
        const body = { error: 'failed to upload file to S3' };
        if (process.env.NODE_ENV !== 'production') {
          body.detail = err.message || String(err);
          body.stack = err.stack || null;
        }
        return res.status(500).json(body);
      }
    }

    const item = {
      id,
      title: req.body.title || (req.file ? req.file.originalname : 'untitled'),
      type: req.file ? 'file' : 'text',
      filename,
      mimeType,
      text: req.body.text || undefined,
      keyphrase,
      passcodeHash,
      createdAt: new Date().toISOString()
    };

    try {
      await insertItemToDb(item);
    } catch (dbErr) {
      console.error('DB insert failed', dbErr.stack || dbErr);
      const body = { error: 'failed to write item to DB' };
      if (process.env.NODE_ENV !== 'production') {
        body.detail = dbErr.message || String(dbErr);
        body.stack = dbErr.stack || null;
      }
      return res.status(500).json(body);
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const shareUrl = `${baseUrl}/view?keyphrase=${encodeURIComponent(keyphrase)}&passcode=${encodeURIComponent(passcode)}`;
    // return plain passcode only in response (one-time). Not stored in DB as plaintext.
    res.json({ success: true, id: item.id, keyphrase: item.keyphrase, passcode, shareUrl });
  } catch (err) {
    console.error('Unhandled error in /api/host', err.stack || err);
    if (process.env.NODE_ENV !== 'production') {
      return res.status(500).json({ error: 'failed to host item', detail: err.message, stack: err.stack });
    }
    res.status(500).json({ error: 'failed to host item' });
  }
});
// Helper: authorize items by keyphrase+passcode (async)
async function getAuthorizedItems(keyphrase, passcode) {
  const candidates = await findItemsByKeyphrase(keyphrase);
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
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const out = matches.map(it => {
    const item = { id: it.id, title: it.title, type: it.type, createdAt: it.createdAt };
    if (it.type === 'file' && it.filename) {
      const ext = path.extname(it.filename).toLowerCase();
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
  const it = await getItemById(id);
  if (!it || it.keyphrase !== keyphrase) return res.status(404).json({ error: 'not found or invalid credentials' });
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
  const it = await getItemById(id);
  if (!it || it.keyphrase !== keyphrase) return res.status(404).send('not found or invalid credentials');
  if (!(await verifyPasscode(it, passcode))) return res.status(404).send('not found or invalid credentials');
  if (it.type !== 'file' || !it.filename) return res.status(400).send('item is not a file');
  if (!S3_BUCKET) return res.status(500).send('S3_BUCKET not configured');
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: it.filename }));
    if (it.mimeType) res.setHeader('Content-Type', it.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    // stream the S3 body to the response
    const body = data.Body;
    if (body && typeof body.pipe === 'function') {
      body.pipe(res);
    } else {
      // fallback: collect buffer
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      res.end(Buffer.concat(chunks));
    }
  } catch (err) {
    console.error('S3 get error', err);
    res.status(404).send('file not found');
  }
});

// Convenience route: serve the viewer at /view
app.get('/view', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'view.html'));
});

// Debug endpoints to check DB and insert permissions
app.get('/debug/db', async (req, res) => {
  try {
    const r = await pool.query('SELECT NOW() as now');
    res.json({ ok: true, now: r.rows[0].now });
  } catch (err) {
    console.error('debug/db error', err.stack || err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/debug/insert-test', express.json(), async (req, res) => {
  const testId = `debug-${Date.now()}`;
  try {
    await pool.query('INSERT INTO items(id,title,type,createdat) VALUES($1,$2,$3,$4)', [testId, 'debug', 'text', new Date()]);
    // cleanup
    await pool.query('DELETE FROM items WHERE id = $1', [testId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('debug/insert-test error', err.stack || err);
    res.status(500).json({ ok: false, error: err.message });
  }
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