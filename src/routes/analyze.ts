import { Router, Request, Response, NextFunction, type Router as ExpressRouter } from 'express'
import { analyzePhotoWithGemini, type TenantCategoryForPrompt } from '../lib/gemini.js'
import { analyzePhotoWithClaude } from '../lib/claude.js'
import { upload } from '../middleware/upload.js'
import { resolveActiveCategories } from '../services/categoryService.js'
import { badRequest } from '../middleware/errorHandler.js'

const router: ExpressRouter = Router()

/**
 * Le repli quand la base ne répond pas.
 *
 * La liste vit désormais dans la table `categories` : c'est elle, et non celle
 * de chaque commune, qui forme l'espace de sortie du modèle. Sans cette
 * stabilité, la même photo de matelas ressort « Encombrants » chez un client,
 * « Propreté » chez un autre et « Autre » chez un prospect — et la justesse de
 * l'IA devient impossible à mesurer, donc à améliorer.
 *
 * Calibrée sur la distribution réelle : sur les 1,54 million d'anomalies
 * publiées par la Ville de Paris, les encombrants, les graffitis et la propreté
 * pèsent 82 % à eux trois ; la voirie, 3,8 %.
 */
const FALLBACK_CATEGORIES: TenantCategoryForPrompt[] = [
  { slug: 'encombrants',   label: 'Objets abandonnés et encombrants',    description: 'matelas, meuble, électroménager, carton ou objet volumineux laissé sur la voie publique' },
  { slug: 'graffitis',     label: 'Graffitis, tags et affichage sauvage', description: 'tag, graffiti, autocollant ou affiche collée sans autorisation' },
  { slug: 'proprete',      label: 'Propreté et déchets',                 description: 'corbeille pleine ou cassée, déchets au sol, souillure, conteneur débordant' },
  { slug: 'stationnement', label: 'Véhicules gênants et épaves',         description: 'véhicule ou deux-roues mal garé, gênant, ventouse ou à l\'état d\'épave' },
  { slug: 'mobilier',      label: 'Mobilier urbain et éclairage',        description: 'lampadaire éteint ou cassé, banc, abribus, poteau ou panneau dégradé' },
  { slug: 'voirie',        label: 'Voirie et chaussée',                  description: 'nid-de-poule, trottoir déformé, bordure descellée, marquage effacé' },
  { slug: 'commerce',      label: 'Terrasses et occupations commerciales', description: 'terrasse, étalage ou dépôt de commerçant débordant sur le domaine public' },
  { slug: 'vegetation',    label: 'Arbres, végétation et animaux',       description: 'branche tombée, haie envahissante, arbre malade, animal mort ou errant' },
  { slug: 'eau',           label: 'Eau et assainissement',               description: 'fuite, écoulement, bouche d\'égout obstruée, avaloir bouché' },
  { slug: 'autre',         label: 'Autre',                               description: 'problème qui ne correspond à aucune des catégories ci-dessus' },
]

/**
 * Les catégories proposées au modèle, pour ce tenant.
 *
 * La liste nationale, moins ce que la commune a désactivé, plus son éventuelle
 * spécificité locale. Les slugs restent canoniques quoi qu'il arrive : la
 * commune choisit ce qu'elle traite et comment elle le nomme, jamais ce qui
 * existe.
 */
async function getCategoriesForPrompt(tenantId?: string): Promise<TenantCategoryForPrompt[]> {
  const categories = await resolveActiveCategories(tenantId)

  if (categories.length === 0) return FALLBACK_CATEGORIES

  return categories.map((category) => ({
    slug: category.slug,
    label: category.label,
    description: category.description,
  }))
}

// ─── POST /api/analyze-photo — Analyze photo with AI (Claude or Gemini) ───
router.post('/', upload.single('photo'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw badRequest('Photo requise.')

    const base64Image = req.file.buffer.toString('base64')
    const mediaType = req.file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp'

    const categories = await getCategoriesForPrompt(req.tenant?.id)

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
