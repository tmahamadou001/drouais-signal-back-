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

function isWithinTenantBounds(
  lat: number,
  lng: number,
  centerLat: number,
  centerLng: number,
  radiusKm: number,
): boolean {
  const R = 6371
  const dLat = (lat - centerLat) * Math.PI / 180
  const dLng = (lng - centerLng) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(centerLat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  const distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return distanceKm <= radiusKm
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

    if (req.tenant?.id) {
      const { data: tenantConfig } = await supabaseAdmin
        .from('tenant_configs')
        .select('map_lat, map_lng, map_radius_km')
        .eq('tenant_id', req.tenant.id)
        .single()

      if (tenantConfig?.map_lat && tenantConfig?.map_lng) {
        const radiusKm = tenantConfig.map_radius_km ?? 15
        if (!isWithinTenantBounds(lat, lng, tenantConfig.map_lat, tenantConfig.map_lng, radiusKm)) {
          throw badRequest(`Les coordonnées sont en dehors de la zone autorisée (rayon : ${radiusKm} km).`)
        }
      }
    }

    const { data: rpcData, error } = await supabaseAdmin.rpc('find_nearby_reports', {
      p_lat: lat,
      p_lng: lng,
      p_radius_meters: 80,
      p_days_ago: 30,
    })

    if (error) throw new AppError(500, 'internal_error', 'Erreur lors de la recherche de signalements similaires.')

    let data: NearbyReportRow[] = rpcData ?? []
    if (req.tenant?.id && data.length > 0) {
      const ids = data.map(r => r.id)
      const { data: tenantReports } = await supabaseAdmin
        .from('reports')
        .select('id')
        .in('id', ids)
        .eq('tenant_id', req.tenant.id)
      const validIds = new Set((tenantReports ?? []).map(r => r.id))
      data = data.filter(r => validIds.has(r.id))
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
