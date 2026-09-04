-- Push notification targets, one row per installed app per user.
--
-- A citizen can have the app on a phone and a tablet, and the same phone can be
-- used by two accounts, so the natural key is the token itself — Expo issues a
-- distinct one per install.

CREATE TABLE IF NOT EXISTS public.device_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The Expo push token, e.g. ExponentPushToken[xxxxxxxxxxxx].
  token       TEXT UNIQUE NOT NULL,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform    TEXT CHECK (platform IN ('ios', 'android')),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Sending looks tokens up by recipient, always scoped to one commune.
CREATE INDEX IF NOT EXISTS device_tokens_user_tenant_idx
  ON public.device_tokens (user_id, tenant_id);

ALTER TABLE public.device_tokens ENABLE ROW LEVEL SECURITY;

-- The server reads and writes this table with the service role, which bypasses
-- RLS. The policy exists for the same reason as everywhere else in this schema:
-- so a direct client connection cannot read someone else's push targets.
DROP POLICY IF EXISTS "device_tokens_own" ON public.device_tokens;
CREATE POLICY "device_tokens_own" ON public.device_tokens
  FOR ALL
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
