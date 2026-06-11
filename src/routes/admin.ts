import { Router, Request, Response, NextFunction, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'
import { requireTenantAdmin } from '../middleware/roleGuard.js'

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

// ─── GET /api/admin/performance — SLA & performance metrics (via SQL RPC) ───
router.get('/performance', verifyToken, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.tenant?.id
    if (!tenantId) {
      return res.json({ total_reports: 0, resolved_reports: 0, resolution_rate: 0, avg_time_to_ack_hours: null, avg_time_to_resolve_hours: null, sla_compliance_rate: null, by_category: [], monthly: [] })
    }

    const days = Math.min(parseInt(req.query.days as string) || 30, 365)

    const { data, error } = await supabaseAdmin.rpc('get_performance_stats', {
      p_tenant_id: tenantId,
      p_days: days,
    })
    if (error) throw error

    res.json({ period_days: days, ...(data as object) })
  } catch (err) {
    next(err)
  }
})

export default router
