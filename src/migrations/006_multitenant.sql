-- ═══════════════════════════════════════════════════════════
-- MIGRATION 006 — MULTI-TENANT
-- Exécuter dans Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 1 : Supprimer les anciennes policies
-- ─────────────────────────────────────────────────────────

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname, tablename
    FROM pg_policies
    WHERE tablename IN ('reports', 'votes', 'weekly_report_recipients')
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I',
      pol.policyname, pol.tablename
    );
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 2 : Nouvelles tables
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'trial'
                CHECK (status IN ('trial','active','suspended','demo')),
  plan          TEXT NOT NULL DEFAULT 'starter'
                CHECK (plan IN ('starter','agglo','enterprise')),
  contact_name  TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  trial_ends_at TIMESTAMPTZ,
  activated_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tenant_configs (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  city_name                  TEXT NOT NULL,
  city_population            INTEGER,
  department_code            TEXT,
  region                     TEXT,
  primary_color              TEXT DEFAULT '#1A56A0',
  logo_url                   TEXT,
  welcome_message            TEXT,
  map_lat                    FLOAT DEFAULT 48.7322,
  map_lng                    FLOAT DEFAULT 1.3664,
  map_zoom                   INTEGER DEFAULT 13,
  feature_anonymous_reports  BOOLEAN DEFAULT true,
  feature_votes              BOOLEAN DEFAULT true,
  feature_ai_analysis        BOOLEAN DEFAULT true,
  feature_weekly_report      BOOLEAN DEFAULT true,
  feature_heatmap            BOOLEAN DEFAULT true,
  weekly_report_day          INTEGER DEFAULT 1,
  weekly_report_hour         INTEGER DEFAULT 8,
  weekly_report_emails       TEXT[] DEFAULT '{}',
  created_at                 TIMESTAMPTZ DEFAULT now(),
  updated_at                 TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tenant_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  label       TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '📌',
  color       TEXT DEFAULT '#6B7280',
  description TEXT,
  is_active   BOOLEAN DEFAULT true,
  sort_order  INTEGER DEFAULT 0,
  sla_hours   INTEGER DEFAULT 168,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS public.tenant_users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'agent'
              CHECK (role IN ('admin','agent','observer')),
  is_active   BOOLEAN DEFAULT true,
  first_name  TEXT,
  last_name   TEXT,
  job_title   TEXT,
  invited_by  UUID REFERENCES auth.users(id),
  invited_at  TIMESTAMPTZ,
  joined_at   TIMESTAMPTZ DEFAULT now(),
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, user_id)
);

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 3 : Ajouter tenant_id sur les tables existantes
-- ─────────────────────────────────────────────────────────

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

ALTER TABLE public.votes
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

ALTER TABLE public.weekly_report_recipients
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

ALTER TABLE public.status_history
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

CREATE INDEX IF NOT EXISTS idx_reports_tenant_id        ON reports(tenant_id);
CREATE INDEX IF NOT EXISTS idx_reports_tenant_status    ON reports(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_votes_tenant_id          ON votes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_votes_tenant_report      ON votes(tenant_id, report_id);
CREATE INDEX IF NOT EXISTS idx_weekly_recipients_tenant ON weekly_report_recipients(tenant_id);
CREATE INDEX IF NOT EXISTS idx_status_history_tenant_id ON status_history(tenant_id);
CREATE INDEX IF NOT EXISTS idx_status_history_report    ON status_history(report_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_user_id     ON tenant_users(user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant      ON tenant_users(tenant_id, role);

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 4 : Données initiales
-- ─────────────────────────────────────────────────────────

INSERT INTO tenants (slug, name, status, plan, contact_email)
VALUES ('dreux', 'Ville de Dreux', 'active', 'starter', 'contact@ville-dreux.fr')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tenant_configs (
  tenant_id, city_name, city_population, department_code, region,
  primary_color, map_lat, map_lng, map_zoom,
  feature_anonymous_reports, feature_votes, feature_ai_analysis,
  feature_weekly_report, feature_heatmap
)
SELECT
  id, 'Dreux', 31689, '28', 'Centre-Val de Loire',
  '#1A56A0', 48.7322, 1.3664, 13,
  true, true, true, true, true
FROM tenants WHERE slug = 'dreux'
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO tenant_categories (tenant_id, slug, label, icon, color, sort_order, sla_hours)
SELECT
  id,
  unnest(ARRAY['voirie','eclairage','dechets','espaces_verts','mobilier_urbain','autre']),
  unnest(ARRAY['Voirie et chaussée','Éclairage public','Déchets et propreté','Espaces verts','Mobilier urbain','Autre']),
  unnest(ARRAY['🚧','💡','🗑️','🌿','🪑','📌']),
  unnest(ARRAY['#EF4444','#F59E0B','#10B981','#22C55E','#6366F1','#6B7280']),
  generate_series(0, 5),
  unnest(ARRAY[72, 48, 48, 168, 168, 168])
FROM tenants WHERE slug = 'dreux'
ON CONFLICT (tenant_id, slug) DO NOTHING;


-- Vérifier zéro orphelins avant NOT NULL
-- (exécuter d'abord pour vérifier, puis la partie NOT NULL séparément)
SELECT 'reports' as t, COUNT(*) as orphans FROM reports WHERE tenant_id IS NULL
UNION ALL SELECT 'votes', COUNT(*) FROM votes WHERE tenant_id IS NULL
UNION ALL SELECT 'weekly_report_recipients', COUNT(*) FROM weekly_report_recipients WHERE tenant_id IS NULL
UNION ALL SELECT 'status_history', COUNT(*) FROM status_history WHERE tenant_id IS NULL;

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 4b : Rendre tenant_id NOT NULL (après vérification)
-- ─────────────────────────────────────────────────────────
-- À exécuter SEULEMENT si la requête précédente retourne 0 partout

ALTER TABLE public.reports               ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.votes                 ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.weekly_report_recipients ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.status_history        ALTER COLUMN tenant_id SET NOT NULL;

-- Tenant La Loupe (démo)
INSERT INTO tenants (slug, name, status, plan)
VALUES ('la-loupe', 'La Loupe', 'demo', 'starter')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tenant_configs (tenant_id, city_name, city_population, department_code, region, primary_color, map_lat, map_lng, map_zoom)
SELECT id, 'La Loupe', 3200, '28', 'Centre-Val de Loire', '#1A56A0', 48.4833, 1.0167, 14
FROM tenants WHERE slug = 'la-loupe'
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO tenant_categories (tenant_id, slug, label, icon, color, sort_order, sla_hours)
SELECT
  id,
  unnest(ARRAY['voirie','eclairage','dechets','autre']),
  unnest(ARRAY['Voirie','Éclairage','Déchets','Autre']),
  unnest(ARRAY['🚧','💡','🗑️','📌']),
  unnest(ARRAY['#EF4444','#F59E0B','#10B981','#6B7280']),
  generate_series(0, 3),
  unnest(ARRAY[72, 48, 48, 168])
FROM tenants WHERE slug = 'la-loupe'
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────
-- ÉTAPE 5 : RLS Policies
-- ─────────────────────────────────────────────────────────

ALTER TABLE reports                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_history             ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_report_recipients   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_configs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_categories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants                    ENABLE ROW LEVEL SECURITY;

-- reports
CREATE POLICY "reports_select" ON reports FOR SELECT
USING (tenant_id IN (SELECT id FROM tenants WHERE slug = current_setting('app.current_tenant', true) AND status != 'suspended'));

CREATE POLICY "reports_insert" ON reports FOR INSERT
WITH CHECK (auth.uid() IS NOT NULL AND tenant_id IN (SELECT id FROM tenants WHERE slug = current_setting('app.current_tenant', true)));

CREATE POLICY "reports_update" ON reports FOR UPDATE
USING (
  (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (SELECT 1 FROM tenant_users WHERE tenant_users.user_id = auth.uid() AND tenant_users.tenant_id = reports.tenant_id AND tenant_users.role IN ('admin','agent') AND tenant_users.is_active = true)
);

CREATE POLICY "reports_delete" ON reports FOR DELETE
USING (
  (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (SELECT 1 FROM tenant_users WHERE tenant_users.user_id = auth.uid() AND tenant_users.tenant_id = reports.tenant_id AND tenant_users.role = 'admin' AND tenant_users.is_active = true)
);

-- status_history
CREATE POLICY "status_history_select" ON status_history FOR SELECT
USING (tenant_id IN (SELECT id FROM tenants WHERE slug = current_setting('app.current_tenant', true)));

CREATE POLICY "status_history_insert" ON status_history FOR INSERT
WITH CHECK (
  tenant_id IN (SELECT id FROM tenants WHERE slug = current_setting('app.current_tenant', true))
  AND (
    auth.uid() IS NOT NULL
    OR (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
  )
);

CREATE POLICY "status_history_delete" ON status_history FOR DELETE
USING (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin');

-- votes
CREATE POLICY "votes_select" ON votes FOR SELECT
USING (tenant_id IN (SELECT id FROM tenants WHERE slug = current_setting('app.current_tenant', true)));

CREATE POLICY "votes_insert" ON votes FOR INSERT
WITH CHECK (tenant_id IN (SELECT id FROM tenants WHERE slug = current_setting('app.current_tenant', true) AND status != 'suspended'));

CREATE POLICY "votes_delete" ON votes FOR DELETE
USING (
  (auth.uid() IS NOT NULL AND user_id = auth.uid())
  OR EXISTS (SELECT 1 FROM tenant_users WHERE tenant_users.user_id = auth.uid() AND tenant_users.tenant_id = votes.tenant_id AND tenant_users.role = 'admin' AND tenant_users.is_active = true)
  OR (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
);

-- weekly_report_recipients
CREATE POLICY "weekly_recipients_select" ON weekly_report_recipients FOR SELECT
USING (
  (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (SELECT 1 FROM tenant_users WHERE tenant_users.user_id = auth.uid() AND tenant_users.tenant_id = weekly_report_recipients.tenant_id AND tenant_users.role IN ('admin','observer') AND tenant_users.is_active = true)
);

CREATE POLICY "weekly_recipients_insert" ON weekly_report_recipients FOR INSERT
WITH CHECK (
  (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (SELECT 1 FROM tenant_users WHERE tenant_users.user_id = auth.uid() AND tenant_users.tenant_id = weekly_report_recipients.tenant_id AND tenant_users.role = 'admin' AND tenant_users.is_active = true)
);

CREATE POLICY "weekly_recipients_update" ON weekly_report_recipients FOR UPDATE
USING (
  (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (SELECT 1 FROM tenant_users WHERE tenant_users.user_id = auth.uid() AND tenant_users.tenant_id = weekly_report_recipients.tenant_id AND tenant_users.role = 'admin' AND tenant_users.is_active = true)
);

CREATE POLICY "weekly_recipients_delete" ON weekly_report_recipients FOR DELETE
USING (
  (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (SELECT 1 FROM tenant_users WHERE tenant_users.user_id = auth.uid() AND tenant_users.tenant_id = weekly_report_recipients.tenant_id AND tenant_users.role = 'admin' AND tenant_users.is_active = true)
);

-- tenant_configs (lecture publique)
CREATE POLICY "tenant_configs_select" ON tenant_configs FOR SELECT USING (true);
CREATE POLICY "tenant_configs_update" ON tenant_configs FOR UPDATE
USING (
  (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (SELECT 1 FROM tenant_users WHERE tenant_users.user_id = auth.uid() AND tenant_users.tenant_id = tenant_configs.tenant_id AND tenant_users.role = 'admin' AND tenant_users.is_active = true)
);

-- tenant_categories (lecture publique)
CREATE POLICY "tenant_categories_select" ON tenant_categories FOR SELECT USING (true);
CREATE POLICY "tenant_categories_insert" ON tenant_categories FOR INSERT
WITH CHECK (
  (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (SELECT 1 FROM tenant_users WHERE tenant_users.user_id = auth.uid() AND tenant_users.tenant_id = tenant_categories.tenant_id AND tenant_users.role = 'admin' AND tenant_users.is_active = true)
);
CREATE POLICY "tenant_categories_update" ON tenant_categories FOR UPDATE
USING (
  (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (SELECT 1 FROM tenant_users WHERE tenant_users.user_id = auth.uid() AND tenant_users.tenant_id = tenant_categories.tenant_id AND tenant_users.role = 'admin' AND tenant_users.is_active = true)
);
CREATE POLICY "tenant_categories_delete" ON tenant_categories FOR DELETE
USING (
  (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (SELECT 1 FROM tenant_users WHERE tenant_users.user_id = auth.uid() AND tenant_users.tenant_id = tenant_categories.tenant_id AND tenant_users.role = 'admin' AND tenant_users.is_active = true)
);

-- tenant_users
CREATE POLICY "tenant_users_select" ON tenant_users FOR SELECT
USING (
  tenant_id IN (SELECT tenant_id FROM tenant_users tu WHERE tu.user_id = auth.uid())
  OR (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
);
CREATE POLICY "tenant_users_insert" ON tenant_users FOR INSERT
WITH CHECK (
  (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (SELECT 1 FROM tenant_users tu WHERE tu.user_id = auth.uid() AND tu.tenant_id = tenant_users.tenant_id AND tu.role = 'admin' AND tu.is_active = true)
);
CREATE POLICY "tenant_users_update" ON tenant_users FOR UPDATE
USING (
  (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (SELECT 1 FROM tenant_users tu WHERE tu.user_id = auth.uid() AND tu.tenant_id = tenant_users.tenant_id AND tu.role = 'admin' AND tu.is_active = true)
);
CREATE POLICY "tenant_users_delete" ON tenant_users FOR DELETE
USING (
  (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin')
  OR EXISTS (SELECT 1 FROM tenant_users tu WHERE tu.user_id = auth.uid() AND tu.tenant_id = tenant_users.tenant_id AND tu.role = 'admin' AND tu.is_active = true)
);

-- tenants (lecture publique, écriture super_admin)
CREATE POLICY "tenants_select" ON tenants FOR SELECT USING (true);
CREATE POLICY "tenants_insert" ON tenants FOR INSERT WITH CHECK (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin');
CREATE POLICY "tenants_update" ON tenants FOR UPDATE USING (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin');
CREATE POLICY "tenants_delete" ON tenants FOR DELETE USING (auth.jwt() -> 'user_metadata' ->> 'role' = 'super_admin');

-- ─────────────────────────────────────────────────────────
-- VÉRIFICATION FINALE
-- ─────────────────────────────────────────────────────────

SELECT tablename, policyname, cmd
FROM pg_policies
WHERE tablename IN ('reports','votes','weekly_report_recipients','tenants','tenant_configs','tenant_categories','tenant_users')
ORDER BY tablename, cmd;
