-- Migration 035 : la récursion infinie des politiques de `tenant_users`
--
-- Les quatre politiques de la table interrogeaient `tenant_users` :
--
--   CREATE POLICY "tenant_users_select" ON tenant_users FOR SELECT
--   USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users …));
--
-- PostgreSQL applique alors la politique à la sous-requête, laquelle relance la
-- politique, indéfiniment : `42P17 — infinite recursion detected in policy for
-- relation "tenant_users"`.
--
-- Le serveur ne s'en apercevait pas : il passe par la clé `service_role`, qui
-- contourne le RLS. Toute la faute restait donc invisible jusqu'à ce qu'un
-- appel arrive avec un jeton d'utilisateur — le temps réel, ou une requête du
-- serveur ayant perdu son contournement (voir `lib/supabaseAuthClient.ts`).
--
-- La sortie classique : une fonction `SECURITY DEFINER`. Elle lit la table avec
-- les droits de son propriétaire, donc sans déclencher la politique, et la
-- politique n'interroge plus que la fonction.

-- ─────────────────────────────────────────────────────────
-- 1. Les deux questions que posent les politiques
-- ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_tenant_member(p_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
-- `search_path` vidé : une fonction `SECURITY DEFINER` s'exécute avec les
-- droits de son propriétaire, et un schéma détourné lui ferait exécuter autre
-- chose que ce qui est écrit ici.
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_users
     WHERE user_id = auth.uid()
       AND tenant_id = p_tenant_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_tenant_admin(p_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_users
     WHERE user_id = auth.uid()
       AND tenant_id = p_tenant_id
       AND role = 'admin'
       AND is_active = true
  );
$$;

/**
 * Le super administrateur, lu dans le jeton.
 *
 * `app_metadata` n'est écrivable que par la `service_role` : un utilisateur ne
 * peut pas se l'attribuer, contrairement à `user_metadata`.
 */
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin';
$$;

REVOKE ALL ON FUNCTION public.is_tenant_member(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_tenant_admin(UUID)  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_super_admin()       FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.is_tenant_member(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_tenant_admin(UUID)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_super_admin()       TO authenticated;

-- ─────────────────────────────────────────────────────────
-- 2. Les politiques, sans récursion
-- ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "tenant_users_select" ON public.tenant_users;
DROP POLICY IF EXISTS "tenant_users_insert" ON public.tenant_users;
DROP POLICY IF EXISTS "tenant_users_update" ON public.tenant_users;
DROP POLICY IF EXISTS "tenant_users_delete" ON public.tenant_users;

-- Un membre voit l'équipe de sa commune. C'est l'écran « Équipe », et il n'y a
-- rien de plus à y lire que la liste des collègues.
CREATE POLICY "tenant_users_select" ON public.tenant_users FOR SELECT TO authenticated
USING (
  public.is_super_admin() OR public.is_tenant_member(tenant_id)
);

CREATE POLICY "tenant_users_insert" ON public.tenant_users FOR INSERT TO authenticated
WITH CHECK (
  public.is_super_admin() OR public.is_tenant_admin(tenant_id)
);

CREATE POLICY "tenant_users_update" ON public.tenant_users FOR UPDATE TO authenticated
USING (
  public.is_super_admin() OR public.is_tenant_admin(tenant_id)
)
-- `WITH CHECK` en plus de `USING` : sans lui, un administrateur pourrait
-- modifier une ligne de sa commune pour la déplacer dans une autre.
WITH CHECK (
  public.is_super_admin() OR public.is_tenant_admin(tenant_id)
);

CREATE POLICY "tenant_users_delete" ON public.tenant_users FOR DELETE TO authenticated
USING (
  public.is_super_admin() OR public.is_tenant_admin(tenant_id)
);
