-- A person's appearance choice. NULL means they have not chosen yet: the app
-- follows the operating system and offers the choice once.
ALTER TABLE users ADD COLUMN theme text;
ALTER TABLE users
  ADD CONSTRAINT users_theme_check CHECK (theme IS NULL OR theme IN ('system', 'light', 'dark'));
