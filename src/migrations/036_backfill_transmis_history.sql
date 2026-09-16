-- ═══════════════════════════════════════════════════════════════
-- MIGRATION 036 — Rattrapage de l'historique des transmissions
-- ═══════════════════════════════════════════════════════════════
--
-- La migration 034 a séparé « transmis » de « pris en charge », et a corrigé
-- les signalements que l'ancien code avait mis au mauvais statut :
--
--   UPDATE reports SET status = 'transmis' WHERE ... ;
--
-- Elle s'est arrêtée là. `status_history`, elle, continue de décrire ces
-- mêmes gestes comme des prises en charge — et c'est l'historique qui fait
-- foi partout ailleurs.
--
-- Ce que ça donnait à l'écran, côté habitant comme côté agent : une frise dont
-- l'étape courante, en bleu, annonce « à venir ». Elle cherche une entrée
-- `transmis` pour la dater, n'en trouve aucune, et conclut que rien n'est
-- arrivé — sur le statut que le signalement porte pourtant.
--
-- On réécrit donc l'historique avec exactement le critère que 034 avait retenu
-- pour les signalements : une transition vers `pris_en_charge`, sans agent, et
-- portant le commentaire que seul l'envoi automatique écrit. Aucune autre ligne
-- ne peut correspondre — un agent laisse toujours son `agent_id`.
--
-- ── L'ordre des deux mises à jour ──────────────────────────────────────────
--
-- **La ligne suivante d'abord, la ligne fautive ensuite.** Ce critère est le
-- seul repère dont on dispose pour retrouver ces lignes ; le renommer en
-- premier l'effacerait, et il n'y aurait plus moyen de savoir de quelle
-- transition partait la suivante. Rien n'est mémorisé entre les deux — une
-- table temporaire ne survivrait pas au pooler de Supabase, qui rend chaque
-- instruction dans sa propre session.
--
-- Les deux sont réexécutables : au second passage plus aucune ligne ne porte
-- le critère, et les deux ne touchent rien.
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────
-- 1. La ligne qui suit part maintenant de « transmis »
-- ─────────────────────────────────────────────────────────
--
-- Sans ça, l'historique ferait un saut : une transition qui prétend partir de
-- `pris_en_charge` alors que la précédente vient d'arriver ailleurs. On ne
-- corrige que la ligne immédiatement suivante — c'est le rôle du `NOT EXISTS`,
-- qui vérifie qu'aucune autre ne s'est glissée entre les deux — et seulement
-- si elle affirme venir de `pris_en_charge`.

UPDATE public.status_history h
   SET old_status = 'transmis'
 WHERE h.old_status = 'pris_en_charge'
   AND EXISTS (
     SELECT 1
       FROM public.status_history m
      WHERE m.report_id  = h.report_id
        AND m.new_status = 'pris_en_charge'
        AND m.agent_id IS NULL
        AND m.comment    = 'Transmis automatiquement au service concerné'
        AND m.changed_at < h.changed_at
        AND NOT EXISTS (
          SELECT 1
            FROM public.status_history between_rows
           WHERE between_rows.report_id  = h.report_id
             AND between_rows.changed_at > m.changed_at
             AND between_rows.changed_at < h.changed_at
        )
   );

-- ─────────────────────────────────────────────────────────
-- 2. Le geste reprend son nom
-- ─────────────────────────────────────────────────────────

UPDATE public.status_history
   SET new_status = 'transmis'
 WHERE new_status = 'pris_en_charge'
   AND agent_id IS NULL
   AND comment    = 'Transmis automatiquement au service concerné';

-- ─────────────────────────────────────────────────────────
-- 3. Ce que ça a donné
-- ─────────────────────────────────────────────────────────
--
-- Compté après coup : les lignes portent désormais `transmis`, et le critère
-- d'identification reste vrai pour tout le reste.

DO $$
DECLARE
  v_repaired  INTEGER;
  v_remaining INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_repaired
    FROM public.status_history
   WHERE new_status = 'transmis'
     AND agent_id IS NULL
     AND comment    = 'Transmis automatiquement au service concerné';

  -- Un signalement dont le statut courant n'a aucune entrée d'historique :
  -- c'est exactement ce que cette migration vient supprimer, et le chiffre
  -- doit être à zéro en sortie.
  SELECT COUNT(*) INTO v_remaining
    FROM public.reports r
   WHERE r.status <> 'en_attente'
     AND NOT EXISTS (
       SELECT 1
         FROM public.status_history h
        WHERE h.report_id  = r.id
          AND h.new_status = r.status
     );

  RAISE NOTICE '✅ Migration 036 : % transmission(s) nommée(s) correctement dans l''historique', v_repaired;
  RAISE NOTICE '   % signalement(s) restent sans historique pour leur statut courant', v_remaining;
END $$;
