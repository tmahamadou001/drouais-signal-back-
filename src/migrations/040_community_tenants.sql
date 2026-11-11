-- Migration 040 : les communes citoyennes
--
-- La migration 025 posait une alternative à deux branches : publier les
-- signalements d'une commune qui n'a rien demandé (hostile), ou les collecter
-- en silence (honnête, mais sans aucune valeur pour l'habitant tant que la
-- mairie ne signe pas). Elle a retenu le silence, et c'est resté le bon défaut.
--
-- Il manquait une troisième branche, décidée commune par commune : **publier
-- sans mairie**. Les habitants se lisent entre eux, constatent, confirment, et
-- ferment eux-mêmes ce qui a été réparé. OnSignale n'y est plus le sous-traitant
-- d'une collectivité, mais une plateforme citoyenne — avec les obligations qui
-- vont avec, ce qui est précisément pourquoi cette bascule ne doit **jamais**
-- être automatique.
--
-- Trois états, donc :
--
--   prospect   — la coquille muette de la 025. Rien n'est publié.
--   community  — publiée, sans agents, sans délais, sans transmission.
--   trial/active — partenaire : quelqu'un répond.
--
-- Le passage de l'un à l'autre est un geste de super-administrateur, tracé.
-- Et il est réversible dans les deux sens : une commune partenaire qui s'en va
-- retombe au **silence**, pas à l'état citoyen — ses signalements sont
-- dépubliés. Laisser public l'inventaire d'une commune qui a cessé de payer
-- serait une forme de pression qu'on refuse.

-- ─────────────────────────────────────────────────────────
-- 1. Le statut `community`
-- ─────────────────────────────────────────────────────────

ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_status_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('trial', 'active', 'suspended', 'demo', 'prospect', 'community'));

-- Quand la commune a été ouverte au public. Distinct d'`activated_at`, qui dit
-- quand elle est devenue partenaire : une commune peut être citoyenne pendant
-- des mois avant de signer, et les deux dates racontent deux choses.
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

COMMENT ON COLUMN public.tenants.published_at IS
  'Ouverture au public en mode citoyen (statut community). Null si jamais ouverte.';

-- ─────────────────────────────────────────────────────────
-- 2. D'où vient une résolution
-- ─────────────────────────────────────────────────────────
--
-- `resolu` était terminal sans condition (`lib/statusFlow.ts`) : clore prévient
-- l'habitant que c'est fait, et rouvrir en silence reprendrait cette promesse.
-- Le raisonnement vaut pour une décision de la commune. Il ne vaut pas pour un
-- constat d'habitant, qui peut être sincère et faux — le trou rebouché était
-- celui d'à côté. Un constat se conteste ; une décision municipale, non.
--
-- D'où cette colonne : elle ne change pas le statut affiché, elle dit qui l'a
-- décidé, et c'est elle qui rend la terminalité conditionnelle.

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS resolution_source TEXT
  CHECK (resolution_source IN ('agent', 'service', 'residents'));

COMMENT ON COLUMN public.reports.resolution_source IS
  'Qui a décidé de la résolution. NULL tant que le signalement n''est pas résolu. Seul "residents" est réversible.';

-- Les signalements déjà résolus l'ont été par une commune : avant cette
-- migration, aucun autre chemin n'existait. Les laisser à NULL les rendrait
-- rouvrables, ce qui serait une régression silencieuse de la règle précédente.
UPDATE public.reports
   SET resolution_source = 'agent'
 WHERE status = 'resolu' AND resolution_source IS NULL;

-- ─────────────────────────────────────────────────────────
-- 3. Les constats d'habitants
-- ─────────────────────────────────────────────────────────
--
-- Même principe que les confirmations sur place de la migration 029, et c'est
-- délibérément la même preuve : une position vérifiée par le serveur. Sans
-- elle, « c'est réparé » est un bouton qu'on presse depuis son canapé, et il
-- referme le problème de quelqu'un d'autre.
--
-- Deux natures de constat, et une seule table : « c'est réparé » et « c'est
-- toujours là » sont le même geste, au même endroit, avec la même preuve. Les
-- séparer en deux tables ferait diverger leurs règles.

CREATE TABLE IF NOT EXISTS public.resolution_claims (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   UUID NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
  -- Un compte est exigé : un constat anonyme ne se compte pas deux fois sans
  -- qu'on puisse savoir si c'est la même personne.
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('repaired', 'still_there')),
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  -- La distance au signalement, telle que mesurée à l'instant du constat.
  -- Conservée comme preuve, à l'image de la migration 029 : recalculer plus
  -- tard donnerait un autre chiffre si le signalement est déplacé.
  distance_m  INTEGER NOT NULL,
  photo_url   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Une personne, un constat, par signalement. Changer d'avis se fait en
  -- déposant l'autre nature de constat, ce que le serveur traite comme un
  -- remplacement — pas en empilant des lignes qui gonfleraient le compte.
  UNIQUE (report_id, user_id)
);

CREATE INDEX IF NOT EXISTS resolution_claims_report_idx
  ON public.resolution_claims (report_id, kind);

ALTER TABLE public.resolution_claims ENABLE ROW LEVEL SECURITY;

-- Rien n'est lisible ni écrivable avec un jeton d'utilisateur : tout passe par
-- l'API, qui vérifie la distance avant d'écrire. Une politique permissive ici
-- laisserait déclarer une réparation depuis n'importe où, ce que la table
-- existe pour empêcher.
REVOKE ALL ON public.resolution_claims FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────
-- 4. Ce que cette migration ne change pas
-- ─────────────────────────────────────────────────────────
--
-- `reports_select_published` (migration 037) reste telle quelle : elle filtre
-- sur `is_published`, pas sur le statut du tenant. Une commune citoyenne
-- publie, donc ses signalements deviennent lisibles — c'est voulu, et c'est
-- exactement le même chemin que pour une commune partenaire.
--
-- `tenants.status <> 'suspended'` y reste aussi : une commune suspendue est
-- dépubliée côté API, et cette politique est la seconde barrière.
