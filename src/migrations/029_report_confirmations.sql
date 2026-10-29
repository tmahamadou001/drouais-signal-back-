-- Migration 029 : le vote devient une confirmation
--
-- `votes` portait un geste sans contenu vérifiable. N'importe qui, depuis
-- n'importe où, pouvait faire monter le compteur d'un signalement — et l'agent
-- qui trie sa file du lundi matin ne pouvait rien en conclure : dix votes
-- signifiaient peut-être dix habitants gênés, peut-être une personne qui trouve
-- la cause sympathique.
--
-- Le geste devient donc une **confirmation sur place** : il n'est proposé qu'au
-- citoyen qui vient de photographier le même problème, et le serveur vérifie
-- qu'il se trouve bien à côté. « Quatre personnes ont constaté ça » devient une
-- phrase qui veut dire quelque chose, et le bouton « Je signale aussi » —
-- accessible depuis le canapé — disparaît de l'application.
--
-- La table garde son nom. Le renommer entraînerait avec lui le trigger, quatre
-- politiques RLS réparties sur autant de migrations, une fonction RPC de carte
-- de chaleur et les abonnements temps réel du back-office : beaucoup de surface
-- silencieuse pour un changement de vocabulaire. Ce que la table *signifie* est
-- écrit ci-dessous, et c'est l'API qui porte le nouveau nom.

COMMENT ON TABLE public.votes IS
  'Confirmations sur place. Une ligne = un citoyen qui a constaté le problème à proximité, position vérifiée par le serveur (voir routes/votes.ts). Ce n''est pas un vote d''opinion.';

-- ─────────────────────────────────────────────────────────
-- La preuve
-- ─────────────────────────────────────────────────────────
--
-- Conservée plutôt que seulement contrôlée : sans elle, une confirmation
-- ancienne est indiscernable d'une confirmation fabriquée, et le jour où il
-- faudra expliquer un compteur à une mairie, « le serveur a vérifié » ne se
-- démontre pas. La distance est stockée telle que calculée à l'instant de la
-- confirmation — le signalement, lui, peut être déplacé ensuite par un agent.

ALTER TABLE public.votes
  ADD COLUMN IF NOT EXISTS confirmed_lat        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS confirmed_lng        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS confirmed_distance_m INTEGER;

COMMENT ON COLUMN public.votes.confirmed_distance_m IS
  'Distance en mètres entre le citoyen et le signalement, au moment de la confirmation.';

-- Les lignes d'avant cette migration n'ont pas de preuve, et ne peuvent pas en
-- recevoir une rétroactivement : elles restent à NULL, ce qui est l'information
-- exacte — « confirmé, mais à l'époque où rien n'était vérifié ».
