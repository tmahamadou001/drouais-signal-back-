-- Migration 037 : `reports` redevient lisible pour le temps réel
--
-- Symptôme : le back-office recevait en direct la réponse d'un habitant, mais
-- jamais l'arrivée d'un signalement. Le badge « Flux en direct » restait vert,
-- la table `reports` était bien dans la publication (migration 033), et rien
-- n'apparaissait.
--
-- Cause : la politique de lecture.
--
--   CREATE POLICY "reports_select" ON reports FOR SELECT
--   USING (tenant_id IN (
--     SELECT id FROM tenants
--     WHERE slug = current_setting('app.current_tenant', true) …));
--
-- `app.current_tenant` est une variable de session, héritée du modèle
-- mono-connexion de la migration 006 : l'API devait la poser à chaque requête.
-- Elle ne l'a **jamais** posée — `set_config` n'apparaît nulle part dans le
-- code — et personne ne s'en est aperçu, parce que le serveur passe par la clé
-- `service_role`, qui contourne le RLS.
--
-- La politique valait donc `slug = NULL`, c'est-à-dire *faux pour toute ligne*.
-- Sans conséquence tant que seul le serveur lisait la table ; fatale pour le
-- temps réel, qui, lui, évalue le RLS avec le jeton de l'abonné. Aucune ligne
-- lisible, donc aucun événement — ni INSERT, ni UPDATE : les changements de
-- statut étaient muets pour la même raison.
--
-- `report_comments` arrivait bien parce que sa politique (migration 014) pose
-- la question autrement : elle interroge `tenant_users` avec `auth.uid()`, ce
-- que le temps réel sait évaluer.
--
-- On remplace donc la condition par des faits que porte le jeton. Les
-- fonctions `SECURITY DEFINER` de la migration 035 sont réutilisées : une
-- politique sur `reports` qui interrogerait `tenant_users` directement
-- relancerait les politiques de cette table.

-- ─────────────────────────────────────────────────────────
-- 1. Membre *actif* d'une commune
-- ─────────────────────────────────────────────────────────
--
-- `is_tenant_member` ignore `is_active` : elle sert à l'écran Équipe, où un
-- membre suspendu doit rester visible. Pour lire les signalements, la
-- suspension doit compter — c'est le geste par lequel une commune retire
-- l'accès à quelqu'un qui l'a quittée.

CREATE OR REPLACE FUNCTION public.is_active_tenant_member(p_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
-- `search_path` vidé : voir la note de la migration 035.
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_users
     WHERE user_id = auth.uid()
       AND tenant_id = p_tenant_id
       AND is_active = true
  );
$$;

REVOKE ALL ON FUNCTION public.is_active_tenant_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_active_tenant_member(UUID) TO authenticated;

-- ─────────────────────────────────────────────────────────
-- 2. La lecture des signalements
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "reports_select" ON public.reports;

/**
 * Ce qui est publié est public.
 *
 * C'est déjà le cas par l'API : `GET /api/reports` répond sans compte, et
 * c'est chaque commune qui décide de publier les siens. Cette politique
 * n'ouvre donc rien de nouveau — elle permet au suivi public d'un signalement
 * (`/signalement/:id`, qui s'abonne aux changements de statut) de fonctionner
 * pour un visiteur sans compte, ce qu'il ne faisait pas davantage.
 *
 * `is_published` est faux pour les communes prospects : rien n'y est publié,
 * et la lecture directe reste fermée.
 */
CREATE POLICY "reports_select_published" ON public.reports FOR SELECT
TO anon, authenticated
USING (
  is_published = true
  AND EXISTS (
    SELECT 1 FROM public.tenants t
     WHERE t.id = reports.tenant_id
       AND t.status <> 'suspended'
  )
);

/**
 * Ce qu'un membre de la commune voit, et ce que chacun voit de soi.
 *
 * Aucune mention de `current_setting` : le jeton dit qui est là, et
 * l'appartenance se lit en base. C'est la même règle que le serveur applique
 * déjà dans ses gardes — ici elle devient vraie aussi pour qui lit la table
 * directement.
 */
CREATE POLICY "reports_select_team" ON public.reports FOR SELECT
TO authenticated
USING (
  public.is_super_admin()
  OR public.is_active_tenant_member(tenant_id)
  OR user_id = auth.uid()
);

-- ─────────────────────────────────────────────────────────
-- 3. Ce que cette migration ne corrige pas
-- ─────────────────────────────────────────────────────────
--
-- `status_history` et `votes` portent la même condition morte, héritée de la
-- même migration 006. Elles ne sont pas publiées en temps réel et personne ne
-- les lit hors du serveur : elles sont donc fermées sans que rien ne casse,
-- ce qui est le bon défaut. À reprendre le jour où l'une d'elles doit être lue
-- avec un jeton d'utilisateur — et non avant, pour ne pas ouvrir une table
-- sans qu'un besoin le demande.
