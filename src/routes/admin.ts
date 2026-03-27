import { Router, Request, Response } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'

const router = Router()

// ─── GET /api/admin/stats — Public stats (also used on home page) ───
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('reports')
      .select('status')

    if (error) throw error

    const stats = {
      total: data.length,
      en_attente: data.filter(r => r.status === 'en_attente').length,
      pris_en_charge: data.filter(r => r.status === 'pris_en_charge').length,
      resolu: data.filter(r => r.status === 'resolu').length,
    }

    res.json(stats)
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erreur serveur.' })
  }
})

export default router
