-- ============================================================================
-- Migration : Système de votes et détection de doublons
-- ============================================================================

-- 1. Activer l'extension PostGIS pour les calculs de distance géographique
CREATE EXTENSION IF NOT EXISTS postgis;

-- 2. Ajouter la colonne vote_count à la table reports
ALTER TABLE reports 
  ADD COLUMN IF NOT EXISTS vote_count INTEGER NOT NULL DEFAULT 0;

-- 3. Créer la table votes
CREATE TABLE IF NOT EXISTS votes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id     UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT NULL,
  anonymous_ip  TEXT DEFAULT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  
  -- Contraintes : un vote par utilisateur OU par IP par signalement
  CONSTRAINT one_vote_per_user 
    UNIQUE NULLS NOT DISTINCT (report_id, user_id),
  CONSTRAINT one_vote_per_ip  
    UNIQUE NULLS NOT DISTINCT (report_id, anonymous_ip),
  
  -- Au moins user_id ou anonymous_ip doit être renseigné
  CONSTRAINT vote_has_identifier
    CHECK (user_id IS NOT NULL OR anonymous_ip IS NOT NULL)
);

-- 4. Créer un index sur report_id pour optimiser les requêtes
CREATE INDEX IF NOT EXISTS idx_votes_report_id ON votes(report_id);
CREATE INDEX IF NOT EXISTS idx_votes_user_id ON votes(user_id) WHERE user_id IS NOT NULL;

-- 5. Fonction trigger pour maintenir vote_count à jour automatiquement
CREATE OR REPLACE FUNCTION update_vote_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE reports 
    SET vote_count = vote_count + 1 
    WHERE id = NEW.report_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE reports 
    SET vote_count = GREATEST(vote_count - 1, 0)
    WHERE id = OLD.report_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 6. Créer le trigger sur la table votes
DROP TRIGGER IF EXISTS trigger_vote_count ON votes;
CREATE TRIGGER trigger_vote_count
AFTER INSERT OR DELETE ON votes
FOR EACH ROW EXECUTE FUNCTION update_vote_count();

-- 7. RLS (Row Level Security) policies pour la table votes

-- Activer RLS sur la table votes
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;

-- Policy : Lecture publique (tout le monde peut voir les votes)
DROP POLICY IF EXISTS "votes_select_public" ON votes;
CREATE POLICY "votes_select_public" ON votes
  FOR SELECT 
  USING (true);

-- Policy : Insertion (connecté ou anonyme via API)
DROP POLICY IF EXISTS "votes_insert" ON votes;
CREATE POLICY "votes_insert" ON votes
  FOR INSERT 
  WITH CHECK (true);

-- Policy : Suppression (uniquement son propre vote si connecté)
DROP POLICY IF EXISTS "votes_delete_own" ON votes;
CREATE POLICY "votes_delete_own" ON votes
  FOR DELETE 
  USING (auth.uid() = user_id);

-- 8. Créer un index spatial sur les coordonnées pour optimiser les recherches de proximité
-- Note: Utilisation d'un index composite sur lat/lng pour les requêtes de proximité
-- L'index GIST sera créé via une colonne générée si nécessaire
CREATE INDEX IF NOT EXISTS idx_reports_lat_lng 
  ON reports (lat, lng);

-- 9. Fonction RPC pour rechercher les signalements à proximité
CREATE OR REPLACE FUNCTION find_nearby_reports(
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_radius_meters INTEGER DEFAULT 80,
  p_days_ago INTEGER DEFAULT 30
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  category TEXT,
  description TEXT,
  photo_url TEXT,
  vote_count INTEGER,
  status TEXT,
  created_at TIMESTAMPTZ,
  distance_meters DOUBLE PRECISION
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    r.id,
    r.title,
    r.category,
    r.description,
    r.photo_url,
    r.vote_count,
    r.status,
    r.created_at,
    ST_Distance(
      ST_MakePoint(r.lng, r.lat)::geography,
      ST_MakePoint(p_lng, p_lat)::geography
    ) as distance_meters
  FROM reports r
  WHERE 
    r.status != 'resolu'
    AND r.created_at > NOW() - (p_days_ago || ' days')::INTERVAL
    AND ST_DWithin(
      ST_MakePoint(r.lng, r.lat)::geography,
      ST_MakePoint(p_lng, p_lat)::geography,
      p_radius_meters
    )
  ORDER BY distance_meters ASC
  LIMIT 5;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- Fin de la migration
-- ============================================================================

-- Note : Pour exécuter cette migration dans Supabase :
-- 1. Aller dans SQL Editor
-- 2. Copier-coller ce fichier
-- 3. Exécuter
