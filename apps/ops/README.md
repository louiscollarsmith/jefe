# Jefe Ops — internal observability panel

A **separate, gated** internal app that renders the `activity_events` log with
filter (type / topic / merchant) and full-text search over the event summary.

It is deliberately **not** part of the merchant-facing Shopify app: it shows
cross-merchant data, which must never be reachable from a merchant's embedded
app. It runs as its own service with its own login.

## Run locally

```bash
cd apps/ops
npm install
npm start                        # http://localhost:4000
```

- **Auth:** HTTP Basic — any username, password must equal `OPS_PASSWORD`. If
  `OPS_PASSWORD` is unset the panel **fails closed** (401 on every request). v1
  is a single shared password; Google SSO is the documented upgrade.
- **Data:** read-only queries against `activity_events` (written by `track()` in
  `apps/shopify`). Point `DATABASE_URL` (or `DATABASE_PUBLIC_URL`) at the target
  environment — for prod, prefer a **read-only** Postgres user.
- **Local env:** `npm start` loads `apps/ops/.env` when it exists. Start from
  `.env.example`, which points at the same local Postgres database as
  `apps/shopify`.

## Deploy (Railway)

Deploy `apps/ops` as its own Railway service:

- Root directory: `apps/ops`, start command: `npm start`.
- Variables: `DATABASE_URL` (read-only user recommended), `OPS_PASSWORD`, `PORT`
  (Railway sets `PORT`). Platform variables override `.env` values.
- Healthcheck path: `/healthz`.

## Security notes

- Cross-merchant data — keep this service internal; never expose it via the
  merchant app or share its URL/password broadly.
- Events are PII-free by construction (shop domain + type/topic/summary), but the
  panel is still access-controlled.
- SQL is fully parameterized; the password compare is timing-safe.
