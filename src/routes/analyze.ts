import { Router, Request, Response, type Router as ExpressRouter } from 'express'
import { anthropic } from '../lib/anthropic.js'
import { analyzePhotoWithGemini, type TenantCategoryForPrompt } from '../lib/gemini.js'
import { upload } from '../middleware/upload.js'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'

const router: ExpressRouter = Router()

const DEFAULT_CATEGORIES: TenantCategoryForPrompt[] = [
  { slug: 'voirie',    label: 'Voirie',    description: 'nid-de-poule, trottoir cassé, route abîmée, signalisation routière' },
  { slug: 'eclairage', label: 'Éclairage', description: 'lampadaire cassé ou éteint, câble apparent, zone mal éclairée' },
  { slug: 'dechets',   label: 'Déchets',   description: 'dépôt sauvage, poubelle renversée, encombrants, graffiti, tags' },
  { slug: 'autre',     label: 'Autre',     description: 'tout ce qui ne rentre pas dans les catégories ci-dessus' },
]

async function getTenantCategories(tenantId?: string): Promise<TenantCategoryForPrompt[]> {
  if (!tenantId) return DEFAULT_CATEGORIES
  const { data } = await supabaseAdmin
    .from('tenant_categories')
    .select('slug, label, description')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('sort_order')
  return data && data.length > 0 ? data : DEFAULT_CATEGORIES
}

// ─── POST /api/analyze-photo — Analyze photo with AI (Claude or Gemini) ───
router.post('/', upload.single('photo'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Photo requise' })
    }

    // Convertir le buffer en base64
    const base64Image = req.file.buffer.toString('base64')
    const mediaType = req.file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp'

    // Charger les catégories du tenant courant
    const categories = await getTenantCategories(req.tenant?.id)
    const fallbackSlug = categories[categories.length - 1]?.slug ?? 'autre'

    // Déterminer le provider à utiliser (GEMINI par défaut, CLAUDE si configuré)
    const aiProvider = process.env.AI_PROVIDER || 'GEMINI'

    // ═══════════════════════════════════════════════════════════════
    // GEMINI PROVIDER
    // ═══════════════════════════════════════════════════════════════
    if (aiProvider === 'GEMINI') {
      const result = await analyzePhotoWithGemini(base64Image, mediaType, categories)
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
          category: fallbackSlug,
          title: '',
          confidence: 'faible',
          description: '',
          error: 'service_unavailable',
        })
      }

      const slugList = categories.map((c) => `"${c.slug}"`).join(' | ')
      const rules = categories.map((c) => `- ${c.slug} : ${c.description ?? c.label}`).join('\n')

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
  "category": ${slugList},
  "title": "titre court en français, max 60 caractères",
  "confidence": "fort" | "moyen" | "faible",
  "description": "une phrase descriptive en français, max 120 caractères"
}

Règles de catégorisation :
${rules}

Si l'image n'est pas un problème urbain (photo floue, hors-sujet, inappropriée), retourne :
{
  "category": "${fallbackSlug}",
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
            category: fallbackSlug,
            title: '',
            confidence: 'faible',
            description: '',
            error: 'timeout',
          })
        }

        // JSON invalide ou autre erreur
        console.error('Erreur analyse Claude:', err)
        return res.json({
          category: fallbackSlug,
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
