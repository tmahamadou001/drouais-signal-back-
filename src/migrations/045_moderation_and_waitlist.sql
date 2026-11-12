-- Migration 045 : ce que la modération retire ne revient pas, et la liste
-- d'attente ne se laisse pas remplir
--
-- Deux constats « moyens » de l'audit du 12 novembre 2026, qui ont en commun
-- de n'apparaître qu'au deuxième geste : tout va bien jusqu'à ce qu'on
-- referme puis rouvre une commune, ou jusqu'à ce que quelqu'un prenne la
-- peine de boucler sur un formulaire.
--
-- À exécuter après la 043 et la 044.

-- ─────────────────────────────────────────────────────────
-- 1. `is_published` disait deux choses à la fois
-- ─────────────────────────────────────────────────────────
--
-- Faux signifiait aussi bien « jamais publié, la commune est silencieuse » que
-- « retiré par un modérateur parce qu'une plaque d'immatriculation était
-- lisible ». `publishTenantHistory` republiant *tout* ce qui est à faux, la
-- séquence community → prospect → community remettait en ligne ce qu'on venait
-- d'en retirer — et le journal d'audit ne disait que « commune ouverte ».
--
-- La colonne porte donc le **motif**, pas seulement l'état. Son nom dit ce qui
-- s'est passé, et sa valeur quand.

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS retracted_at TIMESTAMPTZ;

COMMENT ON COLUMN public.reports.retracted_at IS
  'Retiré de la vue publique par la modération (services/moderationService.ts). Un signalement ainsi marqué n''est jamais republié par l''ouverture d''une commune.';

-- La lecture qui compte — « republier l'historique, sauf ce qui a été retiré »
-- — n'a pas besoin de parcourir la table entière.
CREATE INDEX IF NOT EXISTS reports_retracted_idx
  ON public.reports (tenant_id)
  WHERE retracted_at IS NOT NULL;

-- Les signalements déjà dépubliés l'ont été par une bascule de commune, jamais
-- par la modération : celle-ci n'existe que depuis hier. Rien à rattraper, et
-- surtout rien à marquer rétroactivement — ce serait inventer une décision que
-- personne n'a prise.

-- ─────────────────────────────────────────────────────────
-- 2. La liste d'attente, insensible à la casse
-- ─────────────────────────────────────────────────────────
--
-- `UNIQUE (insee_code, email)` existe depuis la migration 025, et
-- `joinWaitlist` met l'adresse en minuscules avant d'insérer — donc le
-- doublon est écarté en pratique. Mais la règle vit dans le service, pas dans
-- la base : une écriture directe, un script d'import, un second chemin un
-- jour, et « Habitant@exemple.fr » compte une deuxième fois dans le chiffre
-- qu'on présente à une mairie.
--
-- L'unicité est ce qui garantit que ce chiffre est un nombre d'habitants, et
-- non un nombre de clics.

CREATE UNIQUE INDEX IF NOT EXISTS commune_waitlist_insee_email_lower_idx
  ON public.commune_waitlist (insee_code, lower(email));

-- ─────────────────────────────────────────────────────────
-- 3. Vérifications
-- ─────────────────────────────────────────────────────────

-- (a) La colonne existe, et personne n'est marqué à tort.
SELECT count(*) FILTER (WHERE retracted_at IS NOT NULL) AS retires,
       count(*) FILTER (WHERE NOT is_published)         AS non_publies
FROM   public.reports;

-- (b) Les doublons de casse qui subsisteraient — à traiter à la main s'il y en
--     a, l'index unique refusant de se créer tant qu'ils existent.
SELECT insee_code, lower(email) AS adresse, count(*)
FROM   public.commune_waitlist
GROUP  BY insee_code, lower(email)
HAVING count(*) > 1;
