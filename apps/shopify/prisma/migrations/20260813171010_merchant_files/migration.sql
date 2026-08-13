-- CreateTable
CREATE TABLE "merchant_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "extracted_text" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'chat',
    "conversation_id" UUID,
    "last_used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merchant_files_merchant_id_created_at_idx" ON "merchant_files"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "merchant_files_merchant_id_shop_id_created_at_idx" ON "merchant_files"("merchant_id", "shop_id", "created_at");

-- AddForeignKey
ALTER TABLE "merchant_files" ADD CONSTRAINT "merchant_files_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_files" ADD CONSTRAINT "merchant_files_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
