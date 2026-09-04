-- Per-citizen notification preferences.
--
-- The server sends exactly two kinds of push (`pushStatusChange` and
-- `pushAgentComment`), and the profile screen offers one switch for each.
--
-- Stored on `device_tokens` rather than in a table of their own: there is no
-- other per-citizen setting to keep, and the only reader is the token lookup
-- that decides who to send to — putting the flag on the row being selected
-- turns the preference into part of that same query instead of a join.
--
-- Both default to true. A citizen who installs the app and never opens this
-- screen expects to hear about their own report; silence would look broken.

ALTER TABLE public.device_tokens
  ADD COLUMN IF NOT EXISTS notify_status  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_comment BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.device_tokens.notify_status IS
  'Recevoir une notification quand le statut du signalement change.';
COMMENT ON COLUMN public.device_tokens.notify_comment IS
  'Recevoir une notification quand un agent répond.';
