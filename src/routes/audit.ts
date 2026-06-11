import { Router, type Request, type Response, NextFunction, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'
import { requireSuperAdmin } from '../middleware/roleGuard.js'
import { AppError, forbidden } from '../middleware/errorHandler.js'

const router: ExpressRouter = Router()

// ─── GET /api/audit/logs ─── Super Admin / Tenant Admin ────────
router.get('/logs', verifyToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 100)
    const offset = (page - 1) * limit

    const tenantSlug = req.query.tenant as string | undefined
    const userEmail  = req.query.user as string | undefined
    const action     = req.query.action as string | undefined
    const search     = req.query.search as string | undefined
    const startDate  = req.query.startDate as string | undefined
    const endDate    = req.query.endDate as string | undefined

    const userRole = req.userRole
    const isSuperAdmin = userRole === 'super_admin'

    if (!isSuperAdmin) {
      if (!req.tenant?.id) throw forbidden('Accès refusé.')

      const { data: tenantUser } = await supabaseAdmin
        .from('tenant_users')
        .select('role')
        .eq('user_id', req.userId!)
        .eq('tenant_id', req.tenant.id)
        .eq('is_active', true)
        .single()

      if (!tenantUser || (tenantUser.role !== 'admin' && tenantUser.role !== 'agent')) {
        throw forbidden('Accès refusé.')
      }
    }

    let query = supabaseAdmin
      .from('audit_logs')
      .select('*', { count: 'exact' })

    if (!isSuperAdmin && req.tenant?.id) {
      query = query.eq('tenant_id', req.tenant.id)
    }

    if (tenantSlug) query = query.eq('tenant_slug', tenantSlug)
    if (userEmail)  query = query.ilike('user_email', `%${userEmail}%`)
    if (action)     query = query.eq('action', action)
    if (search) {
      query = query.or(`user_email.ilike.%${search}%,entity_id.ilike.%${search}%,metadata::text.ilike.%${search}%`)
    }
    if (startDate) query = query.gte('created_at', startDate)
    if (endDate)   query = query.lte('created_at', endDate)

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    const { data, error, count } = await query

    if (error) throw new AppError(500, 'internal_error', 'Erreur récupération logs.')

    res.json({
      data: data || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/audit/stats ─── Super Admin ───────────────────────
router.get('/stats', verifyToken, requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = parseInt(req.query.days as string) || 30
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    const { count: totalLogs } = await supabaseAdmin
      .from('audit_logs')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', since)

    const { data: actionStats } = await supabaseAdmin
      .from('audit_logs')
      .select('action')
      .gte('created_at', since)

    const actionCounts: Record<string, number> = {}
    actionStats?.forEach((log: { action: string }) => {
      actionCounts[log.action] = (actionCounts[log.action] || 0) + 1
    })

    const { data: userStats } = await supabaseAdmin
      .from('audit_logs')
      .select('user_email')
      .gte('created_at', since)
      .not('user_email', 'is', null)

    const userCounts: Record<string, number> = {}
    userStats?.forEach((log: { user_email: string }) => {
      userCounts[log.user_email] = (userCounts[log.user_email] || 0) + 1
    })

    const topUsers = Object.entries(userCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([email, count]) => ({ email, count }))

    res.json({
      totalLogs: totalLogs || 0,
      actionStats: actionCounts,
      topUsers,
      period: `${days} jours`,
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/audit/actions ─── Super Admin / Tenant Admin ──────
router.get('/actions', verifyToken, (_req: Request, res: Response) => {
  res.json({
    actions: [
      'user.created',
      'user.invited',
      'report.status_changed',
      'report.deleted',
      'report.bulk_deleted',
      'tenant.created',
      'tenant.status_changed',
      'tenant_config.updated',
      'tenant_categories.updated',
    ],
  })
})

// ─── GET /api/audit/tenants ─── Super Admin ─────────────────────
router.get('/tenants', verifyToken, requireSuperAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tenants')
      .select('slug, name')
      .order('name')

    if (error) throw error

    res.json({ tenants: data || [] })
  } catch (err) {
    next(err)
  }
})

export default router
