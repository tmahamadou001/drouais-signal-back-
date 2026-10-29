-- Migration 024 : socle géographique
--
-- Bascule le modèle : le tenant d'un signalement n'est plus déclaré par le
-- client via `X-Tenant-Slug`, il est *dérivé* de sa position par le serveur.
-- Deux ajouts pour rendre cela possible, et vérifiable après coup.

-- ─────────────────────────────────────────────────────────
-- 1. Le territoire d'un tenant
-- ─────────────────────────────────────────────────────────
--
-- Une table plutôt qu'une colonne tableau sur `tenant_configs` : une
-- intercommunalité couvre plusieurs communes, la jointure reste indexable, et
-- le code INSEE en clé primaire garantit qu'une commune n'appartient qu'à un
-- seul tenant — ce qui est exactement l'invariant qu'on veut, puisque c'est lui
-- qui décide de la propriété de la donnée.

CREATE TABLE IF NOT EXISTS public.tenant_territories (
  -- Le code INSEE, pas le code postal : un code postal peut couvrir plusieurs
  -- communes et une commune peut en avoir plusieurs (Cergy : 95000 et 95800).
  insee_code  TEXT PRIMARY KEY CHECK (insee_code ~ '^[0-9AB][0-9]{4}$'),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Le nom tel que renvoyé par la BAN, conservé pour le diagnostic : si un
  -- routage surprend, on veut voir à quelle commune le code correspondait.
  commune_name TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE public.tenant_territories IS
  'Communes couvertes par un tenant. La résolution position → INSEE → tenant en dépend.';

-- La lecture chaude est "quel tenant pour ce code INSEE" (clé primaire, déjà
-- indexée). Cet index sert le sens inverse : lister le territoire d'un tenant.
CREATE INDEX IF NOT EXISTS tenant_territories_tenant_idx
  ON public.tenant_territories (tenant_id);

ALTER TABLE public.tenant_territories ENABLE ROW LEVEL SECURITY;

-- Le serveur lit cette table avec la service_role, qui contourne RLS. La
-- politique existe pour la même raison qu'ailleurs dans ce schéma : qu'un accès
-- client direct ne puisse pas cartographier le découpage commercial.
DROP POLICY IF EXISTS "tenant_territories_read" ON public.tenant_territories;
CREATE POLICY "tenant_territories_read" ON public.tenant_territories
  FOR SELECT
  USING (false);

-- ─────────────────────────────────────────────────────────
-- 2. La preuve du routage, et la qualité de la mesure
-- ─────────────────────────────────────────────────────────
--
-- `tenant_id` est la conclusion ; `insee_code` est la preuve. Sans elle, une
-- décision de routage n'est ni auditable ni rejouable — or les communes
-- nouvelles fusionnent régulièrement et les codes changent.
--
-- La position cesse d'être une saisie pour devenir une mesure. Une mesure sans
-- sa marge d'erreur ni son horodatage n'est pas une mesure, c'est un chiffre :
-- `position_accuracy` conditionne le seuil de refus, et l'écart entre
-- `position_captured_at` et `created_at` dit combien de temps a passé entre la
-- prise de vue et l'envoi.

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS insee_code           TEXT,
  ADD COLUMN IF NOT EXISTS position_accuracy    REAL,
  ADD COLUMN IF NOT EXISTS position_captured_at TIMESTAMPTZ,
  -- Marque les lignes dont le code INSEE reste à établir.
  --
  -- Un signalement créé après cette migration est toujours résolu : sans
  -- commune, il n'y a pas de tenant, et `tenant_id` est NOT NULL — c'est la clé
  -- de partition de tout le système, la rendre nullable pour absorber une panne
  -- de géocodage coûterait bien plus cher que ça ne rapporterait. Le serveur
  -- répond donc 503 et le client réessaie ; la résilience appartient à la file
  -- d'attente hors ligne de l'app, pas à un état intermédiaire en base.
  --
  -- Le faux ne concerne que les signalements *antérieurs*, créés quand le
  -- tenant était déclaré par le client : ils ont une position mais aucun code
  -- INSEE. `scripts/backfill-insee.ts` les reprend.
  ADD COLUMN IF NOT EXISTS geo_resolved         BOOLEAN NOT NULL DEFAULT true;

-- Les lignes existantes n'ont pas de code INSEE : elles attendent la reprise.
UPDATE public.reports SET geo_resolved = false WHERE insee_code IS NULL;

COMMENT ON COLUMN public.reports.insee_code IS
  'Code INSEE résolu depuis lat/lng au moment de la création. Preuve du routage.';
COMMENT ON COLUMN public.reports.position_accuracy IS
  'Précision en mètres rapportée par le capteur du téléphone.';
COMMENT ON COLUMN public.reports.position_captured_at IS
  'Instant de la capture GPS — au déclenchement de la photo, pas à l''envoi.';
COMMENT ON COLUMN public.reports.geo_resolved IS
  'Faux si le géocodage a échoué et que le signalement attend une reprise.';

-- Sert le travail de reprise, qui ne lit que les lignes non résolues.
CREATE INDEX IF NOT EXISTS reports_geo_unresolved_idx
  ON public.reports (created_at)
  WHERE geo_resolved = false;

-- ─────────────────────────────────────────────────────────
-- 3. Territoires des tenants existants
-- ─────────────────────────────────────────────────────────
--
-- Codes vérifiés auprès de geo.api.gouv.fr le 14/09/2026.
-- `demo` n'en reçoit aucun volontairement : c'est une commune fictive, joignable
-- par slug pour les démonstrations, jamais par position.

INSERT INTO public.tenant_territories (insee_code, tenant_id, commune_name)
SELECT '28134', id, 'Dreux'     FROM tenants WHERE slug = 'dreux'
ON CONFLICT (insee_code) DO NOTHING;

INSERT INTO public.tenant_territories (insee_code, tenant_id, commune_name)
SELECT '28214', id, 'La Loupe'  FROM tenants WHERE slug = 'la-loupe'
ON CONFLICT (insee_code) DO NOTHING;

INSERT INTO public.tenant_territories (insee_code, tenant_id, commune_name)
SELECT '95127', id, 'Cergy'     FROM tenants WHERE slug = 'cergy'
ON CONFLICT (insee_code) DO NOTHING;
