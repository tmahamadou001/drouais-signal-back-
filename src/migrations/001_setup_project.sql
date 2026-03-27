-- ============================================
-- DrouaisSignal — Setup SQL pour Supabase
-- À exécuter dans Supabase > SQL Editor
-- ============================================

-- 1. Table des signalements
CREATE TABLE IF NOT EXISTS reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL,
  category       text NOT NULL CHECK (category IN ('voirie', 'eclairage', 'dechets', 'autre')),
  description    text,
  photo_url      text,
  lat            float8 NOT NULL,
  lng            float8 NOT NULL,
  address_approx text,
  status         text NOT NULL DEFAULT 'en_attente' CHECK (status IN ('en_attente', 'pris_en_charge', 'resolu')),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- 2. Table d'historique des statuts
CREATE TABLE IF NOT EXISTS status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  old_status  text NOT NULL,
  new_status  text NOT NULL,
  agent_id    uuid REFERENCES auth.users(id),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  comment     text
);

-- 3. Index pour les requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_category ON reports(category);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_status_history_report_id ON status_history(report_id);

-- 4. RLS (Row Level Security) — ON pour la sécurité, mais notre API
--    utilise le service_role qui bypasse les RLS.
--    Ces policies sont pour le cas où on accéderait via le client Supabase directement.
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_history ENABLE ROW LEVEL SECURITY;

-- Lecture publique des signalements
CREATE POLICY "reports_public_read" ON reports
  FOR SELECT USING (true);

-- Un utilisateur peut créer des signalements
CREATE POLICY "reports_user_insert" ON reports
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Lecture publique de l'historique
CREATE POLICY "history_public_read" ON status_history
  FOR SELECT USING (true);

-- 5. Bucket Storage pour les photos
-- (À créer manuellement dans Supabase > Storage > New Bucket)
-- Nom : photos
-- Public : oui (pour les URL publiques)
-- File size limit : 5 MB

-- 6. Créer un utilisateur admin
-- Après avoir créé un compte via magic link, exécuter :
-- UPDATE auth.users
-- SET raw_user_meta_data = jsonb_set(raw_user_meta_data, '{role}', '"admin"')
-- WHERE email = 'votre-email-admin@exemple.fr';
