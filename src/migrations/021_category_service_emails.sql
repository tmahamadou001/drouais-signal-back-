-- Migration 021: Transmission des signalements aux services concernés
-- Ajoute service_name et service_emails sur tenant_categories
-- pour router automatiquement les signalements vers le bon service municipal

ALTER TABLE public.tenant_categories
  ADD COLUMN IF NOT EXISTS service_name   TEXT          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS service_emails TEXT[]        DEFAULT '{}';

COMMENT ON COLUMN public.tenant_categories.service_name   IS 'Nom du service municipal destinataire (ex: Police Municipale)';
COMMENT ON COLUMN public.tenant_categories.service_emails IS 'Emails du service destinataire — notifié à chaque nouveau signalement dans cette catégorie';
