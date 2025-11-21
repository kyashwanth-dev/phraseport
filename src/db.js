require('dotenv').config();
const {Client} = require('pg');
const { S3Client, HeadBucketCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

// Prefer DATABASE_URL if present
const databaseUrl = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;
const clientConfig = {};
if (databaseUrl) {
  clientConfig.connectionString = databaseUrl;
} else {
  clientConfig.user = process.env.PGUSER || process.env.DB_USER || 'postgres';
  clientConfig.host = process.env.PGHOST || process.env.DB_HOST || 'database-2.c8heeg44eldd.us-east-1.rds.amazonaws.com';
  clientConfig.database = process.env.PGDATABASE || process.env.DB_NAME || 'testdb';
  clientConfig.password = process.env.PGPASSWORD || process.env.DB_PASSWORD || undefined;
  clientConfig.port = process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432;
}

// SSL/CA support
const pgSslCaPath = process.env.PG_SSL_CA_PATH || process.env.DB_SSL_CA_PATH;
if (pgSslCaPath) {
  try {
    const ca = require('fs').readFileSync(require('path').resolve(pgSslCaPath));
    clientConfig.ssl = { rejectUnauthorized: true, ca };
  } catch (err) {
    console.error('Failed to read PG SSL CA file at', pgSslCaPath, err.message || err);
  }
} else if (process.env.DB_SSL === 'true') {
  // if DB_SSL=true and no CA provided, default to rejecting unauthorized in production
  clientConfig.ssl = { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== '0' };
}

const client = new Client(clientConfig);

if (!process.env.PGPASSWORD && !process.env.DB_PASSWORD && !databaseUrl) {
  console.warn('WARNING: No DB password provided via env vars (PGPASSWORD/DB_PASSWORD) and no DATABASE_URL.');
}

client.connect().then(() => {
  console.log('Connected to the database');
}).catch(err => {
  console.error('Connection error', err.stack);
});

// S3 connectivity test helper
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || 'phraseport-files';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const s3 = new S3Client({ region: AWS_REGION });

async function testS3Bucket() {
  if (!S3_BUCKET) {
    console.warn('S3_BUCKET not configured; skipping S3 check');
    return { ok: false, reason: 'no-bucket-configured' };
  }

  try {
    // Prefer HeadBucket since it's lightweight
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    console.log(`S3 bucket "${S3_BUCKET}" is accessible (HeadBucket OK)`);
    return { ok: true };
  } catch (headErr) {
    // If HeadBucket fails (some providers/permissions), try listing a single object
    try {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, MaxKeys: 1 }));
      console.log(`S3 bucket "${S3_BUCKET}" reachable (ListObjectsV2 OK)`);
      return { ok: true, details: list };
    } catch (listErr) {
      console.error('S3 bucket check failed:', headErr.message || headErr, listErr.message || listErr);
      return { ok: false, reason: 'access-failed', error: headErr.message || headErr };
    }
  }
}

// Run S3 check when this file is executed directly (e.g. `node src/db.js`)
if (require.main === module) {
  (async () => {
    try {
      const res = await testS3Bucket();
      if (!res.ok) process.exitCode = 1;
    } catch (err) {
      console.error('Unexpected error during S3 check', err);
      process.exitCode = 1;
    }
  })();
}

module.exports = { client, testS3Bucket };
