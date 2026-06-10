-- ═══════════════════════════════════════════════════════════════
-- MIGRATION 013 — SECURITY FIX: user_metadata → app_metadata
-- ═══════════════════════════════════════════════════════════════
--
-- PROBLÈME : Toutes les policies RLS utilisaient auth.jwt() -> 'user_metadata'
-- pour vérifier le rôle super_admin. Or user_metadata est MODIFIABLE par
-- l'utilisateur lui-même (via supabase.auth.updateUser). N'importe qui
-- pouvait s'auto-attribuer le rôle super_admin.
--
-- CORRECTION : Utiliser app_metadata à la place, qui n'est écrivable
-- qu'avec la service_role key (côté serveur uniquement).
--
-- PRÉREQUIS : Migrer les super_admins existants (voir ÉTAPE 0 ci-dessous).
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 0 : Migrer les super_admins existants vers app_metadata
-- (À exécuter UNE SEULE FOIS avant le reste)
-- ─────────────────────────────────────────────────────────

UPDATE auth.users
SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', 'super_admin')
WHERE raw_user_meta_data ->> 'role' = 'super_admin';

-- Vérifier la migration (doit retourner 0 après)
-- SELECT count(*) FROM auth.users WHERE raw_user_meta_data->>'role' = 'super_admin' AND raw_app_meta_data->>'role' IS DISTINCT FROM 'super_admin';

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 1 : Corriger la fonction is_admin() (migration 005)
-- ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT auth.jwt() -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 2 : Recréer les policies RLS — table reports
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "reports_update" ON reports;
DROP POLICY IF EXISTS "reports_delete" ON reports;

CREATE POLICY "reports_update" ON reports FOR UPDATE
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = auth.uid()
      AND tenant_users.tenant_id = reports.tenant_id
      AND tenant_users.role IN ('admin', 'agent')
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "reports_delete" ON reports FOR DELETE
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = auth.uid()
      AND tenant_users.tenant_id = reports.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 3 : Recréer les policies RLS — table status_history
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "status_history_insert" ON status_history;
DROP POLICY IF EXISTS "status_history_delete" ON status_history;

CREATE POLICY "status_history_insert" ON status_history FOR INSERT
WITH CHECK (
  tenant_id IN (
    SELECT id FROM tenants
    WHERE slug = current_setting('app.current_tenant', true)
  )
  AND (
    auth.uid() IS NOT NULL
    OR (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
  )
);

CREATE POLICY "status_history_delete" ON status_history FOR DELETE
USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin');

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 4 : Recréer les policies RLS — table votes
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "votes_delete" ON votes;

CREATE POLICY "votes_delete" ON votes FOR DELETE
USING (
  (auth.uid() IS NOT NULL AND user_id = auth.uid())
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = auth.uid()
      AND tenant_users.tenant_id = votes.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
  OR (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
);

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 5 : Recréer les policies RLS — table weekly_report_recipients
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "weekly_recipients_select" ON weekly_report_recipients;
DROP POLICY IF EXISTS "weekly_recipients_insert" ON weekly_report_recipients;
DROP POLICY IF EXISTS "weekly_recipients_update" ON weekly_report_recipients;
DROP POLICY IF EXISTS "weekly_recipients_delete" ON weekly_report_recipients;

CREATE POLICY "weekly_recipients_select" ON weekly_report_recipients FOR SELECT
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = auth.uid()
      AND tenant_users.tenant_id = weekly_report_recipients.tenant_id
      AND tenant_users.role IN ('admin', 'observer')
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "weekly_recipients_insert" ON weekly_report_recipients FOR INSERT
WITH CHECK (
  (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = auth.uid()
      AND tenant_users.tenant_id = weekly_report_recipients.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "weekly_recipients_update" ON weekly_report_recipients FOR UPDATE
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = auth.uid()
      AND tenant_users.tenant_id = weekly_report_recipients.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "weekly_recipients_delete" ON weekly_report_recipients FOR DELETE
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = auth.uid()
      AND tenant_users.tenant_id = weekly_report_recipients.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 6 : Recréer les policies RLS — table tenant_configs
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "tenant_configs_update" ON tenant_configs;

CREATE POLICY "tenant_configs_update" ON tenant_configs FOR UPDATE
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = auth.uid()
      AND tenant_users.tenant_id = tenant_configs.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 7 : Recréer les policies RLS — table tenant_categories
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "tenant_categories_insert" ON tenant_categories;
DROP POLICY IF EXISTS "tenant_categories_update" ON tenant_categories;
DROP POLICY IF EXISTS "tenant_categories_delete" ON tenant_categories;

CREATE POLICY "tenant_categories_insert" ON tenant_categories FOR INSERT
WITH CHECK (
  (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = auth.uid()
      AND tenant_users.tenant_id = tenant_categories.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "tenant_categories_update" ON tenant_categories FOR UPDATE
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = auth.uid()
      AND tenant_users.tenant_id = tenant_categories.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "tenant_categories_delete" ON tenant_categories FOR DELETE
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = auth.uid()
      AND tenant_users.tenant_id = tenant_categories.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 8 : Recréer les policies RLS — table tenant_users
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "tenant_users_select" ON tenant_users;
DROP POLICY IF EXISTS "tenant_users_insert" ON tenant_users;
DROP POLICY IF EXISTS "tenant_users_update" ON tenant_users;
DROP POLICY IF EXISTS "tenant_users_delete" ON tenant_users;

CREATE POLICY "tenant_users_select" ON tenant_users FOR SELECT
USING (
  tenant_id IN (SELECT tenant_id FROM tenant_users tu WHERE tu.user_id = auth.uid())
  OR (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
);

CREATE POLICY "tenant_users_insert" ON tenant_users FOR INSERT
WITH CHECK (
  (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users tu
    WHERE tu.user_id = auth.uid()
      AND tu.tenant_id = tenant_users.tenant_id
      AND tu.role = 'admin'
      AND tu.is_active = true
  )
);

CREATE POLICY "tenant_users_update" ON tenant_users FOR UPDATE
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users tu
    WHERE tu.user_id = auth.uid()
      AND tu.tenant_id = tenant_users.tenant_id
      AND tu.role = 'admin'
      AND tu.is_active = true
  )
);

CREATE POLICY "tenant_users_delete" ON tenant_users FOR DELETE
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users tu
    WHERE tu.user_id = auth.uid()
      AND tu.tenant_id = tenant_users.tenant_id
      AND tu.role = 'admin'
      AND tu.is_active = true
  )
);

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 9 : Recréer les policies RLS — table tenants
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "tenants_insert" ON tenants;
DROP POLICY IF EXISTS "tenants_update" ON tenants;
DROP POLICY IF EXISTS "tenants_delete" ON tenants;

CREATE POLICY "tenants_insert" ON tenants FOR INSERT
WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin');

CREATE POLICY "tenants_update" ON tenants FOR UPDATE
USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin');

CREATE POLICY "tenants_delete" ON tenants FOR DELETE
USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin');

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 10 : Recréer les policies RLS — table audit_logs (migration 012)
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "audit_logs_super_admin_select" ON audit_logs;

CREATE POLICY "audit_logs_super_admin_select"
  ON audit_logs
  FOR SELECT
  USING (
    auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin'
  );

  -- ─────────────────────────────────────────────────────────
-- ÉTAPE 12 : Recréer les policies RLS — table comment (migration 011)
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "comments_agent_all" ON report_comments;

CREATE POLICY "comments_agent_all"
ON report_comments FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM tenant_users tu
    WHERE tu.user_id = auth.uid()
    AND tu.tenant_id = report_comments.tenant_id
    AND tu.role IN ('admin', 'agent')
    AND tu.is_active = true
  )
  OR (
    (auth.jwt() -> 'app_metadata' ->> 'role')
    = 'super_admin'
  )
);

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 11 : Activer RLS sur spatial_ref_sys (table PostGIS)
-- ─────────────────────────────────────────────────────────

ALTER TABLE public.spatial_ref_sys ENABLE ROW LEVEL SECURITY;

-- Lecture publique (c'est une table de référence géographique standard)
DROP POLICY IF EXISTS "spatial_ref_sys_public_read" ON public.spatial_ref_sys;
CREATE POLICY "spatial_ref_sys_public_read" ON public.spatial_ref_sys
  FOR SELECT USING (true);

-- ─────────────────────────────────────────────────────────
-- VÉRIFICATION
-- ─────────────────────────────────────────────────────────

DO $$
BEGIN
  -- Vérifier qu'aucune policy ne référence encore user_metadata pour le rôle
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE qual LIKE '%user_metadata%'
       OR with_check LIKE '%user_metadata%'
  ) THEN
    RAISE WARNING '⚠️  Des policies référencent encore user_metadata — vérifier manuellement';
  ELSE
    RAISE NOTICE '✅ Migration 013 : Toutes les policies utilisent maintenant app_metadata';
  END IF;
END $$;
