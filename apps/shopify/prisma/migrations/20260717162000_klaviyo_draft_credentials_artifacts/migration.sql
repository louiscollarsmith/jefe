-- Store merchant-specific Klaviyo private keys encrypted with an app-level secret.
CREATE TABLE "merchant_klaviyo_credentials" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'klaviyo',
  "encrypted_private_key" TEXT NOT NULL,
  "key_prefix" TEXT,
  "last_four" TEXT,
  "scopes_json" JSONB,
  "connection_status" TEXT NOT NULL DEFAULT 'active',
  "last_checked_at" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_klaviyo_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchant_klaviyo_credentials_shop_id_provider_key"
  ON "merchant_klaviyo_credentials"("shop_id", "provider");

CREATE INDEX "merchant_klaviyo_credentials_merchant_id_provider_idx"
  ON "merchant_klaviyo_credentials"("merchant_id", "provider");

ALTER TABLE "merchant_klaviyo_credentials"
  ADD CONSTRAINT "merchant_klaviyo_credentials_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_klaviyo_credentials"
  ADD CONSTRAINT "merchant_klaviyo_credentials_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Track idempotent external draft artifacts without putting IDs into opaque execution JSON only.
CREATE TABLE "external_action_artifacts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "action_id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "artifact_type" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "external_name" TEXT,
  "external_status" TEXT NOT NULL,
  "external_url" TEXT,
  "payload_snapshot_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "external_action_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "external_action_artifacts_action_id_provider_artifact_type_external_id_key"
  ON "external_action_artifacts"("action_id", "provider", "artifact_type", "external_id");

CREATE INDEX "external_action_artifacts_shop_id_provider_artifact_type_idx"
  ON "external_action_artifacts"("shop_id", "provider", "artifact_type");

CREATE INDEX "external_action_artifacts_merchant_id_provider_artifact_type_idx"
  ON "external_action_artifacts"("merchant_id", "provider", "artifact_type");

ALTER TABLE "external_action_artifacts"
  ADD CONSTRAINT "external_action_artifacts_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "external_action_artifacts"
  ADD CONSTRAINT "external_action_artifacts_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "external_action_artifacts"
  ADD CONSTRAINT "external_action_artifacts_action_id_fkey"
  FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
