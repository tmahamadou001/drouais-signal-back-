-- Migration 034 : le statut « Transmis » et les liens de service
--
-- Deux manques qui n'en font qu'un.
--
-- **Le statut.** L'envoi d'un e-mail au service concerné faisait passer le
-- signalement en `pris_en_charge`. Or expédier n'est pas traiter : personne
-- n'avait rien lu, l'habitant voyait « Pris en charge », et le délai moyen de
-- prise en charge — affiché à la commune et à ses élus — mesurait en réalité la
-- latence de Resend. Il manquait l'état intermédiaire réel : transmis, en
-- attente du service.
--
-- **Le retour.** Le service recevait un e-mail et ne pouvait rien en faire : ni
-- accuser réception, ni dire que c'était fait. La mairie relançait au téléphone
-- — précisément le travail que la plateforme devait supprimer. Ces gens-là ne
-- créeront jamais de compte pour trois signalements par mois : le lien signé
-- reçu dans l'e-mail *est* leur autorisation, sur ce signalement et sur rien
-- d'autre.

-- ─────────────────────────────────────────────────────────
-- 1. Le quatrième statut
-- ─────────────────────────────────────────────────────────

ALTER TABLE public.reports
  DROP CONSTRAINT IF EXISTS reports_status_check;

ALTER TABLE public.reports
  ADD CONSTRAINT reports_status_check
  CHECK (status IN ('en_attente', 'transmis', 'pris_en_charge', 'resolu'));

COMMENT ON COLUMN public.reports.status IS
  'en_attente → transmis (e-mail parti au service) → pris_en_charge (quelqu''un s''en occupe) → resolu.';

-- Les signalements passés en `pris_en_charge` par l'ancien envoi automatique
-- portent un commentaire d'historique reconnaissable. Ils sont replacés dans
-- l'état qu'ils n'auraient jamais dû quitter : transmis, sans réponse.
UPDATE public.reports r
   SET status = 'transmis'
  FROM public.status_history h
 WHERE h.report_id = r.id
   AND h.new_status = 'pris_en_charge'
   AND h.agent_id IS NULL
   AND h.comment = 'Transmis automatiquement au service concerné'
   AND r.status = 'pris_en_charge'
   -- Sauf si un agent est passé après : sa décision prime sur le rattrapage.
   AND NOT EXISTS (
     SELECT 1 FROM public.status_history later
      WHERE later.report_id = r.id
        AND later.agent_id IS NOT NULL
        AND later.changed_at > h.changed_at
   );

-- ─────────────────────────────────────────────────────────
-- 2. Les liens remis aux services
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.service_handoffs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   UUID NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  -- L'empreinte du jeton, jamais le jeton. Une fuite de cette table ne doit pas
  -- donner le droit d'agir sur des signalements — c'est la même règle que pour
  -- un mot de passe, et pour la même raison.
  token_hash  TEXT NOT NULL UNIQUE,

  -- À qui le lien a été envoyé. C'est ce qui rend une action défendable : on
  -- sait toujours dans quelle boîte le lien cliqué était arrivé.
  recipient   TEXT NOT NULL,
  service_name TEXT,
  category    TEXT NOT NULL,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Trente jours : au-delà, le service repasse par la mairie. Un lien d'action
  -- qui ne périme jamais finit par circuler en pièce jointe.
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days',

  acknowledged_at TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  /** Ce que le service a écrit en clôturant. */
  completion_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_service_handoffs_report ON public.service_handoffs(report_id);
CREATE INDEX IF NOT EXISTS idx_service_handoffs_tenant ON public.service_handoffs(tenant_id);

COMMENT ON TABLE public.service_handoffs IS
  'Un lien d''action remis à un service extérieur, pour un signalement et un destinataire. Ne donne droit qu''à deux transitions : accusé de prise en charge, et clôture.';

ALTER TABLE public.service_handoffs ENABLE ROW LEVEL SECURITY;

-- Aucune politique : la table n'est lue que par le serveur, via la service_role
-- qui contourne le RLS. Activer le RLS sans politique ferme donc l'accès direct
-- — c'est l'intention.
