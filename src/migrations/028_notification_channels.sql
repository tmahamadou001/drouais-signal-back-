-- Migration 028 : préférences de notification par canal
--
-- La 023 posait deux booléens sur `device_tokens`. C'était le bon endroit tant
-- que le seul canal était le push : la préférence vivait sur la ligne même
-- qu'interroge l'envoi. Deux choses le cassent :
--
--  - **l'e-mail n'a pas de device**. Un citoyen qui n'a jamais accordé les
--    notifications n'a aucune ligne, donc aucun endroit où refuser les e-mails ;
--  - **deux listes indépendantes autorisent des états contradictoires**. Canal
--    et événement se croisent : « statut » et « réponse d'un agent » d'un côté,
--    « e-mail » et « push » de l'autre. Quatre cases, pas deux listes de deux.
--
-- La préférence devient donc un objet de compte, indépendant des appareils.

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  user_id       UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email_status  BOOLEAN NOT NULL DEFAULT true,
  email_comment BOOLEAN NOT NULL DEFAULT true,
  push_status   BOOLEAN NOT NULL DEFAULT true,
  push_comment  BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.notification_preferences IS
  'Grille canal × événement, par compte. L''absence de ligne vaut « tout activé ».';

-- Ce que la 023 avait déjà recueilli. `bool_and` parce qu'un citoyen qui a
-- coupé les notifications sur un appareil et pas sur l'autre a exprimé un
-- refus : le rétablir serait lui renvoyer ce qu'il a explicitement fermé.
INSERT INTO public.notification_preferences (user_id, push_status, push_comment)
SELECT user_id, bool_and(notify_status), bool_and(notify_comment)
  FROM public.device_tokens
 WHERE user_id IS NOT NULL
 GROUP BY user_id
ON CONFLICT (user_id) DO NOTHING;

ALTER TABLE public.device_tokens
  DROP COLUMN IF EXISTS notify_status,
  DROP COLUMN IF EXISTS notify_comment;

-- ─────────────────────────────────────────────────────────
-- Désabonnement en un clic
-- ─────────────────────────────────────────────────────────
--
-- Gmail et Yahoo imposent un `List-Unsubscribe` qui fonctionne réellement pour
-- tout expéditeur de masse ; un lien mort dégrade la délivrabilité de tout le
-- domaine. Et il doit fonctionner **sans compte** : un signalement anonyme ne
-- laisse qu'une adresse, sans `user_id` sur quoi poser une préférence.
--
-- D'où une liste de suppression par adresse, consultée avant chaque envoi.
-- Elle prime sur la grille : la demande la plus récente d'un citoyen qui n'a
-- pas de compte ne peut pas être exprimée ailleurs.

CREATE TABLE IF NOT EXISTS public.email_optouts (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT 'list_unsubscribe',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_optouts IS
  'Adresses désabonnées. Prime sur notification_preferences — couvre les signalements anonymes, qui n''ont pas de compte.';

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_optouts           ENABLE ROW LEVEL SECURITY;

-- Aucune politique permissive : seul le serveur, via la service_role, lit et
-- écrit ces tables. Un accès direct depuis le client anon ne doit rien voir.
