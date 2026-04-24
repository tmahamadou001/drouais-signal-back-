-- ═══════════════════════════════════════════════════════════
-- MIGRATION 010 — API KEYS FOR ANONYMOUS REPORTS
-- Exécuter dans Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 1 : Ajouter colonne api_key à tenant_configs
-- ─────────────────────────────────────────────────────────

ALTER TABLE public.tenant_configs
  ADD COLUMN IF NOT EXISTS api_key VARCHAR(64) UNIQUE NOT NULL DEFAULT gen_random_uuid()::text;

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 2 : Index pour les requêtes par clé API
-- ─────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_tenant_configs_api_key ON tenant_configs(api_key);

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 3 : Créer table pour tracker les requêtes API (optionnel mais recommandé)
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.api_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  api_key_used VARCHAR(64),
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER,
  is_anonymous BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_requests_tenant ON api_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_requests_api_key ON api_requests(api_key_used);
CREATE INDEX IF NOT EXISTS idx_api_requests_created_at ON api_requests(created_at DESC);
