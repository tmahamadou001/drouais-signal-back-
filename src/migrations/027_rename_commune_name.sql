-- Migration 027 : aligner le nommage des colonnes
--
-- `commune_nom` mélangeait deux langues dans un schéma qui est en anglais
-- partout ailleurs — `city_name`, `address_approx`, `map_lat`, `service_name`.
-- Corrigé maintenant, tant que ces deux tables ne portent presque rien.

ALTER TABLE public.tenant_territories RENAME COLUMN commune_nom TO commune_name;
ALTER TABLE public.commune_waitlist   RENAME COLUMN commune_nom TO commune_name;

COMMENT ON COLUMN public.tenant_territories.commune_name IS
  'Nom rendu par la BAN, conservé pour le diagnostic d''un routage surprenant.';
