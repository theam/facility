ALTER TABLE preview_sessions
  ADD COLUMN native_origin text,
  ADD COLUMN browser_challenge text,
  ADD CONSTRAINT preview_sessions_native_binding_check CHECK (
    (native_origin IS NULL AND browser_challenge IS NULL) OR
    (native_origin IS NOT NULL AND browser_challenge IS NOT NULL AND browser_challenge ~ '^[A-Za-z0-9_-]{43}$')
  );
