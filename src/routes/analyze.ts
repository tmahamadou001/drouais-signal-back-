import { Router, Request, Response, type Router as ExpressRouter } from 'express'
import { anthropic } from '../lib/anthropic.js'
import { analyzePhotoWithGemini } from '../lib/gemini.js'
import { uploadMemory } from '../middleware/uploadMemory.js'

const router: ExpressRouter = Router()

// ─── POST /api/analyze-photo — Analyze photo with AI (Claude or Gemini) ───
router.post('/', uploadMemory.single('photo'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Photo requise' })
    }

    // Convertir le buffer en base64
    const base64Image = req.file.buffer.toString('base64')
    const mediaType = req.file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp'

    // Déterminer le provider à utiliser (GEMINI par défaut, CLAUDE si configuré)
    const aiProvider = process.env.AI_PROVIDER || 'GEMINI'

    // ═══════════════════════════════════════════════════════════════
    // GEMINI PROVIDER
    // ═══════════════════════════════════════════════════════════════
    if (aiProvider === 'GEMINI') {
      const result = await analyzePhotoWithGemini(base64Image, mediaType)
      return res.json(result)
    }

    // ═══════════════════════════════════════════════════════════════
    // CLAUDE PROVIDER
    // ═══════════════════════════════════════════════════════════════
    if (aiProvider === 'CLAUDE') {
      // Vérifier que la clé API Claude est configurée
      if (!process.env.ANTHROPIC_API_KEY) {
        console.error('ANTHROPIC_API_KEY non configurée')
        return res.json({
          category: 'autre',
          title: '',
          confidence: 'faible',
          description: '',
          error: 'service_unavailable',
        })
      }

      // Appeler Claude avec timeout de 10 secondes
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)

      try {
        const message = await anthropic.messages.create({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 200,
          system: `Tu es un assistant qui analyse des photos de problèmes urbains signalés par des citoyens français.
Tu dois répondre UNIQUEMENT en JSON valide, sans aucun texte avant ou après.`,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: base64Image,
                  },
                },
                {
                  type: 'text',
                  text: `Analyse cette photo et retourne ce JSON :
{
  "category": "voirie" | "eclairage" | "dechets" | "autre",
  "title": "titre court en français, max 60 caractères",
  "confidence": "fort" | "moyen" | "faible",
  "description": "une phrase descriptive en français, max 120 caractères"
}

Règles de catégorisation :
- voirie : nid-de-poule, trottoir cassé, route abîmée, signalisation routière, passage piéton effacé
- eclairage : lampadaire cassé ou éteint, câble apparent, zone mal éclairée
- dechets : dépôt sauvage, poubelle renversée, encombrants, graffiti, tags
- autre : tout ce qui ne rentre pas dans les catégories ci-dessus

Si l'image n'est pas un problème urbain (photo floue, hors-sujet, inappropriée), retourne :
{
  "category": "autre",
  "title": "Signalement divers",
  "confidence": "faible",
  "description": "Impossible d'identifier le problème sur la photo"
}`,
                },
              ],
            },
          ],
        })

        clearTimeout(timeout)

        // Extraire le texte de la réponse
        const textContent = message.content.find((block) => block.type === 'text')
        if (!textContent || textContent.type !== 'text') {
          throw new Error('Pas de réponse texte de Claude')
        }

        // Parser le JSON
        const result = JSON.parse(textContent.text)

        // Valider la structure
        if (
          !result.category ||
          !result.title ||
          !result.confidence ||
          !result.description
        ) {
          throw new Error('JSON invalide')
        }

        return res.json(result)
      } catch (err: any) {
        clearTimeout(timeout)

        // Timeout ou erreur API
        if (err.name === 'AbortError' || err.message?.includes('timeout')) {
          return res.json({
            category: 'autre',
            title: '',
            confidence: 'faible',
            description: '',
            error: 'timeout',
          })
        }

        // JSON invalide ou autre erreur
        console.error('Erreur analyse Claude:', err)
        return res.json({
          category: 'autre',
          title: '',
          confidence: 'faible',
          description: '',
          error: 'parse_error',
        })
      }
    }

    // Provider invalide
    return res.status(400).json({ error: 'AI_PROVIDER invalide. Utilisez GEMINI ou CLAUDE.' })
  } catch (err: any) {
    console.error('Erreur analyse photo:', err)
    res.status(500).json({ error: err.message || 'Erreur serveur' })
  }
})

export default router
