import { Router, Request, Response } from 'express'
import type { Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'

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

const GEO_BOUNDS = {
  LAT_MIN: 48.0,
  LAT_MAX: 49.0,
  LNG_MIN: 1.0,
  LNG_MAX: 2.0,
}

function validateCoordinates(lat: number, lng: number): boolean {
  return (
    lat >= GEO_BOUNDS.LAT_MIN &&
    lat <= GEO_BOUNDS.LAT_MAX &&
    lng >= GEO_BOUNDS.LNG_MIN &&
    lng <= GEO_BOUNDS.LNG_MAX
  )
}

function calculateSimilarityScore(
  distance: number,
  sameCategory: boolean
): SimilarityScore {
  if (sameCategory && distance < 30) return 'fort'
  if (sameCategory && distance >= 30 && distance <= 80) return 'moyen'
  return 'faible'
}

router.post('/check-duplicate', async (req: Request, res: Response) => {
  try {
    const { lat, lng, category } = req.body as CheckDuplicateBody

    if (!lat || !lng || !category) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'Les champs lat, lng et category sont requis.',
      })
    }

    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({
        error: 'invalid_coordinates',
        message: 'Les coordonnées doivent être des nombres.',
      })
    }

    if (!validateCoordinates(lat, lng)) {
      return res.status(400).json({
        error: 'coordinates_out_of_bounds',
        message: `Les coordonnées doivent être dans la zone autorisée (lat: ${GEO_BOUNDS.LAT_MIN}-${GEO_BOUNDS.LAT_MAX}, lng: ${GEO_BOUNDS.LNG_MIN}-${GEO_BOUNDS.LNG_MAX}).`,
      })
    }

    const { data: rpcData, error } = await supabaseAdmin.rpc('find_nearby_reports', {
      p_lat: lat,
      p_lng: lng,
      p_radius_meters: 80,
      p_days_ago: 30,
    })

    if (error) {
      console.error('Erreur lors de la recherche de doublons:', error)
      return res.status(500).json({
        error: 'database_error',
        message: 'Erreur lors de la recherche de signalements similaires.',
      })
    }

    // Filtrer par tenant si disponible
    let data = rpcData
    if (req.tenant?.id && data && data.length > 0) {
      const ids = data.map((r: any) => r.id)
      const { data: tenantReports } = await supabaseAdmin
        .from('reports')
        .select('id')
        .in('id', ids)
        .eq('tenant_id', req.tenant.id)
      const validIds = new Set((tenantReports ?? []).map((r: any) => r.id))
      data = data.filter((r: any) => validIds.has(r.id))
    }

    if (!data || data.length === 0) {
      return res.json({
        duplicates_found: false,
        reports: [],
      })
    }

    const duplicates: DuplicateReport[] = data
      .map((report: any) => {
        const sameCategory = report.category === category
        const similarity_score = calculateSimilarityScore(
          report.distance_meters,
          sameCategory
        )

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
      return res.json({
        duplicates_found: false,
        reports: [],
      })
    }

    return res.json({
      duplicates_found: true,
      reports: duplicates,
    })
  } catch (err: any) {
    console.error('Erreur serveur check-duplicate:', err)
    return res.status(500).json({
      error: 'server_error',
      message: err.message || 'Erreur serveur.',
    })
  }
})

export default router
