-- Add tenant-scoped merchant communication channels for onboarding.
CREATE TABLE "channel_connections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'not_connected',
  "external_account_id" TEXT,
  "external_account_name" TEXT,
  "destination_id" TEXT,
  "destination_label" TEXT,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "credential_ref" UUID,
  "provider_metadata" JSONB NOT NULL DEFAULT '{}',
  "phone_e164" TEXT,
  "masked_destination" TEXT,
  "verification_status" TEXT,
  "consent_status" TEXT,
  "consented_at" TIMESTAMPTZ(6),
  "consent_version" TEXT,
  "connected_at" TIMESTAMPTZ(6),
  "verified_at" TIMESTAMPTZ(6),
  "last_validation_at" TIMESTAMPTZ(6),
  "last_successful_message_at" TIMESTAMPTZ(6),
  "last_failure_at" TIMESTAMPTZ(6),
  "safe_error_code" TEXT,
  "disconnected_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "channel_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "channel_credentials" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "provider" TEXT NOT NULL,
  "connection_id" UUID,
  "encrypted_payload" TEXT NOT NULL,
  "key_version" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "channel_credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "channel_oauth_states" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "provider" TEXT NOT NULL,
  "state_hash" TEXT NOT NULL,
  "redirect_uri" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "channel_oauth_states_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "channel_verification_challenges" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "connection_id" UUID,
  "provider" TEXT NOT NULL,
  "destination_hash" TEXT NOT NULL,
  "destination_masked" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "channel_verification_challenges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "channel_message_deliveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "connection_id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "safe_error_code" TEXT,
  "provider_message_id" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "sent_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "channel_message_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "channel_connections_merchant_id_provider_status_idx"
  ON "channel_connections"("merchant_id", "provider", "status");
CREATE INDEX "channel_connections_shop_id_provider_status_idx"
  ON "channel_connections"("shop_id", "provider", "status");
CREATE INDEX "channel_connections_credential_ref_idx"
  ON "channel_connections"("credential_ref");
CREATE UNIQUE INDEX "channel_connections_one_active_provider_per_merchant_idx"
  ON "channel_connections"("merchant_id", "provider")
  WHERE "disconnected_at" IS NULL;

CREATE INDEX "channel_credentials_connection_id_idx"
  ON "channel_credentials"("connection_id");
CREATE INDEX "channel_credentials_merchant_id_provider_idx"
  ON "channel_credentials"("merchant_id", "provider");
CREATE INDEX "channel_credentials_shop_id_provider_idx"
  ON "channel_credentials"("shop_id", "provider");

CREATE UNIQUE INDEX "channel_oauth_states_provider_state_hash_key"
  ON "channel_oauth_states"("provider", "state_hash");
CREATE INDEX "channel_oauth_states_merchant_id_provider_expires_at_idx"
  ON "channel_oauth_states"("merchant_id", "provider", "expires_at");
CREATE INDEX "channel_oauth_states_shop_id_provider_expires_at_idx"
  ON "channel_oauth_states"("shop_id", "provider", "expires_at");

CREATE INDEX "channel_verification_challenges_merchant_id_provider_expires_at_idx"
  ON "channel_verification_challenges"("merchant_id", "provider", "expires_at");
CREATE INDEX "channel_verification_challenges_shop_id_provider_expires_at_idx"
  ON "channel_verification_challenges"("shop_id", "provider", "expires_at");
CREATE INDEX "channel_verification_challenges_connection_id_idx"
  ON "channel_verification_challenges"("connection_id");

CREATE UNIQUE INDEX "channel_message_deliveries_merchant_id_idempotency_key_key"
  ON "channel_message_deliveries"("merchant_id", "idempotency_key");
CREATE INDEX "channel_message_deliveries_merchant_id_provider_created_at_idx"
  ON "channel_message_deliveries"("merchant_id", "provider", "created_at");
CREATE INDEX "channel_message_deliveries_shop_id_provider_created_at_idx"
  ON "channel_message_deliveries"("shop_id", "provider", "created_at");
CREATE INDEX "channel_message_deliveries_connection_id_created_at_idx"
  ON "channel_message_deliveries"("connection_id", "created_at");

ALTER TABLE "channel_connections"
  ADD CONSTRAINT "channel_connections_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_connections"
  ADD CONSTRAINT "channel_connections_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "channel_credentials"
  ADD CONSTRAINT "channel_credentials_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_credentials"
  ADD CONSTRAINT "channel_credentials_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "channel_oauth_states"
  ADD CONSTRAINT "channel_oauth_states_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_oauth_states"
  ADD CONSTRAINT "channel_oauth_states_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "channel_verification_challenges"
  ADD CONSTRAINT "channel_verification_challenges_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_verification_challenges"
  ADD CONSTRAINT "channel_verification_challenges_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "channel_message_deliveries"
  ADD CONSTRAINT "channel_message_deliveries_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_message_deliveries"
  ADD CONSTRAINT "channel_message_deliveries_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "channel_message_deliveries"
  ADD CONSTRAINT "channel_message_deliveries_connection_id_fkey"
  FOREIGN KEY ("connection_id") REFERENCES "channel_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
