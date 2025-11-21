Deploying Phraseport to Render
=============================

This document explains a quick way to deploy the existing Express app to Render with minimal code changes.

1) Prerequisites
- Push your repo to GitHub (or connect Render to your Git provider).
- Have an S3 bucket and Postgres instance ready. If using AWS RDS, download the CA bundle (see step 4).

2) Create a Web Service on Render
- In Render dashboard choose **New → Web Service** and connect your repository.
- Branch: `main`
- Build command: `npm install`
- Start command: `node src/server.js`
- Instance: choose your plan (Starter/Free for small testing).

3) Environment variables (set these in Render dashboard → Environment)
- `NODE_ENV` = `production`
- `PORT` = leave blank or set (Render provides `PORT` automatically; the app reads `process.env.PORT`)
- `DATABASE_URL` = `postgres://user:password@host:port/dbname` (preferred) OR set `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGPORT`
- `PG_SSL_CERT` = (optional) full PEM content of the Postgres CA bundle (recommended if your DB requires SSL verification)
- `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- Optional tuning: `MAX_FILE_SIZE`, `JSON_BODY_LIMIT`, `CORS_ORIGIN`, `PASSCODE_SALT_ROUNDS`

4) If using AWS RDS (CA bundle)
- Download AWS RDS CA bundle and copy the PEM contents into `PG_SSL_CERT` (Render secret):
  - Example (PowerShell):
    ```powershell
    Invoke-WebRequest -Uri "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem" -OutFile ".\rds-ca.pem"
    Get-Content .\rds-ca.pem -Raw
    ```
  - Paste the full output into Render's `PG_SSL_CERT` secret value.

5) Deploy & verify
- Deploy the Web Service on Render.
- Check service logs for `Connected to the database` and `DB initialized` messages.
- Use the `/health` endpoint to verify the app is up: `https://<your-service>.onrender.com/health`

6) Security notes
- Do NOT commit `.env` or any secrets to git. Rotate any credentials that were previously leaked.
- If you previously committed a DB password or AWS keys, rotate them immediately in the provider console.

7) If you hit connection limits
- Serverless functions often create many connections; for Render (long-lived process) this is less of an issue. If you later move to serverless (Vercel), use a serverless-friendly DB (Neon/Vercel Postgres/Supabase) or a connection pooler (PgBouncer) in front of RDS.

Questions or want me to patch any env-handling code or add a Render health-check endpoint? Tell me which and I'll apply the change.
