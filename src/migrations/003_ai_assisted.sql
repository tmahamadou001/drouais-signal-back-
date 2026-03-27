-- Migration 003: Ajouter la colonne ai_assisted pour tracker les signalements créés avec l'aide de l'IA

-- Ajouter la colonne ai_assisted à la table reports
ALTER TABLE reports 
  ADD COLUMN ai_assisted BOOLEAN DEFAULT false;

-- Créer un index pour faciliter les requêtes sur les signalements assistés par IA
CREATE INDEX idx_reports_ai_assisted ON reports(ai_assisted);

-- Commentaire pour documentation
COMMENT ON COLUMN reports.ai_assisted IS 'Indique si le signalement a été créé avec l''aide de l''analyse IA de photo';
