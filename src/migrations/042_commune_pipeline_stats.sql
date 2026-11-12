-- Migration 042 : les chiffres d'une commune non partenaire, en une requête
--
-- L'écran Prospects affichait deux nombres par commune, et les obtenait par
-- deux requêtes **par commune**, dans un `Promise.all` (`routes/tenant.ts`).
-- Tenable à vingt communes, intenable à quatre cents — et c'est quatre cents
-- qu'on vise, puisqu'une commune entre dans ce tableau au premier signalement
-- de n'importe lequel de ses habitants.
--
-- L'écran change aussi de rôle. Il servait à préparer un rendez-vous commercial ;
-- il sert désormais à **décider d'ouvrir une commune au public** (migration 040),
-- ce qui demande de savoir si le fonds vaut une page publique : est-il vivant,
-- combien d'habitants distincts, avec quelles photos, sur quels sujets.
--
-- D'où une fonction unique qui rend tout le tableau d'un coup.

CREATE OR REPLACE FUNCTION public.commune_pipeline_stats()
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH communes AS (
    SELECT t.id, t.slug, t.name, t.status, t.created_at, t.published_at
    FROM   public.tenants t
    WHERE  t.status IN ('prospect', 'community')
  ),

  territories AS (
    SELECT tt.tenant_id,
           array_agg(tt.insee_code ORDER BY tt.insee_code) AS insee_codes
    FROM   public.tenant_territories tt
    JOIN   communes c ON c.id = tt.tenant_id
    GROUP  BY tt.tenant_id
  ),

  -- Tout ce qui se lit sur les signalements de la commune, en une passe.
  --
  -- `account_count` compte les comptes distincts ; `anonymous_count` compte
  -- les dépôts sans compte, qu'on ne peut pas dédoublonner — deux dépôts
  -- anonymes peuvent venir de la même personne. Les additionner en un seul
  -- « nombre d'habitants » donnerait un chiffre faux présenté à un maire, ce
  -- qui est la pire façon de perdre un rendez-vous.
  report_stats AS (
    SELECT r.tenant_id,
           COUNT(*)                                                   AS report_count,
           COUNT(*) FILTER (WHERE r.created_at >= now() - INTERVAL '30 days')
                                                                      AS report_count_30d,
           MAX(r.created_at)                                          AS last_report_at,
           COUNT(DISTINCT r.user_id)                                  AS account_count,
           COUNT(*) FILTER (WHERE r.user_id IS NULL)                  AS anonymous_count,
           COUNT(*) FILTER (WHERE r.photo_url IS NOT NULL)            AS with_photo_count,
           COALESCE(SUM(r.vote_count), 0)                             AS confirmation_count
    FROM   public.reports r
    JOIN   communes c ON c.id = r.tenant_id
    GROUP  BY r.tenant_id
  ),

  -- Les trois sujets dont les habitants parlent le plus. C'est ce qui se dit à
  -- un maire : « vos administrés vous parlent d'éclairage », pas « vous avez
  -- 47 signalements ».
  ranked_categories AS (
    SELECT r.tenant_id,
           r.category,
           COUNT(*) AS count,
           ROW_NUMBER() OVER (PARTITION BY r.tenant_id ORDER BY COUNT(*) DESC, r.category) AS rank
    FROM   public.reports r
    JOIN   communes c ON c.id = r.tenant_id
    GROUP  BY r.tenant_id, r.category
  ),

  top_categories AS (
    SELECT rc.tenant_id,
           json_agg(json_build_object('category', rc.category, 'count', rc.count)
                    ORDER BY rc.rank) AS categories
    FROM   ranked_categories rc
    WHERE  rc.rank <= 3
    GROUP  BY rc.tenant_id
  ),

  -- La liste d'attente est indexée par code INSEE, pas par tenant : c'est une
  -- demande d'habitant, qui existe avant que la commune ait un identifiant.
  waitlist AS (
    SELECT t.tenant_id, COUNT(*) AS waitlist_count
    FROM   public.commune_waitlist w
    JOIN   public.tenant_territories t ON t.insee_code = w.insee_code
    JOIN   communes c ON c.id = t.tenant_id
    GROUP  BY t.tenant_id
  )

  SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.report_count DESC, x.name), '[]'::json)
  FROM (
    SELECT c.id,
           c.slug,
           c.name,
           c.status,
           c.created_at,
           c.published_at,
           COALESCE(t.insee_codes, ARRAY[]::TEXT[])  AS insee_codes,
           COALESCE(s.report_count, 0)               AS report_count,
           COALESCE(s.report_count_30d, 0)           AS report_count_30d,
           s.last_report_at,
           COALESCE(s.account_count, 0)              AS account_count,
           COALESCE(s.anonymous_count, 0)            AS anonymous_count,
           COALESCE(s.with_photo_count, 0)           AS with_photo_count,
           COALESCE(s.confirmation_count, 0)         AS confirmation_count,
           COALESCE(w.waitlist_count, 0)             AS waitlist_count,
           COALESCE(tc.categories, '[]'::json)       AS top_categories
    FROM   communes c
    LEFT   JOIN territories    t  ON t.tenant_id  = c.id
    LEFT   JOIN report_stats   s  ON s.tenant_id  = c.id
    LEFT   JOIN top_categories tc ON tc.tenant_id = c.id
    LEFT   JOIN waitlist       w  ON w.tenant_id  = c.id
  ) x;
$$;

-- Une fonction SECURITY DEFINER est exécutable par PUBLIC si on ne dit rien, et
-- celle-ci rend l'intégralité du pipeline commercial — la liste des communes
-- qu'on démarche, avec leurs volumes. Elle n'appartient qu'au serveur, qui
-- vérifie `requirePlatformAdmin` avant de l'appeler (migration 038).
REVOKE ALL ON FUNCTION public.commune_pipeline_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commune_pipeline_stats() TO service_role;
