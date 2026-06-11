import { Router, type Request, type Response, NextFunction, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'
import { requireTenantAdmin } from '../middleware/roleGuard.js'
import { AppError, badRequest } from '../middleware/errorHandler.js'

const router: ExpressRouter = Router()

router.get('/heatmap', verifyToken, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.tenant?.id) throw badRequest('Tenant requis.')

    const { period = '30d', category = 'all', status = 'all' } = req.query

    const daysMap: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 }
    const periodDays = period === 'all' ? null : (daysMap[period as string] ?? 30)

    const { data, error } = await supabaseAdmin.rpc('get_heatmap_data', {
      p_tenant_id:   req.tenant.id,
      p_period_days: periodDays,
      p_category:    category === 'all' ? null : category,
      p_status:      status   === 'all' ? null : status,
    })

    if (error) throw new AppError(500, 'internal_error', 'Erreur lors de la récupération des données.')

    res.json(data ?? { points: [], stats: { total_points: 0, hotspots: [], by_category: {}, by_status: {} } })
  } catch (err) {
    next(err)
  }
})

export default router
