-- ═══════════════════════════════════════════════════════════════
-- MIGRATION 017 — RPC : opérations atomiques sur les reports
-- ═══════════════════════════════════════════════════════════════
--
-- Deux fonctions SQL pour garantir la cohérence des données :
--
-- 1. update_report_status_atomic() — met à jour le statut d'un report
--    ET insère l'entrée status_history dans la même transaction.
--    Avant : 2 appels séquentiels côté serveur pouvaient laisser
--    un report mis à jour sans entrée d'historique.
--
-- 2. insert_initial_status_history() — utilisée à la création d'un
--    report pour garantir que le premier historique existe toujours.
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────
-- 1. Mise à jour atomique du statut + historique
-- ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_report_status_atomic(
  p_report_id   UUID,
  p_new_status  TEXT,
  p_agent_id    UUID,
  p_tenant_id   UUID,
  p_comment     TEXT DEFAULT NULL
)
RETURNS SETOF reports
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_old_status TEXT;
BEGIN
  -- Récupérer le statut actuel et verrouiller la ligne
  SELECT status INTO v_old_status
  FROM public.reports
  WHERE id = p_report_id AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'report_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Mettre à jour le report
  UPDATE public.reports
  SET
    status     = p_new_status,
    updated_at = NOW()
  WHERE id = p_report_id;

  -- Insérer l'entrée d'historique dans la même transaction
  INSERT INTO public.status_history (
    report_id,
    old_status,
    new_status,
    agent_id,
    changed_at,
    comment,
    tenant_id
  ) VALUES (
    p_report_id,
    v_old_status,
    p_new_status,
    p_agent_id,
    NOW(),
    p_comment,
    p_tenant_id
  );

  RETURN QUERY
  SELECT * FROM public.reports WHERE id = p_report_id;
END;
$$;

-- ─────────────────────────────────────────────────────────
-- 2. Insertion initiale atomique (création de report)
-- ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION insert_initial_status_history(
  p_report_id TEXT,
  p_tenant_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.status_history (
    report_id,
    old_status,
    new_status,
    changed_at,
    tenant_id
  ) VALUES (
    p_report_id::UUID,
    'en_attente',
    'en_attente',
    NOW(),
    p_tenant_id
  );
END;
$$;

-- Accès service_role uniquement (appelées depuis le backend)
REVOKE EXECUTE ON FUNCTION update_report_status_atomic(UUID, TEXT, UUID, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_report_status_atomic(UUID, TEXT, UUID, UUID, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION update_report_status_atomic(UUID, TEXT, UUID, UUID, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION insert_initial_status_history(TEXT, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION insert_initial_status_history(TEXT, UUID) FROM anon;
GRANT  EXECUTE ON FUNCTION insert_initial_status_history(TEXT, UUID) TO service_role;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 017 : fonctions atomiques update_report_status_atomic() et insert_initial_status_history() créées';
END $$;
