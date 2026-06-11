-- ═══════════════════════════════════════════════════════════════
-- MIGRATION 016 — RPC : agrégation heatmap côté PostgreSQL
-- ═══════════════════════════════════════════════════════════════
--
-- Remplace le regroupement JS côté serveur (heatmap.ts) par une
-- agrégation SQL. Avec 50k signalements, l'ancienne version chargeait
-- toutes les lignes en mémoire et regroupait en JavaScript.
-- Cette fonction retourne directement les points agrégés + les stats.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_heatmap_data(
  p_tenant_id    UUID,
  p_period_days  INTEGER DEFAULT 30,   -- NULL = toutes les périodes
  p_category     TEXT    DEFAULT NULL, -- NULL = toutes les catégories
  p_status       TEXT    DEFAULT NULL  -- NULL = tous les statuts
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ;
  v_points JSON;
  v_by_category JSON;
  v_by_status JSON;
  v_hotspots JSON;
  v_total INT;
BEGIN
  -- Date de coupure pour le filtre période
  IF p_period_days IS NOT NULL THEN
    v_cutoff := NOW() - (p_period_days || ' days')::INTERVAL;
  END IF;

  -- ── Points agrégés par coordonnées arrondies ──────────────────
  SELECT json_agg(row_to_json(agg)) INTO v_points
  FROM (
    SELECT
      ROUND(lat::NUMERIC, 4)::FLOAT                               AS lat,
      ROUND(lng::NUMERIC, 4)::FLOAT                               AS lng,
      COUNT(*)                                                     AS signal_count,
      COALESCE(SUM(vote_count), 0)                                 AS total_votes,
      ROUND(COUNT(*) + COALESCE(SUM(vote_count), 0) * 0.5, 1)     AS weight,
      MODE() WITHIN GROUP (ORDER BY category)                      AS dominant_category,
      MAX(address_approx)                                          AS address_approx
    FROM public.reports
    WHERE
      tenant_id = p_tenant_id
      AND lat IS NOT NULL
      AND lng IS NOT NULL
      AND (v_cutoff IS NULL OR created_at >= v_cutoff)
      AND (p_category IS NULL OR category = p_category)
      AND (p_status   IS NULL OR status   = p_status)
    GROUP BY ROUND(lat::NUMERIC, 4), ROUND(lng::NUMERIC, 4)
    ORDER BY signal_count DESC
  ) agg;

  -- ── Répartition par catégorie ─────────────────────────────────
  SELECT json_object_agg(category, cnt) INTO v_by_category
  FROM (
    SELECT category, COUNT(*) AS cnt
    FROM public.reports
    WHERE
      tenant_id = p_tenant_id
      AND (v_cutoff IS NULL OR created_at >= v_cutoff)
      AND (p_category IS NULL OR category = p_category)
      AND (p_status   IS NULL OR status   = p_status)
    GROUP BY category
  ) s;

  -- ── Répartition par statut ────────────────────────────────────
  SELECT json_object_agg(status, cnt) INTO v_by_status
  FROM (
    SELECT status, COUNT(*) AS cnt
    FROM public.reports
    WHERE
      tenant_id = p_tenant_id
      AND (v_cutoff IS NULL OR created_at >= v_cutoff)
      AND (p_category IS NULL OR category = p_category)
      AND (p_status   IS NULL OR status   = p_status)
    GROUP BY status
  ) s;

  -- ── Total ─────────────────────────────────────────────────────
  SELECT COUNT(*) INTO v_total
  FROM public.reports
  WHERE
    tenant_id = p_tenant_id
    AND (v_cutoff IS NULL OR created_at >= v_cutoff)
    AND (p_category IS NULL OR category = p_category)
    AND (p_status   IS NULL OR status   = p_status);

  -- ── Top 5 hotspots ────────────────────────────────────────────
  SELECT json_agg(row_to_json(h)) INTO v_hotspots
  FROM (
    SELECT
      ROUND(lat::NUMERIC, 4)::FLOAT           AS lat,
      ROUND(lng::NUMERIC, 4)::FLOAT           AS lng,
      COUNT(*)                                 AS count,
      MODE() WITHIN GROUP (ORDER BY category) AS dominant_category,
      MAX(address_approx)                      AS address_approx
    FROM public.reports
    WHERE
      tenant_id = p_tenant_id
      AND lat IS NOT NULL
      AND lng IS NOT NULL
      AND (v_cutoff IS NULL OR created_at >= v_cutoff)
      AND (p_category IS NULL OR category = p_category)
      AND (p_status   IS NULL OR status   = p_status)
    GROUP BY ROUND(lat::NUMERIC, 4), ROUND(lng::NUMERIC, 4)
    ORDER BY count DESC
    LIMIT 5
  ) h;

  RETURN json_build_object(
    'points', COALESCE(v_points,    '[]'::JSON),
    'stats', json_build_object(
      'total_points', v_total,
      'hotspots',     COALESCE(v_hotspots,    '[]'::JSON),
      'by_category',  COALESCE(v_by_category, '{}'::JSON),
      'by_status',    COALESCE(v_by_status,   '{}'::JSON)
    )
  );
END;
$$;

-- Accès uniquement aux utilisateurs authentifiés (route protégée requireTenantAdmin)
REVOKE EXECUTE ON FUNCTION get_heatmap_data(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_heatmap_data(UUID, INTEGER, TEXT, TEXT) TO authenticated;
GRANT  EXECUTE ON FUNCTION get_heatmap_data(UUID, INTEGER, TEXT, TEXT) TO service_role;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 016 : fonction get_heatmap_data() créée';
END $$;
