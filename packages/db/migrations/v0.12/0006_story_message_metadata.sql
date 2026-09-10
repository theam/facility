-- Presentation metadata recorded with each stored conversation message.
-- Agent responses written after this migration record how the engine output was
-- separated (final response versus progress messages) and the engine identity the
-- turn actually reported. Older rows keep the default and are presented as
-- combined transcripts rather than reconstructed.
ALTER TABLE story_messages ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
