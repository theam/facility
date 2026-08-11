ALTER TABLE provider_credentials
  ADD COLUMN IF NOT EXISTS auth_mode text NOT NULL DEFAULT 'api_key';

ALTER TABLE provider_credentials
  ADD CONSTRAINT provider_credentials_auth_mode_check
  CHECK (auth_mode IN ('api_key', 'oauth')) NOT VALID;

ALTER TABLE provider_credentials
  ADD CONSTRAINT provider_credentials_oauth_provider_check
  CHECK (auth_mode <> 'oauth' OR provider = 'anthropic') NOT VALID;

ALTER TABLE provider_credentials
  VALIDATE CONSTRAINT provider_credentials_auth_mode_check;

ALTER TABLE provider_credentials
  VALIDATE CONSTRAINT provider_credentials_oauth_provider_check;
