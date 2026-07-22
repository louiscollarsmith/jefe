# Jefe Marketing

Waitlist landing page for `mynamejefe.com`. Independent from `apps/shopify` — its own service, own deploy, no Shopify or Polaris dependency.

Static page (`public/`) served by a small Express server, with one API route for waitlist signups.

## Local development

```bash
cd apps/marketing
npm install
cp .env.example .env   # fill in DATABASE_URL
npm run migrate        # creates waitlist_signups if missing
npm run dev
```

## Data

Signups are stored in `waitlist_signups` in the same Neon project used by `apps/shopify`, as a standalone table — not part of the Shopify commerce schema.

## Deploy

Railway service rooted at `apps/marketing`, config at `apps/marketing/railway.json`. Pre-deploy runs the migration, then starts the server. Health check: `GET /health`.
