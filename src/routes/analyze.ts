import { Router, Request, Response, NextFunction, type Router as ExpressRouter } from 'express'
import { analyzePhotoWithGemini, type TenantCategoryForPrompt } from '../lib/gemini.js'
import { analyzePhotoWithClaude } from '../lib/claude.js'
import { upload } from '../middleware/upload.js'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { badRequest } from '../middleware/errorHandler.js'

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
router.post('/', upload.single('photo'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw badRequest('Photo requise.')

    const base64Image = req.file.buffer.toString('base64')
    const mediaType = req.file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp'

    const categories = await getTenantCategories(req.tenant?.id)

    const aiProvider = process.env.AI_PROVIDER || 'GEMINI'

    if (aiProvider === 'GEMINI') {
      return res.json(await analyzePhotoWithGemini(base64Image, mediaType, categories))
    }

    if (aiProvider === 'CLAUDE') {
      return res.json(await analyzePhotoWithClaude(base64Image, mediaType, categories))
    }

    throw badRequest('AI_PROVIDER invalide. Utilisez GEMINI ou CLAUDE.')
  } catch (err) {
    next(err)
  }
})

export default router
