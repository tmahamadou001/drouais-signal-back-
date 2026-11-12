-- ════════════════════════════════════════════════════════════════════════
-- 046 — Le préfixe de référence ne peut plus être pris deux fois
-- ════════════════════════════════════════════════════════════════════════
--
-- La migration 032 dérive le préfixe des **trois premières lettres du slug**.
-- Deux communes dont le nom commence pareil reçoivent donc le même :
--
--   vernouillet-28404  →  VER
--   versailles-78646   →  VER
--
-- Et comme `idx_reports_reference` est unique **globalement** — à dessein : une
-- référence se dicte au téléphone sans sa commune —, le premier signalement de
-- la seconde commune porterait `VER-2026-00001`, déjà pris par la première.
-- L'INSERT échoue, le trigger ne rattrape rien, et **le signalement est
-- perdu** : un habitant qui a photographié, rédigé et envoyé reçoit une
-- erreur serveur. Le compteur étant par commune, la collision tombe sur le
-- tout premier dépôt — la pire occurrence possible.
--
-- `VER-2026-00001` existe déjà en production (Vernouillet). Accueillir
-- Versailles sans cette migration casse son premier signalement.
--
-- Second défaut, de la même famille : `POST /api/tenant` crée une commune sans
-- poser `reference_prefix`, qui est `NOT NULL`. Créer une commune depuis le
-- back-office échoue donc toujours. Deux appelants, deux oublis possibles —
-- d'où un propriétaire unique : la base.

-- ─────────────────────────────────────────────────────────
-- 1. Le prochain préfixe libre
-- ─────────────────────────────────────────────────────────
--
-- Trois lettres, puis quatre, puis cinq si elles sont prises ; au-delà, un
-- rang numérique. `VERS` reste lisible et se dicte aussi bien que `VER` ;
-- l'important est qu'aucune commune ne se voie refuser son premier dépôt.
--
-- `SECURITY DEFINER` n'est pas nécessaire : la fonction ne lit que `tenants`,
-- et seul le serveur l'appelle, à travers le trigger. Elle reste donc
-- `INVOKER`, et le `search_path` est figé — une fonction sans `search_path`
-- explicite est un vecteur d'escalade quand elle est appelée par un trigger.
CREATE OR REPLACE FUNCTION public.next_reference_prefix(p_slug TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_letters TEXT;
  v_candidate TEXT;
  v_length INT;
  v_rank INT := 2;
BEGIN
  v_letters := UPPER(REGEXP_REPLACE(COALESCE(p_slug, ''), '[^a-zA-Z]', '', 'g'));

  -- Un slug sans la moindre lettre ne peut pas produire de préfixe lisible.
  IF v_letters = '' THEN
    v_letters := 'ONS';
  END IF;

  -- Trois, quatre, puis cinq lettres.
  FOR v_length IN 3..5 LOOP
    v_candidate := SUBSTRING(v_letters FROM 1 FOR v_length);

    -- Un slug plus court que la longueur demandée rendrait le même candidat
    -- qu'au tour précédent : inutile de le retester.
    IF LENGTH(v_candidate) = v_length
       AND NOT EXISTS (SELECT 1 FROM public.tenants WHERE reference_prefix = v_candidate)
    THEN
      RETURN v_candidate;
    END IF;
  END LOOP;

  -- Épuisé : on numérote. `VER2`, `VER3`… La boucle est bornée — au-delà de
  -- 999 communes dont le nom commence par les trois mêmes lettres, il vaut
  -- mieux une erreur franche qu'une boucle infinie.
  WHILE v_rank < 1000 LOOP
    v_candidate := SUBSTRING(v_letters FROM 1 FOR 3) || v_rank::TEXT;

    IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE reference_prefix = v_candidate) THEN
      RETURN v_candidate;
    END IF;

    v_rank := v_rank + 1;
  END LOOP;

  RAISE EXCEPTION 'Aucun préfixe de référence disponible pour le slug %', p_slug;
END;
$$;

REVOKE ALL ON FUNCTION public.next_reference_prefix(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_reference_prefix(TEXT) TO service_role;

COMMENT ON FUNCTION public.next_reference_prefix(TEXT) IS
  'Le prochain préfixe de référence libre pour ce slug. Appelée par le trigger d''insertion des communes.';

-- ─────────────────────────────────────────────────────────
-- 2. Résoudre les collisions déjà en base
-- ─────────────────────────────────────────────────────────
--
-- Qui garde son préfixe : la commune qui a **déjà des signalements**, puis la
-- plus ancienne. Renommer le préfixe d'une commune ne falsifie aucune
-- référence déjà communiquée — `reports.reference` est une colonne, pas un
-- calcul — mais cette commune aurait alors deux préfixes dans son histoire.
-- Autant que ce soit celle qui n'a encore rien numéroté.
WITH classement AS (
  SELECT
    t.id,
    t.slug,
    t.reference_prefix,
    ROW_NUMBER() OVER (
      PARTITION BY t.reference_prefix
      ORDER BY (SELECT COUNT(*) FROM public.reports r WHERE r.tenant_id = t.id) DESC,
               t.created_at ASC,
               t.id ASC
    ) AS rang
  FROM public.tenants t
)
UPDATE public.tenants AS cible
   SET reference_prefix = public.next_reference_prefix(classement.slug)
  FROM classement
 WHERE cible.id = classement.id
   AND classement.rang > 1;

-- ─────────────────────────────────────────────────────────
-- 3. L'unicité, tenue par la base
-- ─────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_reference_prefix
  ON public.tenants (reference_prefix);

-- ─────────────────────────────────────────────────────────
-- 4. Un seul propriétaire : le trigger
-- ─────────────────────────────────────────────────────────
--
-- Deux appelants posaient le préfixe, l'un correctement et l'autre pas du
-- tout. Il n'y en a plus qu'un. Un trigger `BEFORE INSERT` s'exécute **avant**
-- la vérification de `NOT NULL`, donc une insertion qui omet la colonne est
-- désormais valide — c'est exactement ce que fait `POST /api/tenant`.
CREATE OR REPLACE FUNCTION public.assign_reference_prefix()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- Une valeur explicite est respectée : la reprise de données et les tests
  -- doivent pouvoir imposer un préfixe. L'index unique reste juge.
  IF NEW.reference_prefix IS NOT NULL AND NEW.reference_prefix <> '' THEN
    RETURN NEW;
  END IF;

  NEW.reference_prefix := public.next_reference_prefix(NEW.slug);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_reference_prefix ON public.tenants;

CREATE TRIGGER set_reference_prefix
  BEFORE INSERT ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_reference_prefix();

-- ─────────────────────────────────────────────────────────
-- 5. Vérifications
-- ─────────────────────────────────────────────────────────

-- Doit rendre 0 ligne : plus aucune collision.
SELECT reference_prefix, COUNT(*) AS communes, STRING_AGG(slug, ', ') AS lesquelles
  FROM public.tenants
 GROUP BY reference_prefix
HAVING COUNT(*) > 1;

-- L'état après coup, à relire.
SELECT slug, reference_prefix, status
  FROM public.tenants
 ORDER BY reference_prefix;
