-- Migration 026 : taxonomie canonique
--
-- `tenant_categories` faisait deux métiers dans une seule ligne : définir *ce
-- qui existe* et *qui le reçoit*. C'était le bon compromis quand chaque commune
-- distribuait sa propre app et que le citoyen choisissait lui-même dans sa
-- liste. La v2 le casse sur trois points :
--
--  - **l'IA choisit désormais la catégorie**, et son espace de sortie changeait
--    à chaque client. La même photo de matelas devenait « Encombrants » ici,
--    « Propreté » là, « Autre » ailleurs : impossible de mesurer la justesse du
--    modèle, donc de l'améliorer ;
--  - **un tenant prospect n'a personne pour le configurer**. Pendant l'amorçage
--    national, la liste par défaut *est* la taxonomie de la majorité des
--    signalements ;
--  - **la comparaison entre communes disparaît**. `addCategory()` côté admin
--    générait un slug horodaté (`cat_1757836291043`) : deux communes créant
--    « Dépôts sauvages » obtenaient deux valeurs sans rapport.
--
-- La mairie garde ce qui relève de son organisation — le libellé affiché, le
-- service destinataire, le délai, l'activation. Elle ne définit plus l'ontologie.

-- ─────────────────────────────────────────────────────────
-- 1. La liste nationale
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.categories (
  slug          TEXT PRIMARY KEY,
  label_default TEXT NOT NULL,
  -- Lue telle quelle dans le prompt de l'IA : c'est elle qui décide du
  -- classement, pas le slug.
  description   TEXT NOT NULL,
  icon          TEXT NOT NULL DEFAULT '📌',
  sort_order    INTEGER NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.categories IS
  'Taxonomie nationale. Espace de sortie de l''IA et clé de toute statistique inter-communes.';

-- Calibrée sur la distribution réelle : 1,54 million d'anomalies publiées en
-- open data par la Ville de Paris via Dans Ma Rue. Les encombrants, les
-- graffitis et la propreté y pèsent 82 % à eux trois ; la voirie, 3,8 %.
INSERT INTO public.categories (slug, label_default, description, icon, sort_order) VALUES
  ('encombrants',   'Objets abandonnés et encombrants',
   'matelas, meuble, électroménager, carton, sac ou objet volumineux laissé sur la voie publique', '🛋️', 1),
  ('graffitis',     'Graffitis, tags et affichage sauvage',
   'tag, graffiti, autocollant ou affiche collée sans autorisation sur un mur, un mobilier ou une vitrine', '🎨', 2),
  ('proprete',      'Propreté et déchets',
   'corbeille pleine ou cassée, déchets au sol, souillure, déjection, conteneur débordant', '🗑️', 3),
  ('stationnement', 'Véhicules gênants et épaves',
   'voiture, deux-roues ou trottinette mal garée, gênante, ventouse ou à l''état d''épave', '🚗', 4),
  ('mobilier',      'Mobilier urbain et éclairage',
   'lampadaire éteint ou cassé, banc, abribus, poteau, panneau ou barrière dégradé', '💡', 5),
  ('voirie',        'Voirie et chaussée',
   'nid-de-poule, trottoir déformé, bordure descellée, marquage effacé, grille ou plaque manquante', '🚧', 6),
  ('commerce',      'Terrasses et occupations commerciales',
   'terrasse, étalage, chevalet ou dépôt de commerçant débordant sur le domaine public', '🏪', 7),
  ('vegetation',    'Arbres, végétation et animaux',
   'branche tombée ou menaçante, haie envahissante, herbes folles, arbre malade, animal mort ou errant', '🌿', 8),
  ('eau',           'Eau et assainissement',
   'fuite, écoulement, flaque persistante, bouche d''égout obstruée, avaloir bouché, fontaine en panne', '💧', 9),
  ('local',         'Spécificité locale',
   'situation propre à cette commune, décrite par elle — à n''utiliser que si aucune autre catégorie ne convient', '📍', 10),
  -- Le repli de l'IA quand la confiance est faible. Distinct de `local`, qui
  -- désigne une spécificité *connue* de la commune. Sur les 9 signalements de
  -- La Loupe aujourd'hui, 5 vivent dans « autre » : le retirer serait une erreur.
  ('autre',         'Autre',
   'problème qui ne correspond à aucune des catégories ci-dessus', '📌', 99)
ON CONFLICT (slug) DO UPDATE
  SET label_default = EXCLUDED.label_default,
      description   = EXCLUDED.description,
      icon          = EXCLUDED.icon,
      sort_order    = EXCLUDED.sort_order;

-- ─────────────────────────────────────────────────────────
-- 2. `tenant_categories` devient une correspondance
-- ─────────────────────────────────────────────────────────
--
-- La correspondance est **plusieurs-vers-un** : onze types canoniques face à
-- des listes locales arbitraires. Une simple mise à jour produit donc des
-- doublons, et l'index unique échoue. Observé sur les deux communes réelles :
--
--   Dreux     : `eclairage` + `mobilier_urbain` → `mobilier`
--   La Loupe  : `autre` + deux catégories créées à la main → `autre`
--
-- Il faut donc rattacher, **puis fusionner**, puis seulement indexer.

ALTER TABLE public.tenant_categories
  ADD COLUMN IF NOT EXISTS category_slug TEXT REFERENCES public.categories(slug);

-- 2a. Les slugs issus de l'amorçage, dont la correspondance est connue.
UPDATE public.tenant_categories SET category_slug = CASE slug
  WHEN 'voirie'          THEN 'voirie'
  WHEN 'eclairage'       THEN 'mobilier'
  WHEN 'mobilier_urbain' THEN 'mobilier'
  WHEN 'dechets'         THEN 'proprete'
  WHEN 'espaces_verts'   THEN 'vegetation'
  WHEN 'autre'           THEN 'autre'
  ELSE NULL
END
WHERE category_slug IS NULL;

-- 2b. Les catégories créées à la main dans l'admin — celles dont `addCategory()`
--     générait un slug horodaté, `cat_1775827638804`. Elles désignent quelque
--     chose de propre à la commune : la première devient sa `local`, les
--     suivantes tombent dans `autre` faute de mieux.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY sort_order, slug) AS rn
    FROM public.tenant_categories
   WHERE category_slug IS NULL
)
UPDATE public.tenant_categories tc
   SET category_slug = CASE WHEN r.rn = 1 THEN 'local' ELSE 'autre' END
  FROM ranked r
 WHERE r.id = tc.id;

-- ─────────────────────────────────────────────────────────
-- 3. Les signalements pointent sur la liste nationale
-- ─────────────────────────────────────────────────────────
--
-- **Avant** la fusion : les signalements référencent le slug *local*, et
-- supprimer les doublons d'abord les rendrait orphelins.

UPDATE public.reports r
   SET category = tc.category_slug
  FROM public.tenant_categories tc
 WHERE tc.tenant_id = r.tenant_id
   AND tc.slug = r.category
   AND tc.category_slug IS NOT NULL
   AND r.category <> tc.category_slug;

UPDATE public.reports
   SET category = 'autre'
 WHERE category NOT IN (SELECT slug FROM public.categories);

-- ─────────────────────────────────────────────────────────
-- 4. Fusionner les doublons, sans rien perdre du routage
-- ─────────────────────────────────────────────────────────
--
-- Le survivant de chaque groupe est celui dont le slug local est déjà le slug
-- canonique — sinon le premier dans l'ordre d'affichage. Il hérite de **l'union**
-- des adresses de service : en perdre une ferait taire les notifications d'un
-- service entier sans que personne ne s'en aperçoive.

WITH ranked AS (
  SELECT id, tenant_id, category_slug,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, category_slug
           ORDER BY (slug = category_slug) DESC, sort_order, slug
         ) AS rn,
         COUNT(*) OVER (PARTITION BY tenant_id, category_slug) AS group_size
    FROM public.tenant_categories
   WHERE category_slug IS NOT NULL
)
UPDATE public.tenant_categories tc
   SET service_emails = COALESCE((
         SELECT array_agg(DISTINCT e)
           FROM public.tenant_categories x, unnest(x.service_emails) AS e
          WHERE x.tenant_id = r.tenant_id AND x.category_slug = r.category_slug
       ), '{}'),
       is_active = (
         SELECT bool_or(x.is_active)
           FROM public.tenant_categories x
          WHERE x.tenant_id = r.tenant_id AND x.category_slug = r.category_slug
       ),
       sort_order = (
         SELECT min(x.sort_order)
           FROM public.tenant_categories x
          WHERE x.tenant_id = r.tenant_id AND x.category_slug = r.category_slug
       ),
       -- Quand plusieurs lignes fusionnent, le libellé de l'une d'elles
       -- décrirait mal l'ensemble : « Éclairage public » pour une catégorie qui
       -- couvre désormais aussi les bancs et les abribus. On repart du libellé
       -- national, que la commune pourra réécrire depuis l'admin.
       label = CASE WHEN r.group_size > 1
                    THEN (SELECT label_default FROM public.categories c WHERE c.slug = r.category_slug)
                    ELSE tc.label END
  FROM ranked r
 WHERE r.id = tc.id AND r.rn = 1;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, category_slug
           ORDER BY (slug = category_slug) DESC, sort_order, slug
         ) AS rn
    FROM public.tenant_categories
   WHERE category_slug IS NOT NULL
)
DELETE FROM public.tenant_categories tc
 USING ranked r
 WHERE r.id = tc.id AND r.rn > 1;

-- ─────────────────────────────────────────────────────────
-- 5. Une commune ne raccroche qu'une fois chaque type canonique
-- ─────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS tenant_categories_canonical_idx
  ON public.tenant_categories (tenant_id, category_slug);
