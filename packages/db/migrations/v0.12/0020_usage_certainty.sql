-- Evidence completeness and price availability are independent facts.
ALTER TABLE turn_usage ADD COLUMN usage_complete boolean NOT NULL DEFAULT false;
ALTER TABLE turn_usage ADD COLUMN settlement_reference text;
UPDATE turn_usage u SET usage_complete = true
WHERE u.priced OR (u.status = 'succeeded' AND EXISTS (
  SELECT 1 FROM turns t WHERE t.id = u.turn_id AND t.org_id = u.org_id
    AND t.project_id = u.project_id AND t.story_id = u.story_id AND t.state = 'succeeded'
));
ALTER TABLE turn_usage DROP CONSTRAINT turn_usage_source_check;
ALTER TABLE turn_usage ADD CONSTRAINT turn_usage_source_check
  CHECK (source IN ('provider', 'price_book', 'unpriced', 'manual'));
ALTER TABLE turn_usage ADD CONSTRAINT turn_usage_manual_receipt_check
  CHECK ((source = 'manual' AND priced AND cost_cents IS NOT NULL AND cost_cents >= 0 AND cost_cents <= 2000000000
    AND settlement_reference IS NOT NULL AND length(btrim(settlement_reference)) BETWEEN 1 AND 500)
    OR (source <> 'manual' AND settlement_reference IS NULL));
