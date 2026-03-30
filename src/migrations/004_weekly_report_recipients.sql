-- Table pour les destinataires du rapport hebdomadaire
CREATE TABLE weekly_report_recipients (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT DEFAULT 'elu',
  is_active  BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index pour les requêtes fréquentes
CREATE INDEX idx_weekly_recipients_active ON weekly_report_recipients(is_active);

-- Premiers destinataires
INSERT INTO weekly_report_recipients (email, name, role)
VALUES
--   ('contact@ville-dreux.fr', 'Mairie de Dreux', 'mairie'),
--   ('mairie@chateauneuf-en-thymerais.fr', 'Jean-Louis Raffin', 'vp_numerique');
('mahamadoutraore1@gmail.com', 'Mahamadou Traoré', 'mairie');

-- Commentaires
COMMENT ON TABLE weekly_report_recipients IS 'Destinataires du rapport hebdomadaire automatique';
COMMENT ON COLUMN weekly_report_recipients.role IS 'Type de destinataire : elu, mairie, vp_numerique, dsi, autre';
COMMENT ON COLUMN weekly_report_recipients.is_active IS 'Si false, le destinataire ne reçoit plus les rapports';