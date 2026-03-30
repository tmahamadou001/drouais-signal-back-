import { Router, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken, requireAdmin } from '../middleware/auth'

const router: ExpressRouter = Router()

interface GroupedPoint {
  lat: number
  lng: number
  signal_count: number
  total_votes: number
  categories: Record<string, number>
  address_approx: string | null 
}

interface HeatmapPoint {
  lat: number
  lng: number
  weight: number
  signal_count: number
  dominant_category: string
  address_approx: string | null
}

interface Hotspot {
  lat: number
  lng: number
  count: number
  dominant_category: string
  address_approx: string | null
}

router.get('/heatmap', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { period = '30d', category = 'all', status = 'all' } = req.query

    let query = supabaseAdmin
      .from('reports')
      .select('id, lat, lng, category, status, vote_count, address_approx, created_at')
      .not('lat', 'is', null)
      .not('lng', 'is', null)

    // Filtre période
    if (period !== 'all') {
      const daysMap: Record<string, number> = {
        '7d': 7,
        '30d': 30,
        '90d': 90
      }
      const days = daysMap[period as string]
      if (days) {
        const cutoffDate = new Date()
        cutoffDate.setDate(cutoffDate.getDate() - days)
        query = query.gte('created_at', cutoffDate.toISOString())
      }
    }

    // Filtre catégorie
    if (category !== 'all') {
      query = query.eq('category', category)
    }

    // Filtre statut
    if (status !== 'all') {
      query = query.eq('status', status)
    }

    const { data: reports, error } = await query

    if (error) {
      console.error('Erreur Supabase heatmap:', error)
      return res.status(500).json({ error: 'Erreur lors de la récupération des données' })
    }

    if (!reports || reports.length === 0) {
      return res.json({
        points: [],
        stats: {
          total_points: 0,
          hotspots: [],
          by_category: {},
          by_status: {}
        }
      })
    }

    // Regroupement par coordonnées arrondies à 4 décimales
    const grouped = new Map<string, GroupedPoint>()

    reports.forEach(r => {
      const roundedLat = Math.round(r.lat * 10000) / 10000
      const roundedLng = Math.round(r.lng * 10000) / 10000
      const key = `${roundedLat},${roundedLng}`

      if (!grouped.has(key)) {
        grouped.set(key, {
          lat: roundedLat,
          lng: roundedLng,
          signal_count: 0,
          total_votes: 0,
          categories: {},
          address_approx: r.address_approx || null
        })
      }

      const point = grouped.get(key)!
      point.signal_count++
      point.total_votes += r.vote_count || 0
      point.categories[r.category] = (point.categories[r.category] || 0) + 1
    })

    // Calcul du poids et de la catégorie dominante
    const points: HeatmapPoint[] = Array.from(grouped.values()).map(p => {
      const weight = p.signal_count + (p.total_votes * 0.5)
      
      // Catégorie dominante
      let dominant_category = 'autre'
      let maxCount = 0
      for (const [cat, count] of Object.entries(p.categories)) {
        if (count > maxCount) {
          maxCount = count
          dominant_category = cat
        }
      }

      return {
        lat: p.lat,
        lng: p.lng,
        weight: Math.round(weight * 10) / 10,
        signal_count: p.signal_count,
        dominant_category,
        address_approx: p.address_approx
      }
    })

    // Stats globales
    const by_category: Record<string, number> = {}
    const by_status: Record<string, number> = {}

    reports.forEach(r => {
      by_category[r.category] = (by_category[r.category] || 0) + 1
      by_status[r.status] = (by_status[r.status] || 0) + 1
    })

    // Top 5 hotspots
    const hotspots: Hotspot[] = Array.from(grouped.values())
      .sort((a, b) => b.signal_count - a.signal_count)
      .slice(0, 5)
      .map(p => {
        let dominant_category = 'autre'
        let maxCount = 0
        for (const [cat, count] of Object.entries(p.categories)) {
          if (count > maxCount) {
            maxCount = count
            dominant_category = cat
          }
        }

        return {
          lat: p.lat,
          lng: p.lng,
          count: p.signal_count,
          dominant_category,
          address_approx: p.address_approx
        }
      })

    res.json({
      points,
      stats: {
        total_points: reports.length,
        hotspots,
        by_category,
        by_status
      }
    })

  } catch (err) {
    console.error('Erreur heatmap:', err)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

export default router
