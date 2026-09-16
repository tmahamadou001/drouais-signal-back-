-- Migration 025 : communes prospects
--
-- Une plateforme nationale reçoit des signalements de communes qui ne sont pas
-- clientes. Deux réponses étaient possibles, toutes deux mauvaises :
--
--  - les publier, c'est-à-dire afficher publiquement l'inventaire des
--    dégradations d'une commune qui n'a rien demandé. Dans le secteur public
--    français, un maire qui découvre ça n'achète pas, il appelle son avocat ;
--  - les collecter en silence, et laisser un citoyen croire qu'il a alerté une
--    mairie qui ne recevra jamais rien.
--
-- La voie retenue : on accueille, on ne publie pas, et on le dit au citoyen
-- *avant* qu'il envoie. Il décide en connaissance de cause, et son e-mail —
-- s'il le laisse — devient le chiffre qui vend : « 312 de vos habitants
-- attendent que vous rejoigniez OnSignale ».

-- ─────────────────────────────────────────────────────────
-- 1. Un statut de plus
-- ─────────────────────────────────────────────────────────
--
-- `prospect` rejoint trial / active / suspended / demo. Un tenant prospect
-- existe uniquement pour porter des signalements : personne ne s'y connecte,
-- aucun agent n'y est rattaché, et rien de ce qu'il contient n'est public.

ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_status_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('trial', 'active', 'suspended', 'demo', 'prospect'));

-- ─────────────────────────────────────────────────────────
-- 2. La publication, explicite
-- ─────────────────────────────────────────────────────────
--
-- Un drapeau sur le signalement plutôt qu'une jointure sur le statut du tenant.
-- Deux raisons : la lecture publique est le chemin le plus chaud de l'API et ne
-- doit pas gagner une jointure, et le jour où une commune rejoint la plateforme
-- on veut pouvoir publier son historique d'un `UPDATE` — sans que la bascule de
-- statut le fasse silencieusement à notre place.

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.reports.is_published IS
  'Faux pour les signalements reçus en commune non partenaire : visibles de leur auteur seul.';

-- Les signalements déjà en base appartiennent à des communes clientes.
UPDATE public.reports r SET is_published = false
  FROM tenants t
 WHERE r.tenant_id = t.id AND t.status = 'prospect';

-- La liste publique et la carte filtrent désormais dessus.
CREATE INDEX IF NOT EXISTS reports_published_idx
  ON public.reports (tenant_id, created_at DESC)
  WHERE is_published = true;

-- ─────────────────────────────────────────────────────────
-- 3. La liste d'attente
-- ─────────────────────────────────────────────────────────
--
-- Un habitant qui veut être prévenu quand sa commune rejoint la plateforme.
-- Clé sur (commune, e-mail) : s'inscrire deux fois ne compte qu'une fois, sinon
-- le chiffre présenté à la mairie serait faux dans le sens qui nous arrange —
-- exactement celui qui détruit la confiance quand il est découvert.

CREATE TABLE IF NOT EXISTS public.commune_waitlist (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insee_code  TEXT NOT NULL CHECK (insee_code ~ '^[0-9AB][0-9]{4}$'),
  commune_name TEXT,
  email       TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  -- Rempli le jour où la commune rejoint la plateforme, pour ne prévenir
  -- personne deux fois.
  notified_at TIMESTAMPTZ,
  UNIQUE (insee_code, email)
);

CREATE INDEX IF NOT EXISTS commune_waitlist_insee_idx
  ON public.commune_waitlist (insee_code);

ALTER TABLE public.commune_waitlist ENABLE ROW LEVEL SECURITY;

-- Écrite et lue par le serveur avec la service_role. Aucune politique
-- permissive : cette table contient des adresses e-mail de citoyens, et rien
-- n'a à la lire depuis un client.
DROP POLICY IF EXISTS "commune_waitlist_none" ON public.commune_waitlist;
CREATE POLICY "commune_waitlist_none" ON public.commune_waitlist
  FOR ALL USING (false) WITH CHECK (false);
