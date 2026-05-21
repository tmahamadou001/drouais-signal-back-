-- ═══════════════════════════════════════════════════════════════
-- MIGRATION 012 : AUDIT LOGS
-- ═══════════════════════════════════════════════════════════════
-- Système d'audit pour tracer toutes les actions critiques
-- Permet au super admin de voir qui a fait quoi, sur quel tenant, et quand
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────
-- TABLE : audit_logs
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Qui a effectué l'action ?
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email TEXT,
  user_role TEXT,
  
  -- Quelle action ?
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  
  -- Sur quel tenant ?
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  tenant_slug TEXT,
  
  -- Quand ?
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  
  -- Détails supplémentaires
  metadata JSONB DEFAULT '{}'::jsonb,
  ip_address TEXT,
  user_agent TEXT,
  
  -- Contraintes
  CONSTRAINT audit_logs_action_check CHECK (action <> ''),
  CONSTRAINT audit_logs_entity_type_check CHECK (entity_type <> '')
);

-- ─────────────────────────────────────────────────────────
-- INDEXES pour performances
-- ─────────────────────────────────────────────────────────

CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_audit_logs_tenant_id ON audit_logs(tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_entity_type ON audit_logs(entity_type);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_tenant_slug ON audit_logs(tenant_slug) WHERE tenant_slug IS NOT NULL;

-- Index composite pour requêtes fréquentes
CREATE INDEX idx_audit_logs_tenant_action ON audit_logs(tenant_id, action, created_at DESC);

-- ─────────────────────────────────────────────────────────
-- RLS (Row Level Security)
-- ─────────────────────────────────────────────────────────

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Super admin : lecture complète de tous les logs
CREATE POLICY "audit_logs_super_admin_select" 
  ON audit_logs 
  FOR SELECT 
  USING (
    auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin'
  );

-- Tenant admin : lecture uniquement des logs de son tenant
CREATE POLICY "audit_logs_tenant_admin_select" 
  ON audit_logs 
  FOR SELECT 
  USING (
    EXISTS (
      SELECT 1 FROM tenant_users tu
      WHERE tu.user_id = auth.uid()
        AND tu.tenant_id = audit_logs.tenant_id
        AND tu.role = 'admin'
        AND tu.is_active = true
    )
  );

-- Insertion : uniquement via service backend (pas de policy INSERT)
-- Les logs sont créés par le backend avec supabaseAdmin

-- ─────────────────────────────────────────────────────────
-- COMMENTAIRES
-- ─────────────────────────────────────────────────────────

COMMENT ON TABLE audit_logs IS 'Logs d''audit pour tracer toutes les actions critiques de la plateforme';
COMMENT ON COLUMN audit_logs.action IS 'Type d''action : user.created, report.status_changed, tenant.created, etc.';
COMMENT ON COLUMN audit_logs.entity_type IS 'Type d''entité : user, report, tenant, tenant_config, etc.';
COMMENT ON COLUMN audit_logs.entity_id IS 'ID de l''entité concernée';
COMMENT ON COLUMN audit_logs.metadata IS 'Données supplémentaires en JSON (ancien/nouveau statut, etc.)';
COMMENT ON COLUMN audit_logs.ip_address IS 'Adresse IP de l''utilisateur';
COMMENT ON COLUMN audit_logs.user_agent IS 'User-Agent du navigateur';

-- ─────────────────────────────────────────────────────────
-- FONCTION UTILITAIRE : Nettoyage des vieux logs (optionnel)
-- ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION cleanup_old_audit_logs(retention_days INTEGER DEFAULT 365)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM audit_logs
  WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION cleanup_old_audit_logs IS 'Supprime les logs d''audit plus vieux que X jours (défaut: 365)';

-- ─────────────────────────────────────────────────────────
-- VÉRIFICATION
-- ─────────────────────────────────────────────────────────

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 012 : Table audit_logs créée avec succès';
  RAISE NOTICE '   - % indexes créés', (SELECT COUNT(*) FROM pg_indexes WHERE tablename = 'audit_logs');
  RAISE NOTICE '   - RLS activé avec policies pour super_admin et tenant_admin';
END $$;
