ALTER TABLE "companies"
ADD COLUMN "url_slug" text DEFAULT concat('company-', substring(gen_random_uuid()::text from 1 for 8));

WITH normalized AS (
  SELECT
    id,
    created_at,
    COALESCE(
      NULLIF(
        regexp_replace(
          regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'),
          '(^-+|-+$)',
          '',
          'g'
        ),
        ''
      ),
      'company'
    ) AS base_slug
  FROM "companies"
),
ranked AS (
  SELECT
    id,
    base_slug,
    row_number() OVER (PARTITION BY base_slug ORDER BY created_at, id) AS slug_rank
  FROM normalized
)
UPDATE "companies" AS companies
SET "url_slug" = CASE
  WHEN ranked.slug_rank = 1 THEN ranked.base_slug
  ELSE ranked.base_slug || '-' || ranked.slug_rank
END
FROM ranked
WHERE companies.id = ranked.id;

ALTER TABLE "companies"
ALTER COLUMN "url_slug" SET NOT NULL;

CREATE UNIQUE INDEX "companies_url_slug_idx" ON "companies" USING btree ("url_slug");
