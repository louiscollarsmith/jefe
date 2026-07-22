import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sql = neon(DATABASE_URL);

await sql`
  CREATE TABLE IF NOT EXISTS waitlist_signups (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

await sql`
  ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS store_url TEXT
`;

console.log("waitlist_signups ready");
