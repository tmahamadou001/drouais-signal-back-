-- ═══════════════════════════════════════════════════════════════
-- MIGRATION 015 — SECURITY & PERFORMANCE: misc fixes
-- ═══════════════════════════════════════════════════════════════
--
-- 1. Suppression index dupliqué sur status_history
-- 2. Fix search_path mutable sur update_vote_count()
-- 3. Fix search_path mutable sur find_nearby_reports()
-- 4. Merge policies permissives sur audit_logs (perf)
-- 5. Révoquer EXECUTE anon sur is_admin() (sécurité)
-- 6. Ajouter TO authenticated sur toutes les policies
--    qui ne doivent pas s'appliquer aux utilisateurs anonymes
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────
-- 0. Supprimer la policy orpheline sur status_history
--    history_public_read (migration 001) n'a jamais été droppée
--    quand status_history_select (migration 006) l'a remplacée.
--    Les deux coexistent → double policy permissive pour SELECT.
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "history_public_read" ON status_history;

-- ─────────────────────────────────────────────────────────
-- 1. Supprimer l'index dupliqué sur status_history
--    idx_status_history_report_id (migration 001) et
--    idx_status_history_report     (migration 006) sont identiques
-- ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS idx_status_history_report_id;
-- On conserve idx_status_history_report (créé dans 006_multitenant)

-- ─────────────────────────────────────────────────────────
-- 2. Fix mutable search_path — update_vote_count()
-- ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_vote_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE reports
    SET vote_count = vote_count + 1
    WHERE id = NEW.report_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE reports
    SET vote_count = GREATEST(vote_count - 1, 0)
    WHERE id = OLD.report_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = '';

-- ─────────────────────────────────────────────────────────
-- 3. Fix mutable search_path — find_nearby_reports()
-- ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION find_nearby_reports(
  p_lat        DOUBLE PRECISION,
  p_lng        DOUBLE PRECISION,
  p_radius_meters INTEGER DEFAULT 80,
  p_days_ago   INTEGER DEFAULT 30
)
RETURNS TABLE (
  id              UUID,
  title           TEXT,
  category        TEXT,
  description     TEXT,
  photo_url       TEXT,
  vote_count      INTEGER,
  status          TEXT,
  created_at      TIMESTAMPTZ,
  distance_meters DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id,
    r.title,
    r.category,
    r.description,
    r.photo_url,
    r.vote_count,
    r.status,
    r.created_at,
    public.ST_Distance(
      public.ST_MakePoint(r.lng, r.lat)::public.geography,
      public.ST_MakePoint(p_lng, p_lat)::public.geography
    ) AS distance_meters
  FROM public.reports r
  WHERE
    r.created_at >= NOW() - (p_days_ago || ' days')::INTERVAL
    AND public.ST_DWithin(
      public.ST_MakePoint(r.lng, r.lat)::public.geography,
      public.ST_MakePoint(p_lng, p_lat)::public.geography,
      p_radius_meters
    )
  ORDER BY distance_meters ASC;
END;
$$;

-- ─────────────────────────────────────────────────────────
-- 4. Merger les deux policies permissives sur audit_logs
--    en une seule policy TO authenticated
-- ─────────────────────────────────────────────────────────
-- Problème : deux policies SELECT sans restriction de rôle
-- s'appliquent à anon ET authenticated. PostgreSQL évalue
-- les deux pour chaque ligne, même pour un user anonyme.
-- Fix : une seule policy, limitée au rôle authenticated.

DROP POLICY IF EXISTS "audit_logs_super_admin_select"  ON audit_logs;
DROP POLICY IF EXISTS "audit_logs_tenant_admin_select" ON audit_logs;

CREATE POLICY "audit_logs_select"
ON audit_logs FOR SELECT
TO authenticated
USING (
  (SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin'
  OR EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.user_id    = (SELECT auth.uid())
      AND tu.tenant_id  = audit_logs.tenant_id
      AND tu.role       = 'admin'
      AND tu.is_active  = true
  )
);

-- ─────────────────────────────────────────────────────────
-- 5. Révoquer EXECUTE sur is_admin() pour le rôle anon
--    (fonction SECURITY DEFINER accessible publiquement via RPC)
-- ─────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon;
GRANT  EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ─────────────────────────────────────────────────────────
-- 6. Ajouter TO authenticated sur les policies sensibles
--    qui n'ont pas de raison de s'appliquer aux anonymes
-- ─────────────────────────────────────────────────────────
-- Les policies ci-dessous s'appliquent actuellement à tous
-- les rôles (anon inclus), causant des évaluations inutiles.

-- tenant_users
DROP POLICY IF EXISTS "tenant_users_select" ON tenant_users;
DROP POLICY IF EXISTS "tenant_users_insert" ON tenant_users;
DROP POLICY IF EXISTS "tenant_users_update" ON tenant_users;
DROP POLICY IF EXISTS "tenant_users_delete" ON tenant_users;

CREATE POLICY "tenant_users_select" ON tenant_users FOR SELECT TO authenticated
USING (
  tenant_id IN (
    SELECT tenant_id FROM public.tenant_users tu
    WHERE tu.user_id = (SELECT auth.uid())
  )
  OR ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
);

CREATE POLICY "tenant_users_insert" ON tenant_users FOR INSERT TO authenticated
WITH CHECK (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.user_id   = (SELECT auth.uid())
      AND tu.tenant_id = tenant_users.tenant_id
      AND tu.role      = 'admin'
      AND tu.is_active = true
  )
);

CREATE POLICY "tenant_users_update" ON tenant_users FOR UPDATE TO authenticated
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.user_id   = (SELECT auth.uid())
      AND tu.tenant_id = tenant_users.tenant_id
      AND tu.role      = 'admin'
      AND tu.is_active = true
  )
);

CREATE POLICY "tenant_users_delete" ON tenant_users FOR DELETE TO authenticated
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.user_id   = (SELECT auth.uid())
      AND tu.tenant_id = tenant_users.tenant_id
      AND tu.role      = 'admin'
      AND tu.is_active = true
  )
);

-- weekly_report_recipients
DROP POLICY IF EXISTS "weekly_recipients_select" ON weekly_report_recipients;
DROP POLICY IF EXISTS "weekly_recipients_insert" ON weekly_report_recipients;
DROP POLICY IF EXISTS "weekly_recipients_update" ON weekly_report_recipients;
DROP POLICY IF EXISTS "weekly_recipients_delete" ON weekly_report_recipients;

CREATE POLICY "weekly_recipients_select" ON weekly_report_recipients FOR SELECT TO authenticated
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM public.tenant_users
    WHERE tenant_users.user_id   = (SELECT auth.uid())
      AND tenant_users.tenant_id = weekly_report_recipients.tenant_id
      AND tenant_users.role      IN ('admin', 'observer')
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "weekly_recipients_insert" ON weekly_report_recipients FOR INSERT TO authenticated
WITH CHECK (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM public.tenant_users
    WHERE tenant_users.user_id   = (SELECT auth.uid())
      AND tenant_users.tenant_id = weekly_report_recipients.tenant_id
      AND tenant_users.role      = 'admin'
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "weekly_recipients_update" ON weekly_report_recipients FOR UPDATE TO authenticated
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM public.tenant_users
    WHERE tenant_users.user_id   = (SELECT auth.uid())
      AND tenant_users.tenant_id = weekly_report_recipients.tenant_id
      AND tenant_users.role      = 'admin'
      AND tenant_users.is_active = true
  )
);

CREATE POLICY "weekly_recipients_delete" ON weekly_report_recipients FOR DELETE TO authenticated
USING (
  ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM public.tenant_users
    WHERE tenant_users.user_id   = (SELECT auth.uid())
      AND tenant_users.tenant_id = weekly_report_recipients.tenant_id
      AND tenant_users.role      = 'admin'
      AND tenant_users.is_active = true
  )
);

-- report_comments : remplacer FOR ALL + policies spécifiques par des policies
-- explicites par action. FOR ALL + FOR SELECT = 2 policies permissives pour SELECT.
-- Solution : une policy par action, avec conditions agent ET citoyen fusionnées.

DROP POLICY IF EXISTS "comments_agent_all"      ON report_comments;
DROP POLICY IF EXISTS "comments_citizen_select" ON report_comments;
DROP POLICY IF EXISTS "comments_citizen_insert" ON report_comments;

-- SELECT : agent/admin/super_admin de son tenant OU citoyen sur ses propres signalements
CREATE POLICY "comments_select"
ON report_comments FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.user_id   = (SELECT auth.uid())
      AND tu.tenant_id = report_comments.tenant_id
      AND tu.role      IN ('admin', 'agent')
      AND tu.is_active = true
  )
  OR ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (
    SELECT 1 FROM public.reports r
    WHERE r.id        = report_comments.report_id
      AND r.user_id   = (SELECT auth.uid())
      AND r.tenant_id = report_comments.tenant_id
  )
);

-- INSERT : agent (author_type=agent) OU citoyen en réponse à un agent (parent obligatoire)
CREATE POLICY "comments_insert"
ON report_comments FOR INSERT
WITH CHECK (
  -- Agent/admin : peut insérer librement sur son tenant
  (
    author_type = 'agent'
    AND (
      EXISTS (
        SELECT 1 FROM public.tenant_users tu
        WHERE tu.user_id   = (SELECT auth.uid())
          AND tu.tenant_id = report_comments.tenant_id
          AND tu.role      IN ('admin', 'agent')
          AND tu.is_active = true
      )
      OR ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
    )
  )
  OR
  -- Citoyen : uniquement sur ses propres signalements, en réponse (parent requis)
  (
    author_type = 'citizen'
    AND author_id = (SELECT auth.uid())
    AND parent_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.reports r
      WHERE r.id      = report_comments.report_id
        AND r.user_id = (SELECT auth.uid())
    )
  )
);

-- UPDATE : agent/admin/super_admin uniquement
CREATE POLICY "comments_update"
ON report_comments FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.user_id   = (SELECT auth.uid())
      AND tu.tenant_id = report_comments.tenant_id
      AND tu.role      IN ('admin', 'agent')
      AND tu.is_active = true
  )
  OR ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
);

-- DELETE : admin/super_admin uniquement
CREATE POLICY "comments_delete"
ON report_comments FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.user_id   = (SELECT auth.uid())
      AND tu.tenant_id = report_comments.tenant_id
      AND tu.role      = 'admin'
      AND tu.is_active = true
  )
  OR ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role' = 'super_admin')
);

-- ─────────────────────────────────────────────────────────
-- VÉRIFICATION
-- ─────────────────────────────────────────────────────────

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 015 appliquée :';
  RAISE NOTICE '   - Index dupliqué idx_status_history_report_id supprimé';
  RAISE NOTICE '   - search_path fixé sur update_vote_count() et find_nearby_reports()';
  RAISE NOTICE '   - audit_logs : 2 policies → 1 policy TO authenticated';
  RAISE NOTICE '   - is_admin() : EXECUTE révoqué pour anon/public';
  RAISE NOTICE '   - Policies sensibles limitées à TO authenticated';
  RAISE NOTICE '   - report_comments : FOR ALL supprimé → 4 policies explicites (no overlap)';
END $$;
