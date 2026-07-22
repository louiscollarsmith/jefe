-- Remove the legacy Merchant Operating Map fact table left behind by the
-- repository reset. The current reduced app has no Prisma model, runtime code,
-- job, webhook, test, or foreign key dependency on this table.
DO $$
DECLARE
  fact_count BIGINT;
BEGIN
  IF to_regclass('public.merchant_operating_map_facts') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM "merchant_operating_map_facts"' INTO fact_count;

    IF fact_count > 0 THEN
      RAISE EXCEPTION
        'Refusing to drop non-empty legacy merchant_operating_map_facts table; row_count=%; review/export rows before applying this migration.',
        fact_count;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS "merchant_operating_map_facts" CASCADE;
