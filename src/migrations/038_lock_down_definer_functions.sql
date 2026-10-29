-- Migration 038 : les fonctions `SECURITY DEFINER` ne sont plus appelables par
-- n'importe quel porteur de jeton
--
-- Une fonction créée sans mention de droits est exécutable par `PUBLIC` — donc
-- par `anon` et par `authenticated`. Tant que la seule façon d'obtenir un jeton
-- était de se connecter à un compte de mairie, la question restait théorique.
-- Depuis que les connexions anonymes sont activées, **toute installation de
-- l'application obtient un jeton `authenticated`** : ce qui était une porte
-- fermée par l'absence de visiteurs devient une porte ouverte.
--
-- `SECURITY DEFINER` veut dire « exécutée avec les droits du propriétaire »,
-- c'est-à-dire **sans RLS**. Une telle fonction appelable par tous est un
-- contournement du cloisonnement par commune, offert en libre-service.

-- ─────────────────────────────────────────────────────────
-- 1. `get_performance_stats` — la seule vraie fuite
-- ─────────────────────────────────────────────────────────
--
-- Elle prend un `p_tenant_id` en paramètre et ne vérifie pas qui appelle. Un
-- jeton quelconque suffisait donc à lire les délais de traitement de
-- n'importe quelle commune de la plateforme :
--
--   supabase.rpc('get_performance_stats', { p_tenant_id: '<uuid>' })
--
-- Le seul appelant légitime est le serveur, qui passe par la clé
-- `service_role` après avoir vérifié le rôle (`GET /api/admin/performance`,
-- `requireTeamMember`). Personne d'autre n'a de raison de l'appeler.
--
-- On révoque plutôt que d'ajouter un contrôle à l'intérieur : `auth.uid()` est
-- NULL pour la `service_role`, donc un contrôle interne casserait l'appel
-- légitime tout en laissant la fonction exposée.

REVOKE ALL ON FUNCTION public.get_performance_stats(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_performance_stats(UUID, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.get_performance_stats(UUID, INTEGER) FROM authenticated;
-- Explicite : la `service_role` tient son droit de `PUBLIC` pour une fonction
-- créée par migration. Le révoquer sans le rendre couperait la page
-- Performance du back-office.
GRANT EXECUTE ON FUNCTION public.get_performance_stats(UUID, INTEGER) TO service_role;

-- ─────────────────────────────────────────────────────────
-- 2. Les fonctions de déclencheur
-- ─────────────────────────────────────────────────────────
--
-- `assign_report_reference` attribue `LAL-2026-00418` à l'insertion et
-- `update_vote_count` tient le compteur de confirmations. Un déclencheur
-- s'exécute avec les droits de la table, pas avec ceux de l'appelant : leur
-- retirer `EXECUTE` n'empêche rien de ce pour quoi elles existent, et empêche
-- qu'on les appelle à la main — consommer des numéros de référence, ou
-- réécrire un compteur de constats.

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.assign_report_reference() FROM PUBLIC, anon, authenticated';
EXCEPTION
  WHEN undefined_function THEN NULL;
END $$;

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.update_vote_count() FROM PUBLIC, anon, authenticated';
EXCEPTION
  WHEN undefined_function THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────
-- 3. `is_admin()` — morte et trompeuse
-- ─────────────────────────────────────────────────────────
--
-- Héritée de la migration 005, réécrite par la 013. Elle teste
-- `app_metadata.role = 'admin'` : une valeur que **rien n'écrit**, puisque
-- `app_metadata` ne porte que `super_admin` et que les rôles de commune vivent
-- dans `tenant_users`. Elle répond donc toujours faux.
--
-- Elle n'est utilisée par aucune politique **du dépôt** — mais par deux
-- politiques de `storage.objects`, `delete_photo_by_admin`, créées à la main
-- dans le tableau de bord et donc absentes de toute migration. C'est
-- précisément ce que cette fonction avait de dangereux : elles autorisent la
-- suppression d'une photo « si is_admin() », c'est-à-dire jamais. Une règle
-- qui a l'air d'accorder un droit et n'en accorde aucun.
--
-- Rien ne s'appuie dessus : les photos sont supprimées par le serveur
-- (`lib/photoStorage.ts`) avec la clé `service_role`, qui contourne le RLS, et
-- aucun client ne touche au stockage. Les retirer ne retire donc aucun accès
-- réel — cela enlève une permission morte, jamais une permission utilisée.

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT polname
      FROM pg_policy
     WHERE polrelid = 'storage.objects'::regclass
       AND (
         COALESCE(pg_get_expr(polqual, polrelid), '') ILIKE '%is_admin()%'
         OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') ILIKE '%is_admin()%'
       )
  LOOP
    EXECUTE format('DROP POLICY %I ON storage.objects', pol.polname);
    RAISE NOTICE 'politique de stockage morte retirée : %', pol.polname;
  END LOOP;
EXCEPTION
  -- `storage.objects` appartient à `supabase_storage_admin`. Si le rôle qui
  -- exécute cette migration n'en est pas membre, on ne casse pas la migration
  -- pour autant : les deux politiques se suppriment alors depuis
  -- Storage → Policies, et cette migration est rejouable.
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'droits insuffisants sur storage.objects — retirer « delete_photo_by_admin » depuis le tableau de bord, puis rejouer.';
END $$;

DROP FUNCTION IF EXISTS public.is_admin();

-- ─────────────────────────────────────────────────────────
-- 4. Ce qui reste signalé, et pourquoi c'est correct
-- ─────────────────────────────────────────────────────────
--
-- `is_tenant_member`, `is_tenant_admin`, `is_active_tenant_member` et
-- `is_super_admin` restent exécutables par `authenticated` : c'est nécessaire,
-- puisque ce sont les politiques RLS elles-mêmes qui les appellent au nom de
-- l'utilisateur. Elles ne rendent qu'un booléen **sur l'appelant** — « suis-je
-- membre de cette commune ? » — dont il connaît déjà la réponse, et n'exposent
-- aucune ligne. Une session anonyme y répond toujours faux.
--
-- `st_estimatedextent` appartient à PostGIS, comme l'extension installée dans
-- le schéma `public` : ni l'une ni l'autre ne sont à nous, et déplacer PostGIS
-- après coup casse les index et les colonnes `geography` pour un gain nul.
