-- Migration 031 : `get_performance_stats` lit la taxonomie canonique
--
-- La fonction datait de la migration 019, donc d'avant la taxonomie nationale.
-- Sa CTE `cats` lisait `tenant_categories.slug` — le slug *local* — et le
-- joignait à `reports.category`, qui porte le slug *canonique* depuis la
-- migration 026. Chez une commune qui avait renommé ses catégories, la jointure
-- ne retombait jamais : le détail par catégorie affichait zéro signalement
-- partout, et le respect des SLA global se calculait sans aucun `sla_hours`.
--
-- C'est la même régression que celle corrigée dans `sendServiceNotification`.
-- Elle est ici réparée à la source : la liste part de `categories`, et
-- `tenant_categories` n'apporte que ce que la commune a décidé.
--
-- La sortie gagne `slug` : le client en a besoin pour dessiner le glyphe de la
-- catégorie, et un libellé n'est pas un identifiant.

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

  WITH
  period_reports AS (
    SELECT id, category, status, created_at
    FROM   public.reports
    WHERE  tenant_id = p_tenant_id
      AND  created_at >= v_since
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

  -- La taxonomie nationale, vue par cette commune.
  --
  -- `LEFT JOIN` et non `JOIN` : une catégorie que la mairie n'a pas configurée
  -- reste offerte au citoyen, donc reste mesurée. Une absence de ligne est une
  -- absence de décision, pas un refus — et c'est le cas nominal d'un prospect.
  -- 168 h (une semaine) est le même défaut que côté applicatif.
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

-- Pas de GRANT PUBLIC : appelé uniquement via service_role côté serveur
