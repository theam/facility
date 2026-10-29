ALTER TABLE story_delivery_scopes ADD COLUMN execution_authorization jsonb;
ALTER TABLE story_delivery_scopes ADD CONSTRAINT story_delivery_execution_authorization_check CHECK (
 execution_authorization IS NULL OR (
 jsonb_typeof(execution_authorization) = 'object' AND
 execution_authorization->'actor'->>'type' IN ('user', 'key') AND
 length(execution_authorization->'actor'->>'id') BETWEEN 1 AND 240 AND
 (execution_authorization->>'revision')::integer > 0 AND
 octet_length(execution_authorization::text) <= 1024
 ));
