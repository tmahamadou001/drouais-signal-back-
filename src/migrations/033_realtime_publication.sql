-- Migration 033 : la réplication temps réel devient explicite
--
-- `report_comments` a été ajoutée à la publication par la migration 011.
-- `reports`, jamais : le tableau de bord en direct du back-office dépendait donc
-- d'une case cochée à la main dans le tableau de bord Supabase. Rien ne le
-- documentait, et rien ne l'aurait rétabli sur un nouvel environnement — le flux
-- serait simplement resté muet, sans erreur, avec un badge « Flux en direct »
-- affiché en vert.
--
-- Ce qui fait vivre une fonctionnalité doit être dans une migration.

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.reports;
EXCEPTION
  WHEN duplicate_object THEN NULL;  -- déjà publiée, rien à faire
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.report_comments;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- `postgres_changes` ne transmet l'ancienne ligne (`payload.old`) que si la
-- table a une identité de réplica complète. Sans elle, le back-office reçoit le
-- nouveau statut sans l'ancien et ne peut pas décrémenter le bon compteur.
ALTER TABLE public.reports REPLICA IDENTITY FULL;
