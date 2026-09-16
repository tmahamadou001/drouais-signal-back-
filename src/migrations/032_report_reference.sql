-- Migration 032 : la référence d'un signalement devient une donnée
--
-- Elle existait dans le navigateur, calculée à l'affichage depuis le slug de la
-- commune, l'année et la fin de l'UUID : `LAL-2026-DEF0`. Elle rendait un
-- service réel — un agent au téléphone peut la dicter — avec trois défauts qui
-- se paient tôt ou tard :
--
--  - **elle n'était pas cherchable.** Un habitant appelle avec sa référence,
--    l'agent la tape, rien ne sort : elle n'existait dans aucune colonne ;
--  - **elle n'était stable que tant que personne n'y touchait.** Changer le
--    slug d'une commune, ou passer à quatre lettres de préfixe, rendait fausses
--    toutes les références déjà dictées — sans aucun signal ;
--  - **elle n'était pas ordonnée.** `DEF0` vient d'un UUID : deux signalements
--    du même jour ne se suivent pas, et « le 418 » ne veut rien dire. Or c'est
--    précisément ce qu'un service technique attend d'un numéro.
--
-- Une référence est un contrat avec l'extérieur. Ça ne se recalcule pas.

-- ─────────────────────────────────────────────────────────
-- 1. Le préfixe de la commune, figé à son ouverture
-- ─────────────────────────────────────────────────────────

-- Figé, et non dérivé du slug à la lecture : c'est exactement le défaut qu'on
-- corrige. Une commune peut changer de slug ; ses références, jamais.
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS reference_prefix TEXT;

UPDATE public.tenants
   SET reference_prefix = UPPER(SUBSTRING(REGEXP_REPLACE(slug, '[^a-zA-Z]', '', 'g') FROM 1 FOR 3))
 WHERE reference_prefix IS NULL;

-- Un slug sans lettre du tout ne peut pas produire de préfixe. Il n'y en a pas
-- aujourd'hui, mais `ONS` vaut mieux qu'une chaîne vide dans une référence.
UPDATE public.tenants
   SET reference_prefix = 'ONS'
 WHERE reference_prefix IS NULL OR reference_prefix = '';

ALTER TABLE public.tenants
  ALTER COLUMN reference_prefix SET NOT NULL;

COMMENT ON COLUMN public.tenants.reference_prefix IS
  'Préfixe des références de cette commune. Figé à l''ouverture : le modifier rendrait fausses les références déjà communiquées.';

-- ─────────────────────────────────────────────────────────
-- 2. Le compteur, par commune et par année
-- ─────────────────────────────────────────────────────────

-- Une ligne par (commune, année) plutôt qu'une séquence PostgreSQL par
-- commune : une séquence ne se réinitialise pas toute seule au 1er janvier, et
-- en créer une par commune ferait un objet de schéma par client.
CREATE TABLE IF NOT EXISTS public.report_counters (
  tenant_id UUID    NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  year      INTEGER NOT NULL,
  last_value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, year)
);

COMMENT ON TABLE public.report_counters IS
  'Dernier numéro attribué par commune et par année. Incrémenté sous verrou de ligne par le trigger de référence.';

-- ─────────────────────────────────────────────────────────
-- 3. La colonne
-- ─────────────────────────────────────────────────────────

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS reference TEXT;

-- ─────────────────────────────────────────────────────────
-- 4. L'attribution
-- ─────────────────────────────────────────────────────────

-- Cinq chiffres et non quatre : un zéro de plus ne coûte rien, un dépassement
-- coûte une migration sur une donnée déjà communiquée aux habitants. Paris
-- publie 150 000 anomalies par an ; le format doit tenir ce cas.
CREATE OR REPLACE FUNCTION public.assign_report_reference()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year   INTEGER := EXTRACT(YEAR FROM COALESCE(NEW.created_at, now()))::INTEGER;
  v_prefix TEXT;
  v_next   INTEGER;
BEGIN
  IF NEW.reference IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT reference_prefix INTO v_prefix
    FROM public.tenants
   WHERE id = NEW.tenant_id;

  -- `ON CONFLICT DO UPDATE` verrouille la ligne du compteur : deux insertions
  -- simultanées dans la même commune s'attendent et reçoivent deux numéros.
  -- Un `SELECT max()+1` aurait donné le même numéro aux deux.
  INSERT INTO public.report_counters (tenant_id, year, last_value)
  VALUES (NEW.tenant_id, v_year, 1)
  ON CONFLICT (tenant_id, year)
  DO UPDATE SET last_value = public.report_counters.last_value + 1
  RETURNING last_value INTO v_next;

  NEW.reference := COALESCE(v_prefix, 'ONS') || '-' || v_year || '-' || LPAD(v_next::TEXT, 5, '0');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_report_reference ON public.reports;

CREATE TRIGGER set_report_reference
  BEFORE INSERT ON public.reports
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_report_reference();

-- ─────────────────────────────────────────────────────────
-- 5. Le rattrapage de l'existant
-- ─────────────────────────────────────────────────────────

-- Dans l'ordre de dépôt, commune par commune et année par année : c'est le seul
-- ordre qui donne un sens à « le 418 est antérieur au 512 ». `id` départage les
-- signalements déposés à la même milliseconde, pour que le résultat ne dépende
-- pas du plan d'exécution.
WITH numbered AS (
  SELECT id,
         tenant_id,
         EXTRACT(YEAR FROM created_at)::INTEGER AS year,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, EXTRACT(YEAR FROM created_at)
           ORDER BY created_at, id
         ) AS position
    FROM public.reports
   WHERE reference IS NULL
)
UPDATE public.reports r
   SET reference = t.reference_prefix || '-' || n.year || '-' || LPAD(n.position::TEXT, 5, '0')
  FROM numbered n
  JOIN public.tenants t ON t.id = n.tenant_id
 WHERE r.id = n.id;

-- Les compteurs repartent d'où le rattrapage s'est arrêté, sans quoi le
-- prochain signalement réutiliserait le numéro 1.
INSERT INTO public.report_counters (tenant_id, year, last_value)
SELECT tenant_id,
       EXTRACT(YEAR FROM created_at)::INTEGER,
       COUNT(*)
  FROM public.reports
 GROUP BY tenant_id, EXTRACT(YEAR FROM created_at)
ON CONFLICT (tenant_id, year)
DO UPDATE SET last_value = GREATEST(public.report_counters.last_value, EXCLUDED.last_value);

-- ─────────────────────────────────────────────────────────
-- 6. Les contraintes, une fois tout rempli
-- ─────────────────────────────────────────────────────────

ALTER TABLE public.reports
  ALTER COLUMN reference SET NOT NULL;

-- Unique globalement et non par commune : une référence se dicte au téléphone
-- et se colle dans un e-mail, souvent sans sa commune. Deux signalements ne
-- doivent jamais pouvoir répondre au même numéro.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_reference
  ON public.reports (reference);

COMMENT ON COLUMN public.reports.reference IS
  'Référence communiquée à l''habitant. Attribuée à l''insertion, jamais recalculée.';
