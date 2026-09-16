import { Router, Request, Response, NextFunction } from 'express'
import type { Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { AppError, badRequest } from '../middleware/errorHandler.js'

const router: ExpressRouter = Router()

type SimilarityScore = 'fort' | 'moyen' | 'faible'

interface DuplicateReport {
  id: string
  title: string
  category: string
  description: string
  photo_url: string | null
  vote_count: number
  status: string
  distance_meters: number
  similarity_score: SimilarityScore
  created_at: string
}

interface CheckDuplicateBody {
  lat: number
  lng: number
  category: string
}

interface NearbyReportRow {
  id: string
  title: string
  category: string
  description: string
  photo_url: string | null
  vote_count: number
  status: string
  distance_meters: number
  created_at: string
}

function calculateSimilarityScore(
  distance: number,
  sameCategory: boolean
): SimilarityScore {
  if (sameCategory && distance < 30) return 'fort'
  if (sameCategory && distance >= 30 && distance <= 80) return 'moyen'
  return 'faible'
}

router.post('/check-duplicate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { lat, lng, category } = req.body as CheckDuplicateBody

    if (!lat || !lng || !category) {
      throw badRequest('Les champs lat, lng et category sont requis.')
    }

    if (typeof lat !== 'number' || typeof lng !== 'number') {
      throw badRequest('Les coordonnées doivent être des nombres.')
    }

    if (!req.tenant?.id) throw badRequest('Commune requise.')

    /*
     * Le bornage géographique a disparu.
     *
     * Il rejetait une recherche dont les coordonnées sortaient d'un cercle de
     * 15 km autour de la mairie. C'était cohérent quand le citoyen choisissait
     * sa commune ; depuis la v2 la position fait autorité et le tenant découle
     * des frontières INSEE, qui n'ont rien de circulaire. Une commune étendue ou
     * un signalement en limite communale tombait dehors — et l'échec était
     * invisible, le client avalant volontairement l'erreur pour ne pas bloquer
     * un envoi. L'écran de doublon ne s'affichait simplement jamais.
     */

    const { data: rpcData, error } = await supabaseAdmin.rpc('find_nearby_reports', {
      p_lat: lat,
      p_lng: lng,
      p_radius_meters: 80,
      p_days_ago: 30,
    })

    if (error) throw new AppError(500, 'internal_error', 'Erreur lors de la recherche de signalements similaires.')

    /**
     * `find_nearby_reports` cherche dans **toute** la base : la fonction date
     * d'avant le multi-tenant et ne connaît ni commune ni publication. Le tri
     * se fait donc ici, et il est obligatoire.
     *
     * Deux filtres, deux raisons distinctes :
     *
     *  - `tenant_id` — sans lui, un appel sans en-tête de commune rendait les
     *    signalements de n'importe quelle commune de France ;
     *  - `is_published` — les signalements d'une commune prospect ne sont
     *    publiés nulle part, et les faire apparaître ici avec leur titre, leur
     *    photo et leur statut serait une publication comme une autre.
     */
    let data: NearbyReportRow[] = rpcData ?? []

    if (data.length > 0) {
      const { data: visible } = await supabaseAdmin
        .from('reports')
        .select('id')
        .in('id', data.map((report) => report.id))
        .eq('tenant_id', req.tenant!.id)
        .eq('is_published', true)

      const allowed = new Set((visible ?? []).map((report) => report.id))
      data = data.filter((report) => allowed.has(report.id))
    }

    if (data.length === 0) {
      return res.json({ duplicates_found: false, reports: [] })
    }

    const duplicates: DuplicateReport[] = data
      .map((report: NearbyReportRow) => {
        const sameCategory = report.category === category
        const similarity_score = calculateSimilarityScore(report.distance_meters, sameCategory)
        return {
          id: report.id,
          title: report.title,
          category: report.category,
          description: report.description,
          photo_url: report.photo_url,
          vote_count: report.vote_count || 0,
          status: report.status,
          distance_meters: Math.round(report.distance_meters),
          similarity_score,
          created_at: report.created_at,
        }
      })
      .filter((report: DuplicateReport) =>
        report.similarity_score === 'fort' || report.similarity_score === 'moyen'
      )
      .slice(0, 3)

    if (duplicates.length === 0) {
      return res.json({ duplicates_found: false, reports: [] })
    }

    return res.json({ duplicates_found: true, reports: duplicates })
  } catch (err) {
    next(err)
  }
})

export default router
