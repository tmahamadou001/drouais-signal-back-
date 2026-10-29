-- Migration 030 : ménage de l'héritage mono-tenant et du parcours web citoyen
--
-- Trois familles de colonnes et une contrainte, toutes devenues fausses ou
-- inertes avec la v2. Rien ici n'est supprimé « parce que c'est vieux » : chaque
-- objet retiré ci-dessous n'a plus aucun lecteur dans le code.

-- ─────────────────────────────────────────────────────────
-- 1. Le destinataire du rapport hebdomadaire est propre à une commune
-- ─────────────────────────────────────────────────────────
--
-- La table date de la 004, écrite pour une plateforme mono-commune : `email`
-- était unique **globalement**. La 006 lui a ajouté un `tenant_id` sans toucher
-- à la contrainte — de sorte qu'un maire abonné au rapport de sa commune
-- empêchait son homologue d'une autre commune de s'abonner à la sienne, avec un
-- 409 inexplicable.

ALTER TABLE public.weekly_report_recipients
  DROP CONSTRAINT IF EXISTS weekly_report_recipients_email_key;

CREATE UNIQUE INDEX IF NOT EXISTS weekly_report_recipients_tenant_email_idx
  ON public.weekly_report_recipients (tenant_id, email);

-- ─────────────────────────────────────────────────────────
-- 2. Le rayon de carte
-- ─────────────────────────────────────────────────────────
--
-- `map_radius_km` bornait les signalements à un cercle autour de la mairie.
-- C'était cohérent quand le citoyen choisissait sa commune et qu'il fallait se
-- prémunir de coordonnées fantaisistes. Depuis la v2 la position fait autorité
-- et le tenant découle des frontières INSEE : une commune étendue, ou un
-- signalement en limite communale, tombait hors du cercle et voyait sa
-- recherche de doublons refusée — silencieusement, le client avalant l'erreur.

ALTER TABLE public.tenant_configs DROP COLUMN IF EXISTS map_radius_km;

-- Et leurs valeurs par défaut tombent avec. `map_lat FLOAT DEFAULT 48.7322`,
-- c'était la mairie de Dreux : toute commune créée sans coordonnées héritait du
-- centre d'une autre ville, et sa carte s'ouvrait sur le mauvais département
-- sans que rien ne le signale. Une valeur absente se corrige, une valeur fausse
-- se recopie.

ALTER TABLE public.tenant_configs
  ALTER COLUMN map_lat  DROP DEFAULT,
  ALTER COLUMN map_lng  DROP DEFAULT;

-- `map_lat`, `map_lng` et `map_zoom` restent : ils cadrent la carte de chaleur
-- et le volet de détail du back-office, et servent de repli à l'écran Explorer
-- tant que la position du citoyen n'est pas arrivée.

-- ─────────────────────────────────────────────────────────
-- 3. Ce qui n'avait de sens qu'avec un front citoyen
-- ─────────────────────────────────────────────────────────
--
--  - `logo_url` et `welcome_message` habillaient la page d'accueil publique,
--    supprimée en phase 3 ;
--  - `city_population`, `department_code` et `region` ne servaient qu'à
--    départager deux communes dans le sélecteur, supprimé en phase 1 ;
--  - `weekly_report_emails` doublait `weekly_report_recipients`, la seule des
--    deux qui porte un état d'activation et un destinataire nommé.

ALTER TABLE public.tenant_configs
  DROP COLUMN IF EXISTS logo_url,
  DROP COLUMN IF EXISTS welcome_message,
  DROP COLUMN IF EXISTS city_population,
  DROP COLUMN IF EXISTS department_code,
  DROP COLUMN IF EXISTS region,
  DROP COLUMN IF EXISTS weekly_report_emails;

-- ─────────────────────────────────────────────────────────
-- 4. Le signalement anonyme n'est plus une option
-- ─────────────────────────────────────────────────────────
--
-- `feature_anonymous_reports` était présenté comme un interrupteur dans
-- l'administration, et **aucun code ne le lisait** : une commune qui le coupait
-- continuait de recevoir des signalements sans compte, sans que rien ne
-- l'avertisse.
--
-- Plutôt que de le faire appliquer, on le retire. Signaler sans compte est la
-- prémisse de la v2 — on photographie un trou dans la rue, on ne crée pas un
-- compte pour ça. En faire un réglage communal, c'est laisser une mairie casser
-- le parcours national pour ses propres habitants.

ALTER TABLE public.tenant_configs DROP COLUMN IF EXISTS feature_anonymous_reports;

COMMENT ON TABLE public.tenant_configs IS
  'Ce qu''une commune règle : son nom d''affichage, sa couleur, le cadrage de ses cartes, ses fonctionnalités de back-office et son rapport hebdomadaire.';
