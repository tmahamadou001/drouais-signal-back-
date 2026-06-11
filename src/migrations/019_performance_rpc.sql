-- RPC: get_performance_stats(p_tenant_id, p_days)
-- Calcule les métriques de performance et SLA directement en SQL.
-- Utilise des window functions pour extraire le premier événement de chaque statut
-- par signalement sans rapatrier toutes les lignes côté application.

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
  v_since         TIMESTAMPTZ := now() - (p_days || ' days')::INTERVAL;
  v_result        JSON;
BEGIN

  WITH
  -- 1. Signalements de la période filtrés par tenant
  period_reports AS (
    SELECT id, category, status, created_at
    FROM   public.reports
    WHERE  tenant_id = p_tenant_id
      AND  created_at >= v_since
  ),

  -- 2. Premier événement "pris_en_charge" par signalement
  first_ack AS (
    SELECT DISTINCT ON (sh.report_id)
           sh.report_id,
           sh.changed_at AS acked_at
    FROM   public.status_history sh
    JOIN   period_reports pr ON pr.id = sh.report_id
    WHERE  sh.new_status = 'pris_en_charge'
    ORDER  BY sh.report_id, sh.changed_at
  ),

  -- 3. Premier événement "resolu" par signalement
  first_resolve AS (
    SELECT DISTINCT ON (sh.report_id)
           sh.report_id,
           sh.changed_at AS resolved_at
    FROM   public.status_history sh
    JOIN   period_reports pr ON pr.id = sh.report_id
    WHERE  sh.new_status = 'resolu'
    ORDER  BY sh.report_id, sh.changed_at
  ),

  -- 4. Catégories avec SLA
  cats AS (
    SELECT slug, label, icon, sla_hours
    FROM   public.tenant_categories
    WHERE  tenant_id = p_tenant_id
  ),

  -- 5. Résumé global
  global_stats AS (
    SELECT
      COUNT(*)                                                         AS total_reports,
      COUNT(fr.report_id)                                             AS resolved_reports,
      ROUND(100.0 * COUNT(fr.report_id) / NULLIF(COUNT(*), 0))       AS resolution_rate,
      ROUND(AVG(
        EXTRACT(EPOCH FROM (fa.acked_at - pr.created_at)) / 3600.0
      ))                                                              AS avg_ack_hours,
      ROUND(AVG(
        EXTRACT(EPOCH FROM (fr.resolved_at - pr.created_at)) / 3600.0
      ))                                                              AS avg_resolve_hours,
      ROUND(100.0 * SUM(
        CASE
          WHEN fr.report_id IS NOT NULL
            AND EXTRACT(EPOCH FROM (fr.resolved_at - pr.created_at)) / 3600.0 <= c.sla_hours
          THEN 1 ELSE 0
        END
      ) / NULLIF(COUNT(fr.report_id), 0))                             AS sla_compliance_rate
    FROM  period_reports pr
    LEFT  JOIN first_ack    fa ON fa.report_id = pr.id
    LEFT  JOIN first_resolve fr ON fr.report_id = pr.id
    LEFT  JOIN cats          c  ON c.slug = pr.category
  ),

  -- 6. Détail par catégorie
  cat_stats AS (
    SELECT
      c.label,
      c.icon,
      c.sla_hours,
      COUNT(pr.id)                                                     AS report_count,
      COUNT(fr.report_id)                                             AS resolved_count,
      ROUND(AVG(
        EXTRACT(EPOCH FROM (fr.resolved_at - pr.created_at)) / 3600.0
      ))                                                              AS avg_resolve_hours,
      ROUND(100.0 * SUM(
        CASE
          WHEN fr.report_id IS NOT NULL
            AND EXTRACT(EPOCH FROM (fr.resolved_at - pr.created_at)) / 3600.0 <= c.sla_hours
          THEN 1 ELSE 0
        END
      ) / NULLIF(COUNT(fr.report_id), 0))                             AS sla_compliance_rate
    FROM  cats c
    LEFT  JOIN period_reports pr ON pr.category = c.slug
    LEFT  JOIN first_resolve fr  ON fr.report_id = pr.id
    GROUP BY c.label, c.icon, c.sla_hours
    ORDER BY c.label
  ),

  -- 7. Buckets mensuels (6 mois glissants)
  monthly AS (
    SELECT
      TO_CHAR(gs.month, 'YYYY-MM')                                    AS month,
      COUNT(pr.id)                                                     AS created,
      COUNT(fr.report_id)                                             AS resolved
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
    'total_reports',          g.total_reports,
    'resolved_reports',       g.resolved_reports,
    'resolution_rate',        COALESCE(g.resolution_rate, 0),
    'avg_time_to_ack_hours',  g.avg_ack_hours,
    'avg_time_to_resolve_hours', g.avg_resolve_hours,
    'sla_compliance_rate',    g.sla_compliance_rate,
    'by_category',            COALESCE((SELECT json_agg(row_to_json(cs)) FROM cat_stats cs), '[]'::json),
    'monthly',                COALESCE((SELECT json_agg(row_to_json(m))  FROM monthly m),   '[]'::json)
  )
  INTO v_result
  FROM global_stats g;

  RETURN v_result;
END;
$$;

-- Pas de GRANT PUBLIC : appelé uniquement via service_role côté serveur
