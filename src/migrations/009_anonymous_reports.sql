-- ═══════════════════════════════════════════════════════════
-- MIGRATION 009 — ANONYMOUS REPORTS
-- Exécuter dans Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 1 : Ajouter colonnes pour signalements anonymes
-- ─────────────────────────────────────────────────────────

ALTER TABLE public.reports
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS anonymous_token VARCHAR(64) UNIQUE,
  ADD COLUMN IF NOT EXISTS anonymous_email VARCHAR(255);

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 2 : Index pour les requêtes anonymes
-- ─────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_reports_anonymous_token ON reports(anonymous_token);
CREATE INDEX IF NOT EXISTS idx_reports_is_anonymous ON reports(is_anonymous);
CREATE INDEX IF NOT EXISTS idx_reports_tenant_anonymous ON reports(tenant_id, is_anonymous);

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 3 : Mettre à jour les RLS policies pour les anonymes
-- ─────────────────────────────────────────────────────────

-- Supprimer l'ancienne policy d'insertion
DROP POLICY IF EXISTS "reports_insert" ON reports;

-- Nouvelle policy : authentifiés OU anonymes
CREATE POLICY "reports_insert" ON reports FOR INSERT
WITH CHECK (
  tenant_id IN (SELECT id FROM tenants WHERE slug = current_setting('app.current_tenant', true))
  AND (
    auth.uid() IS NOT NULL
    OR is_anonymous = true
  )
);
