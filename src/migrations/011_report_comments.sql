-- ═══════════════════════════════════════════════════════════════
-- Migration : Messages sur signalements (report_comments)
-- Description : Table pour les messages entre agents et citoyens
-- ═══════════════════════════════════════════════════════════════

-- ─── TABLE report_comments ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.report_comments (
  id          UUID PRIMARY KEY
              DEFAULT gen_random_uuid(),

  -- Relations
  report_id   UUID NOT NULL
              REFERENCES reports(id)
              ON DELETE CASCADE,
  tenant_id   UUID NOT NULL
              REFERENCES tenants(id)
              ON DELETE CASCADE,

  -- Auteur
  author_type TEXT NOT NULL
              CHECK (author_type IN (
                'agent',
                'citizen'
              )),
  author_id   UUID NOT NULL
              REFERENCES auth.users(id),

  -- Contenu
  content     TEXT NOT NULL
              CHECK (
                char_length(content) >= 1 AND
                char_length(content) <= 500
              ),

  -- Photo (agent uniquement, résolution)
  photo_url   TEXT,
  is_resolution_photo BOOLEAN DEFAULT false,

  -- Lien parent (pour les réponses citoyen)
  -- NULL = message initial de l'agent
  -- UUID = réponse à ce message d'agent
  parent_id   UUID
              REFERENCES report_comments(id)
              ON DELETE SET NULL,

  -- Statut du signalement au moment du message
  -- (traçabilité)
  report_status_at_time TEXT,

  -- Lecture
  read_by_citizen     BOOLEAN DEFAULT false,
  read_by_agent       BOOLEAN DEFAULT false,

  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ─── INDEX POUR LES PERFORMANCES ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_report_comments_report_id
ON report_comments(report_id);

CREATE INDEX IF NOT EXISTS idx_report_comments_tenant_id
ON report_comments(tenant_id);

CREATE INDEX IF NOT EXISTS idx_report_comments_author_id
ON report_comments(author_id);

-- Index pour les non lus (dashboard agent)
CREATE INDEX IF NOT EXISTS idx_report_comments_unread_agent
ON report_comments(tenant_id, read_by_agent)
WHERE author_type = 'citizen'
AND read_by_agent = false;

-- ─── RLS (ROW LEVEL SECURITY) ──────────────────────────────────
ALTER TABLE report_comments
ENABLE ROW LEVEL SECURITY;

-- Supprimer les policies existantes si elles existent
DROP POLICY IF EXISTS "comments_agent_all" ON report_comments;
DROP POLICY IF EXISTS "comments_citizen_select" ON report_comments;
DROP POLICY IF EXISTS "comments_citizen_insert" ON report_comments;

-- Agent/admin : accès complet à son tenant
CREATE POLICY "comments_agent_all"
ON report_comments FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM tenant_users tu
    WHERE tu.user_id = auth.uid()
    AND tu.tenant_id = report_comments.tenant_id
    AND tu.role IN ('admin', 'agent')
    AND tu.is_active = true
  )
  OR (
    (auth.jwt() -> 'user_metadata' ->> 'role')
    = 'super_admin'
  )
);

-- Citoyen : lecture uniquement sur SES signalements
CREATE POLICY "comments_citizen_select"
ON report_comments FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM reports r
    WHERE r.id = report_comments.report_id
    AND r.user_id = auth.uid()
    AND r.tenant_id = report_comments.tenant_id
  )
);

-- Citoyen : insertion uniquement sur SES signalements
-- avec parent obligatoire (réponse à un agent)
CREATE POLICY "comments_citizen_insert"
ON report_comments FOR INSERT
WITH CHECK (
  -- Seulement author_type = 'citizen'
  author_type = 'citizen'
  AND author_id = auth.uid()
  -- Seulement sur ses propres signalements
  AND EXISTS (
    SELECT 1 FROM reports r
    WHERE r.id = report_comments.report_id
    AND r.user_id = auth.uid()
  )
  -- Doit avoir un parent (réponse à un agent)
  AND parent_id IS NOT NULL
);

-- ─── VÉRIFICATION REALTIME ─────────────────────────────────────
-- Activer la réplication Realtime pour cette table
-- Note: Si la table est déjà dans la publication, cette commande échouera
-- mais ce n'est pas grave, on peut ignorer l'erreur
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.report_comments;
EXCEPTION
  WHEN duplicate_object THEN
    NULL; -- Table déjà dans la publication, on ignore
END $$;

-- ═══════════════════════════════════════════════════════════════
-- FIN DE LA MIGRATION
-- ═══════════════════════════════════════════════════════════════

-- TESTS À EFFECTUER APRÈS CETTE MIGRATION :
-- 
-- 1. Vérifier que la table existe :
--    SELECT * FROM report_comments LIMIT 1;
--
-- 2. Tester insertion agent (via Supabase dashboard) :
--    INSERT INTO report_comments (report_id, tenant_id, author_type, author_id, content)
--    VALUES ('uuid-report', 'uuid-tenant', 'agent', 'uuid-agent', 'Test message');
--    → Doit fonctionner ✅
--
-- 3. Tester RLS citoyen (autre signalement) :
--    → Doit échouer avec erreur RLS ✅
--
-- 4. Vérifier les index :
--    SELECT indexname FROM pg_indexes WHERE tablename = 'report_comments';
