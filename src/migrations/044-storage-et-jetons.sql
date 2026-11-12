-- À exécuter dans l'éditeur SQL de Supabase, **après** la migration 043,
-- et section par section : les deux sont destructives à leur façon.
--
-- Elles ne sont pas dans `server/src/migrations/` parce qu'elles ne décrivent
-- pas un schéma. La première dépend de politiques posées à la main dans le
-- tableau de bord, qu'il faut d'abord lire ; la seconde casse délibérément des
-- liens déjà envoyés par e-mail.

-- ═════════════════════════════════════════════════════════
-- A. Refermer le bucket `photos`   (constat C3 — critique)
-- ═════════════════════════════════════════════════════════
--
-- Avec la clé anon — publiée dans l'application mobile et dans le bundle web —
-- le bucket se laisse lister et télécharger : 103 objets le 12 novembre 2026.
-- Des photos de voirie, donc des visages, des plaques d'immatriculation, des
-- devantures, parfois l'intérieur d'une propriété.
--
-- Deux garde-fous du produit tombent avec : les photos des communes
-- `prospect`, « collectées en silence » et jamais publiées, sont téléchargeables ;
-- et celles jointes aux constats de réparation aussi, alors que la table
-- `resolution_claims` est, elle, correctement verrouillée.
--
-- `lib/photoUpload.ts` suppose un bucket privé et des URL signées valables un
-- an. Les URL signées ne passent pas par le RLS : elles continueront de
-- fonctionner après ce verrouillage. C'est tout l'intérêt.

-- A1. D'ABORD : lire ce qui existe. Ne rien supprimer à l'aveugle.
SELECT policyname, roles, cmd, qual, with_check
FROM   pg_policies
WHERE  schemaname = 'storage' AND tablename = 'objects'
ORDER  BY policyname;

-- A2. Supprimer les politiques qui ouvrent le bucket `photos` à `anon` ou
--     `authenticated`, en reprenant les noms exacts rendus par A1.
--     (Décommenter et compléter — une ligne par politique.)
-- DROP POLICY IF EXISTS "<nom exact rendu par A1>" ON storage.objects;

-- A3. Une seule politique, pour le serveur et personne d'autre.
DROP POLICY IF EXISTS "photos_service_only" ON storage.objects;
CREATE POLICY "photos_service_only" ON storage.objects
FOR ALL TO service_role
USING (bucket_id = 'photos')
WITH CHECK (bucket_id = 'photos');

-- A4. Vérifier, depuis un terminal, avec la clé anon publique.
--     La liste doit rendre `[]` ou une erreur, et le téléchargement 403 :
--
--     curl -X POST "https://<projet>.supabase.co/storage/v1/object/list/photos" \
--          -H "apikey: <clé anon>" -H "Authorization: Bearer <clé anon>" \
--          -H "Content-Type: application/json" -d '{"prefix":"reports/","limit":10}'
--
-- A5. **Vérifier aussi l'écriture**, que l'audit n'a pas pu tester : un `anon`
--     capable d'écrire dans ce bucket en fait un hébergeur de fichiers gratuit,
--     sous votre nom de domaine et à vos frais.
--
--     curl -X POST "https://<projet>.supabase.co/storage/v1/object/photos/test-audit.txt" \
--          -H "apikey: <clé anon>" -H "Authorization: Bearer <clé anon>" \
--          --data-binary "test"      # doit répondre 403
--
--     Si ce test réussit malgré A3, c'est qu'une autre politique subsiste :
--     revenir à A1.

-- ═════════════════════════════════════════════════════════
-- B. Renouveler les jetons de suivi divulgués   (constat C1)
-- ═════════════════════════════════════════════════════════
--
-- `GET /api/reports/:id` rendait `anonymous_token` à qui le demandait, sans
-- compte. 22 des 47 signalements de production en portaient un. Ces jetons
-- doivent être considérés comme publics : n'importe qui ayant parcouru la
-- liste ces derniers mois a pu les collecter, et chacun ouvre la conversation
-- privée entre un habitant et sa mairie — en lecture **et en écriture**.
--
-- Les renouveler casse les liens de suivi déjà envoyés par e-mail à ces
-- habitants : « Suivre mon signalement » répondra introuvable. C'est le prix,
-- et il est plus faible que celui d'un inconnu écrivant à la mairie au nom
-- d'un habitant.
--
-- ⚠️ À ne lancer qu'**après** le déploiement du serveur corrigé : renouveler
-- avant laisserait la route publier aussitôt les nouveaux jetons.

-- B1. Combien de lignes sont concernées, avant d'y toucher.
SELECT count(*) AS jetons_a_renouveler
FROM   public.reports
WHERE  anonymous_token IS NOT NULL;

-- B2. Le renouvellement. `gen_random_bytes` vient de pgcrypto, déjà présent
--     (les jetons de `service_handoffs` s'en servent).
UPDATE public.reports
   SET anonymous_token = encode(gen_random_bytes(32), 'hex'),
       updated_at      = now()
 WHERE anonymous_token IS NOT NULL;

-- B3. Vérifier qu'aucun jeton ne sort plus, ni par l'API ni par PostgREST :
--
--     curl -s "https://api.onsignale.fr/api/reports/<id>" -H "X-Tenant-Slug: dreux" | jq '.report | keys'
--     # ne doit contenir ni anonymous_token, ni anonymous_email, ni user_id
--
--     curl -s "https://<projet>.supabase.co/rest/v1/reports?select=anonymous_token&limit=1" \
--          -H "apikey: <clé anon>"
--     # doit répondre une erreur 42501 (permission denied for column)
