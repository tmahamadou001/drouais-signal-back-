import { Router, Request, Response } from 'express'
import type { Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'

const router: ExpressRouter = Router()

interface MapMarker {
  id: string
  lat: number
  lng: number
  status: 'en_attente' | 'pris_en_charge' | 'resolu'
  category: string
  title: string
  vote_count: number
}

router.get('/markers', async (req: Request, res: Response) => {
  try {
    let query = supabaseAdmin
      .from('reports')
      .select('id, lat, lng, status, category, title, vote_count')
      .not('lat', 'is', null)
      .not('lng', 'is', null)
      .order('created_at', { ascending: false })

    if (req.tenant?.id) {
      query = query.eq('tenant_id', req.tenant.id)
    }

    const { data, error } = await query

    if (error) {
      console.error('Erreur lors de la récupération des markers:', error)
      return res.status(500).json({
        error: 'database_error',
        message: 'Erreur lors de la récupération des markers.',
      })
    }

    res.setHeader('Cache-Control', 'public, max-age=30')

    return res.json({
      markers: (data ?? []) as MapMarker[],
      total: (data ?? []).length,
    })
  } catch (err: any) {
    console.error('Erreur serveur /api/map/markers:', err)
    return res.status(500).json({
      error: 'server_error',
      message: err.message || 'Erreur serveur.',
    })
  }
})

export default router
