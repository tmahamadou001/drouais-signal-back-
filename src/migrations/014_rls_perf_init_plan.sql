-- ═══════════════════════════════════════════════════════════════
-- MIGRATION 014 — PERFORMANCE: RLS init-plan optimization
-- ═══════════════════════════════════════════════════════════════
--
-- PROBLÈME : auth.uid(), auth.jwt() et current_setting() appelés
-- directement dans les policies RLS sont ré-évalués pour chaque ligne.
--
-- CORRECTION : Wrapper avec (SELECT ...) pour forcer PostgreSQL à
-- évaluer la valeur une seule fois (init plan) et la réutiliser.
--
-- Concerne toutes les tables : reports, status_history, votes,
-- weekly_report_recipients, tenant_configs, tenant_categories,
-- tenant_users, tenants, report_comments, audit_logs.
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────
-- reports
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "reports_select"  ON reports;
DROP POLICY IF EXISTS "reports_insert"  ON reports;
DROP POLICY IF EXISTS "reports_update"  ON reports;
DROP POLICY IF EXISTS "reports_delete"  ON reports;

CREATE POLICY "reports_select" ON reports FOR SELECT
USING (
  tenant_id IN (
    SELECT id FROM tenants
    WHERE slug = (SELECT current_setting('app.current_tenant', true))
      AND status != 'suspended'
  )
);

CREATE POLICY "reports_insert" ON reports FOR INSERT
WITH CHECK (
  (SELECT auth.uid()) IS NOT NULL
  AND tenant_id IN (
    SELECT id FROM tenants
    WHERE slug = (SELECT current_setting('app.current_tenant', true))
  )
);

CREATE POLICY "reports_update" ON reports FOR UPDATE
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = (SELECT auth.uid())
      AND tenant_users.tenant_id = reports.tenant_id
      AND tenant_users.role IN ('admin', 'agent')
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "reports_delete" ON reports FOR DELETE
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = (SELECT auth.uid())
      AND tenant_users.tenant_id = reports.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

-- ─────────────────────────────────────────────────────────
-- status_history
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "status_history_select" ON status_history;
DROP POLICY IF EXISTS "status_history_insert" ON status_history;
DROP POLICY IF EXISTS "status_history_delete" ON status_history;

CREATE POLICY "status_history_select" ON status_history FOR SELECT
USING (
  tenant_id IN (
    SELECT id FROM tenants
    WHERE slug = (SELECT current_setting('app.current_tenant', true))
  )
);

CREATE POLICY "status_history_insert" ON status_history FOR INSERT
WITH CHECK (
  tenant_id IN (
    SELECT id FROM tenants
    WHERE slug = (SELECT current_setting('app.current_tenant', true))
  )
  AND (
    (SELECT auth.uid()) IS NOT NULL
    OR ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  )
);

CREATE POLICY "status_history_delete" ON status_history FOR DELETE
USING ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin');

-- ─────────────────────────────────────────────────────────
-- votes
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "votes_select" ON votes;
DROP POLICY IF EXISTS "votes_insert" ON votes;
DROP POLICY IF EXISTS "votes_delete" ON votes;

CREATE POLICY "votes_select" ON votes FOR SELECT
USING (
  tenant_id IN (
    SELECT id FROM tenants
    WHERE slug = (SELECT current_setting('app.current_tenant', true))
  )
);

CREATE POLICY "votes_insert" ON votes FOR INSERT
WITH CHECK (
  tenant_id IN (
    SELECT id FROM tenants
    WHERE slug = (SELECT current_setting('app.current_tenant', true))
      AND status != 'suspended'
  )
);

CREATE POLICY "votes_delete" ON votes FOR DELETE
USING (
  ((SELECT auth.uid()) IS NOT NULL AND user_id = (SELECT auth.uid()))
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = (SELECT auth.uid())
      AND tenant_users.tenant_id = votes.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
  OR ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
);

-- ─────────────────────────────────────────────────────────
-- weekly_report_recipients
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "weekly_recipients_select" ON weekly_report_recipients;
DROP POLICY IF EXISTS "weekly_recipients_insert" ON weekly_report_recipients;
DROP POLICY IF EXISTS "weekly_recipients_update" ON weekly_report_recipients;
DROP POLICY IF EXISTS "weekly_recipients_delete" ON weekly_report_recipients;

CREATE POLICY "weekly_recipients_select" ON weekly_report_recipients FOR SELECT
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = (SELECT auth.uid())
      AND tenant_users.tenant_id = weekly_report_recipients.tenant_id
      AND tenant_users.role IN ('admin', 'observer')
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "weekly_recipients_insert" ON weekly_report_recipients FOR INSERT
WITH CHECK (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = (SELECT auth.uid())
      AND tenant_users.tenant_id = weekly_report_recipients.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "weekly_recipients_update" ON weekly_report_recipients FOR UPDATE
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = (SELECT auth.uid())
      AND tenant_users.tenant_id = weekly_report_recipients.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "weekly_recipients_delete" ON weekly_report_recipients FOR DELETE
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = (SELECT auth.uid())
      AND tenant_users.tenant_id = weekly_report_recipients.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

-- ─────────────────────────────────────────────────────────
-- tenant_configs
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "tenant_configs_update" ON tenant_configs;

CREATE POLICY "tenant_configs_update" ON tenant_configs FOR UPDATE
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = (SELECT auth.uid())
      AND tenant_users.tenant_id = tenant_configs.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

-- ─────────────────────────────────────────────────────────
-- tenant_categories
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "tenant_categories_insert" ON tenant_categories;
DROP POLICY IF EXISTS "tenant_categories_update" ON tenant_categories;
DROP POLICY IF EXISTS "tenant_categories_delete" ON tenant_categories;

CREATE POLICY "tenant_categories_insert" ON tenant_categories FOR INSERT
WITH CHECK (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = (SELECT auth.uid())
      AND tenant_users.tenant_id = tenant_categories.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "tenant_categories_update" ON tenant_categories FOR UPDATE
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = (SELECT auth.uid())
      AND tenant_users.tenant_id = tenant_categories.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "tenant_categories_delete" ON tenant_categories FOR DELETE
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users
    WHERE tenant_users.user_id = (SELECT auth.uid())
      AND tenant_users.tenant_id = tenant_categories.tenant_id
      AND tenant_users.role = 'admin'
      AND tenant_users.is_active = true
  )
);

-- ─────────────────────────────────────────────────────────
-- tenant_users
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "tenant_users_select" ON tenant_users;
DROP POLICY IF EXISTS "tenant_users_insert" ON tenant_users;
DROP POLICY IF EXISTS "tenant_users_update" ON tenant_users;
DROP POLICY IF EXISTS "tenant_users_delete" ON tenant_users;

CREATE POLICY "tenant_users_select" ON tenant_users FOR SELECT
USING (
  tenant_id IN (
    SELECT tenant_id FROM tenant_users tu
    WHERE tu.user_id = (SELECT auth.uid())
  )
  OR ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
);

CREATE POLICY "tenant_users_insert" ON tenant_users FOR INSERT
WITH CHECK (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users tu
    WHERE tu.user_id = (SELECT auth.uid())
      AND tu.tenant_id = tenant_users.tenant_id
      AND tu.role = 'admin'
      AND tu.is_active = true
  )
);

CREATE POLICY "tenant_users_update" ON tenant_users FOR UPDATE
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users tu
    WHERE tu.user_id = (SELECT auth.uid())
      AND tu.tenant_id = tenant_users.tenant_id
      AND tu.role = 'admin'
      AND tu.is_active = true
  )
);

CREATE POLICY "tenant_users_delete" ON tenant_users FOR DELETE
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM tenant_users tu
    WHERE tu.user_id = (SELECT auth.uid())
      AND tu.tenant_id = tenant_users.tenant_id
      AND tu.role = 'admin'
      AND tu.is_active = true
  )
);

-- ─────────────────────────────────────────────────────────
-- tenants
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "tenants_insert" ON tenants;
DROP POLICY IF EXISTS "tenants_update" ON tenants;
DROP POLICY IF EXISTS "tenants_delete" ON tenants;

CREATE POLICY "tenants_insert" ON tenants FOR INSERT
WITH CHECK ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin');

CREATE POLICY "tenants_update" ON tenants FOR UPDATE
USING ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin');

CREATE POLICY "tenants_delete" ON tenants FOR DELETE
USING ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin');

-- ─────────────────────────────────────────────────────────
-- report_comments
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "comments_agent_all"      ON report_comments;
DROP POLICY IF EXISTS "comments_citizen_select" ON report_comments;
DROP POLICY IF EXISTS "comments_citizen_insert" ON report_comments;

CREATE POLICY "comments_agent_all"
ON report_comments FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM tenant_users tu
    WHERE tu.user_id = (SELECT auth.uid())
      AND tu.tenant_id = report_comments.tenant_id
      AND tu.role IN ('admin', 'agent')
      AND tu.is_active = true
  )
  OR ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
);

CREATE POLICY "comments_citizen_select"
ON report_comments FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM reports r
    WHERE r.id = report_comments.report_id
      AND r.user_id = (SELECT auth.uid())
      AND r.tenant_id = report_comments.tenant_id
  )
);

CREATE POLICY "comments_citizen_insert"
ON report_comments FOR INSERT
WITH CHECK (
  author_type = 'citizen'
  AND author_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1 FROM reports r
    WHERE r.id = report_comments.report_id
      AND r.user_id = (SELECT auth.uid())
  )
  AND parent_id IS NOT NULL
);

-- ─────────────────────────────────────────────────────────
-- audit_logs
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "audit_logs_super_admin_select" ON audit_logs;
DROP POLICY IF EXISTS "audit_logs_tenant_admin_select" ON audit_logs;

CREATE POLICY "audit_logs_super_admin_select"
ON audit_logs FOR SELECT
USING (
  (SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin'
);

CREATE POLICY "audit_logs_tenant_admin_select"
ON audit_logs FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM tenant_users tu
    WHERE tu.user_id = (SELECT auth.uid())
      AND tu.tenant_id = audit_logs.tenant_id
      AND tu.role = 'admin'
      AND tu.is_active = true
  )
);

-- ─────────────────────────────────────────────────────────
-- VÉRIFICATION
-- ─────────────────────────────────────────────────────────

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 014 : Policies RLS optimisées avec init-plan (SELECT auth.*)';
END $$;
