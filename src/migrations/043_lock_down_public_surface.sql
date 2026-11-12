-- Migration 043 : refermer la surface publique hors API
--
-- Audit du 12 novembre 2026. La logique applicative tient — le tenant dérivé
-- de la position, les gardes de rôles, les jetons de service, les constats
-- géolocalisés. Ce qui ne tenait pas, c'est tout ce qui ne passe **pas** par
-- l'API Express : PostgREST, le Storage et les fonctions `SECURITY DEFINER`.
--
-- Le serveur utilise la clé `service_role` et contourne le RLS. Il n'est donc
-- jamais gêné par ce qui suit. Ce qui est fermé ici l'est pour les jetons
-- `anon` et `authenticated` — c'est-à-dire pour la clé publiée dans
-- l'application mobile et dans le bundle web, et pour toute session anonyme.
--
-- À exécuter dans l'éditeur SQL de Supabase, en une fois, sur la production.
-- Les requêtes de vérification sont à la fin.

-- ─────────────────────────────────────────────────────────
-- 1. `reports` : des privilèges de colonnes, pas seulement des politiques
-- ─────────────────────────────────────────────────────────
--
-- `reports_select_published` (migration 037) est une politique **de lignes** :
-- elle décide quelles lignes sortent, jamais quelles colonnes. Avec la clé
-- anon, `select=anonymous_token` rendait donc les 22 jetons de suivi de la
-- production — le secret qui sert de preuve d'identité à l'auteur d'un dépôt
-- sans compte, et qui lui permet de lire le fil avec sa mairie et d'y répondre.
--
-- Le RLS ne protège pas une colonne. Les privilèges, si.

REVOKE SELECT ON public.reports FROM anon, authenticated;

GRANT SELECT (
  id, reference, title, description, category, status, resolution_source,
  created_at, updated_at, address_approx, lat, lng, photo_url,
  vote_count, source, tenant_id, is_published, is_anonymous
) ON public.reports TO anon, authenticated;

COMMENT ON COLUMN public.reports.anonymous_token IS
  'Preuve d''identité de l''auteur d''un dépôt sans compte. Ne sort jamais : ni par l''API (lib/reportVisibility.ts), ni par PostgREST (migration 043).';

-- ⚠️ Le temps réel évalue ces mêmes privilèges : un abonnement
-- `postgres_changes` qui demanderait une colonne révoquée ne recevrait plus
-- rien. Le back-office ne lit que `id`, `status` et `tenant_id` dans ses
-- charges utiles — vérifier après coup que les bannières temps réel
-- fonctionnent encore (créer un signalement de test sur une commune de
-- démonstration et regarder le tableau de bord se mettre à jour).

-- ─────────────────────────────────────────────────────────
-- 2. `tenants` : le pipeline commercial n'est pas public
-- ─────────────────────────────────────────────────────────
--
-- `tenants_select USING (true)` (migration 006) rend toute la table à qui a la
-- clé anon : statut, plan, fin de période d'essai, adresse de contact de la
-- mairie. Aujourd'hui quatre communes actives et une adresse exposée. Mais
-- `ensureProspectTenant` crée un tenant `prospect` **au premier signalement de
-- n'importe quel habitant** : le jour où cela arrive, la liste des communes
-- démarchées devient publique — exactement ce que la migration 042 a pris soin
-- de verrouiller côté RPC, et que cette politique rouvrait par la porte à côté.
--
-- La liste des statuts consultables doit rester d'accord avec
-- `PUBLISHING_STATUSES` de `server/src/lib/tenantMode.ts`. Deux listes dans
-- deux langages finissent toujours par diverger : si vous touchez à l'une,
-- touchez à l'autre.

DROP POLICY IF EXISTS "tenants_select" ON public.tenants;

CREATE POLICY "tenants_select_browsable" ON public.tenants FOR SELECT
TO anon, authenticated
USING (status IN ('trial', 'active', 'demo', 'community'));

CREATE POLICY "tenants_select_member" ON public.tenants FOR SELECT
TO authenticated
USING (public.is_active_tenant_member(id) OR public.is_super_admin());

REVOKE SELECT ON public.tenants FROM anon, authenticated;
GRANT SELECT (id, slug, name, status, reference_prefix)
  ON public.tenants TO anon, authenticated;

-- ─────────────────────────────────────────────────────────
-- 3. `cleanup_old_audit_logs` : la fonction oubliée par la 038
-- ─────────────────────────────────────────────────────────
--
-- Une fonction créée sans mention de droits est exécutable par `PUBLIC`, et
-- `SECURITY DEFINER` l'exécute sans RLS. La migration 038 a verrouillé
-- `get_performance_stats`, `assign_report_reference` et `update_vote_count` —
-- à la main, une par une — et a manqué celle-ci.
--
-- Conséquence : `rpc('cleanup_old_audit_logs', { retention_days: 0 })` depuis
-- n'importe quelle session, y compris la session anonyme de l'application,
-- effaçait **tout le journal d'audit de la plateforme, toutes communes**.
-- L'effacement ne laissait aucune trace : la table qui l'aurait tracé était la
-- cible. C'est l'anti-forensique parfait.
--
-- `SET search_path = ''` en prime : sans lui, une fonction `SECURITY DEFINER`
-- résout ses noms de tables dans le schéma de l'appelant.

CREATE OR REPLACE FUNCTION public.cleanup_old_audit_logs(retention_days INTEGER DEFAULT 365)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.audit_logs
   WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_old_audit_logs(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_audit_logs(INTEGER) TO service_role;

-- ─────────────────────────────────────────────────────────
-- 4. `get_performance_stats` : rétablir la règle de la 039
-- ─────────────────────────────────────────────────────────
--
-- La migration 039 a ajouté `AND source = 'citizen'` : la page Performance ne
-- chronomètre que les signalements d'habitants, parce qu'un signalement saisi
-- par un agent le jour où il le résout afficherait un délai nul et écraserait
-- la moyenne.
--
-- La migration 041, écrite le 11 novembre pour faire démarrer le chronomètre à
-- l'activation de la commune, a recopié le corps de la fonction depuis la
-- **031** — antérieure à la 039 — et a donc supprimé cette clause. Régression
-- déployée, relevée par l'audit du lendemain. On ne recopie plus : on modifie
-- la seule ligne qui doit l'être.
--
-- C'est la deuxième fois que cette règle se perd. Un test pgTAP sur
-- `get_performance_stats`, avec un signalement `source = 'agent'` résolu le
-- jour même, est la seule façon de la tenir.

CREATE OR REPLACE FUNCTION public.get_performance_stats(
  p_tenant_id UUID,
  p_days      INTEGER DEFAULT 30
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since  TIMESTAMPTZ := now() - (p_days || ' days')::INTERVAL;
  v_result JSON;
BEGIN

  -- Rien ne se chronomètre avant que la commune ait eu les moyens d'agir
  -- (migration 041).
  SELECT GREATEST(v_since, COALESCE(t.activated_at, v_since))
    INTO v_since
    FROM public.tenants t
   WHERE t.id = p_tenant_id;

  WITH
  period_reports AS (
    SELECT id, category, status, created_at
    FROM   public.reports
    WHERE  tenant_id = p_tenant_id
      AND  created_at >= v_since
      -- Migration 039 : un signalement saisi par un agent n'est pas chronométré.
      AND  source = 'citizen'
  ),

  first_ack AS (
    SELECT DISTINCT ON (sh.report_id)
           sh.report_id,
           sh.changed_at AS acked_at
    FROM   public.status_history sh
    JOIN   period_reports pr ON pr.id = sh.report_id
    WHERE  sh.new_status = 'pris_en_charge'
    ORDER  BY sh.report_id, sh.changed_at
  ),

  first_resolve AS (
    SELECT DISTINCT ON (sh.report_id)
           sh.report_id,
           sh.changed_at AS resolved_at
    FROM   public.status_history sh
    JOIN   period_reports pr ON pr.id = sh.report_id
    WHERE  sh.new_status = 'resolu'
    ORDER  BY sh.report_id, sh.changed_at
  ),

  cats AS (
    SELECT c.slug,
           COALESCE(tc.label,     c.label_default) AS label,
           COALESCE(tc.icon,      c.icon)          AS icon,
           COALESCE(tc.sla_hours, 168)             AS sla_hours
    FROM   public.categories c
    LEFT   JOIN public.tenant_categories tc
             ON tc.tenant_id     = p_tenant_id
            AND tc.category_slug = c.slug
    WHERE  COALESCE(tc.is_active, TRUE)
  ),

  global_stats AS (
    SELECT
      COUNT(*)                                                  AS total_reports,
      COUNT(fr.report_id)                                       AS resolved_reports,
      ROUND(100.0 * COUNT(fr.report_id) / NULLIF(COUNT(*), 0))  AS resolution_rate,
      ROUND(AVG(
        EXTRACT(EPOCH FROM (fa.acked_at - pr.created_at)) / 3600.0
      ))                                                        AS avg_ack_hours,
      ROUND(AVG(
        EXTRACT(EPOCH FROM (fr.resolved_at - pr.created_at)) / 3600.0
      ))                                                        AS avg_resolve_hours,
      ROUND(100.0 * SUM(
        CASE
          WHEN fr.report_id IS NOT NULL
            AND EXTRACT(EPOCH FROM (fr.resolved_at - pr.created_at)) / 3600.0 <= c.sla_hours
          THEN 1 ELSE 0
        END
      ) / NULLIF(COUNT(fr.report_id), 0))                       AS sla_compliance_rate
    FROM  period_reports pr
    LEFT  JOIN first_ack     fa ON fa.report_id = pr.id
    LEFT  JOIN first_resolve fr ON fr.report_id = pr.id
    LEFT  JOIN cats          c  ON c.slug = pr.category
  ),

  cat_stats AS (
    SELECT
      c.slug,
      c.label,
      c.icon,
      c.sla_hours,
      COUNT(pr.id)                                              AS report_count,
      COUNT(fr.report_id)                                       AS resolved_count,
      ROUND(AVG(
        EXTRACT(EPOCH FROM (fr.resolved_at - pr.created_at)) / 3600.0
      ))                                                        AS avg_resolve_hours,
      ROUND(100.0 * SUM(
        CASE
          WHEN fr.report_id IS NOT NULL
            AND EXTRACT(EPOCH FROM (fr.resolved_at - pr.created_at)) / 3600.0 <= c.sla_hours
          THEN 1 ELSE 0
        END
      ) / NULLIF(COUNT(fr.report_id), 0))                       AS sla_compliance_rate
    FROM  cats c
    LEFT  JOIN period_reports pr ON pr.category = c.slug
    LEFT  JOIN first_resolve fr  ON fr.report_id = pr.id
    GROUP BY c.slug, c.label, c.icon, c.sla_hours
    ORDER BY COUNT(pr.id) DESC, c.label
  ),

  monthly AS (
    SELECT
      TO_CHAR(gs.month, 'YYYY-MM') AS month,
      COUNT(pr.id)                 AS created,
      COUNT(fr.report_id)          AS resolved
    FROM  generate_series(
            date_trunc('month', now()) - INTERVAL '5 months',
            date_trunc('month', now()),
            '1 month'
          ) AS gs(month)
    LEFT  JOIN period_reports pr
            ON date_trunc('month', pr.created_at) = gs.month
    LEFT  JOIN first_resolve fr
            ON fr.report_id = pr.id
           AND date_trunc('month', fr.resolved_at) = gs.month
    GROUP BY gs.month
    ORDER BY gs.month
  )

  SELECT json_build_object(
    'total_reports',             g.total_reports,
    'resolved_reports',          g.resolved_reports,
    'resolution_rate',           COALESCE(g.resolution_rate, 0),
    'avg_time_to_ack_hours',     g.avg_ack_hours,
    'avg_time_to_resolve_hours', g.avg_resolve_hours,
    'sla_compliance_rate',       g.sla_compliance_rate,
    'by_category',               COALESCE((SELECT json_agg(row_to_json(cs)) FROM cat_stats cs), '[]'::json),
    'monthly',                   COALESCE((SELECT json_agg(row_to_json(m))  FROM monthly m),   '[]'::json)
  )
  INTO v_result
  FROM global_stats g;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_performance_stats(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_performance_stats(UUID, INTEGER) TO service_role;

-- ─────────────────────────────────────────────────────────
-- 5. Deux tables dont le RLS n'était écrit nulle part
-- ─────────────────────────────────────────────────────────
--
-- `categories` et `report_counters` n'ont d'`ENABLE ROW LEVEL SECURITY` dans
-- aucune des 42 migrations. Le comportement observé est sûr — PostgREST rend
-- `[]` — donc le réglage a été posé à la main dans le tableau de bord. Une
-- table recréée depuis le dépôt n'en bénéficierait pas, et personne ne s'en
-- apercevrait : une table ouverte ne produit aucune erreur.
--
-- `IF NOT EXISTS` partout : cette migration doit pouvoir être rejouée.

ALTER TABLE public.categories      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_counters ENABLE ROW LEVEL SECURITY;

-- La taxonomie nationale est publique par nature : l'application affiche ses
-- libellés. Elle le reste donc, mais explicitement, et en lecture seule.
DROP POLICY IF EXISTS "categories_select" ON public.categories;
CREATE POLICY "categories_select" ON public.categories FOR SELECT
TO anon, authenticated USING (true);

-- Les compteurs de références n'intéressent personne d'autre que le trigger,
-- qui s'exécute en `SECURITY DEFINER`. Aucune politique : donc aucun accès.

-- ─────────────────────────────────────────────────────────
-- 6. Vérifications — à exécuter après coup, et à relire
-- ─────────────────────────────────────────────────────────

-- (a) Plus aucune fonction `SECURITY DEFINER` exécutable sans compte.
--     Aucune ligne ne doit ressortir avec `anon_peut` ou `auth_peut` à true,
--     hormis les prédicats de RLS (`is_*`), qui ne répondent que sur l'appelant.
SELECT p.proname,
       p.prosecdef,
       p.proconfig,
       has_function_privilege('anon', p.oid, 'execute')          AS anon_peut,
       has_function_privilege('authenticated', p.oid, 'execute') AS auth_peut
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname = 'public'
  AND  p.prosecdef
ORDER  BY anon_peut DESC, p.proname;

-- (b) Les colonnes sensibles de `reports` ne sont plus lisibles.
--     Doit rendre 0 ligne.
SELECT grantee, table_name, column_name
FROM   information_schema.column_privileges
WHERE  table_schema = 'public'
  AND  table_name   = 'reports'
  AND  column_name IN ('anonymous_token', 'anonymous_email', 'user_id', 'insee_code')
  AND  grantee IN ('anon', 'authenticated');

-- (c) Ce que `tenants` laisse voir.
SELECT grantee, column_name
FROM   information_schema.column_privileges
WHERE  table_schema = 'public' AND table_name = 'tenants'
  AND  grantee IN ('anon', 'authenticated')
ORDER  BY grantee, column_name;

-- (d) Les tables sans RLS, s'il en reste.
SELECT c.relname
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
ORDER  BY c.relname;
