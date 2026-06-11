import { Router, Request, Response, NextFunction, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'

const router: ExpressRouter = Router()

// ─── GET /api/admin/stats — Public stats (also used on home page) ───
router.get('/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.tenant?.id

    const buildCount = (status?: string) => {
      let q = supabaseAdmin
        .from('reports')
        .select('*', { count: 'exact', head: true })
      if (tenantId) q = q.eq('tenant_id', tenantId)
      if (status)   q = q.eq('status', status)
      return q
    }

    const [total, enAttente, prisEnCharge, resolu] = await Promise.all([
      buildCount(),
      buildCount('en_attente'),
      buildCount('pris_en_charge'),
      buildCount('resolu'),
    ])

    if (total.error) throw total.error

    res.json({
      total:          total.count        ?? 0,
      en_attente:     enAttente.count    ?? 0,
      pris_en_charge: prisEnCharge.count ?? 0,
      resolu:         resolu.count       ?? 0,
    })
  } catch (err) {
    next(err)
  }
})

export default router
