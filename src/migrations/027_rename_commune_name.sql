-- Migration 027 : aligner le nommage des colonnes
--
-- `commune_nom` mélangeait deux langues dans un schéma qui est en anglais
-- partout ailleurs — `city_name`, `address_approx`, `map_lat`, `service_name`.
-- Corrigé tant que ces deux tables ne portaient presque rien.
--
-- ⚠️ **Sans effet sur une base neuve, et c'est voulu.** Les migrations 024 et
-- 025 ont été amendées depuis pour créer la colonne sous son nom définitif :
-- un projet créé aujourd'hui n'a donc jamais de `commune_nom` à renommer, et
-- le `ALTER TABLE … RENAME COLUMN` échouait sur
-- « column "commune_nom" does not exist » au beau milieu d'une installation.
--
-- Elle reste nécessaire pour les bases créées **avant** cet amendement — celle
-- de développement en est une. D'où le renommage conditionnel : il agit là où
-- il y a quelque chose à renommer, et se tait ailleurs.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'tenant_territories'
       AND column_name  = 'commune_nom'
  ) THEN
    ALTER TABLE public.tenant_territories RENAME COLUMN commune_nom TO commune_name;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'commune_waitlist'
       AND column_name  = 'commune_nom'
  ) THEN
    ALTER TABLE public.commune_waitlist RENAME COLUMN commune_nom TO commune_name;
  END IF;
END $$;

COMMENT ON COLUMN public.tenant_territories.commune_name IS
  'Nom rendu par la BAN, conservé pour le diagnostic d''un routage surprenant.';
