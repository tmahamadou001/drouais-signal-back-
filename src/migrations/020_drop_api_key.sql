-- Remove api_key from tenant_configs.
-- Anonymous reports from the official frontend are now validated by trusted origin
-- (Origin header matching *.onsignale.fr). Third-party integrations are not supported.

ALTER TABLE public.tenant_configs DROP COLUMN IF EXISTS api_key;
