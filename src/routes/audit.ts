import { Router, type Request, type Response, NextFunction, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'
import { requirePlatformAdmin, requireTenantAdmin } from '../middleware/roleGuard.js'
import { AppError } from '../middleware/errorHandler.js'
import { readLimit } from '../lib/pagination.js'
import { sanitizeSearch } from '../lib/reportFilters.js'

const router: ExpressRouter = Router()

// ─── GET /api/audit/logs ─── Super Admin / Tenant Admin ────────
/**
 * Le journal d'audit d'une commune.
 *
 * `requireTenantAdmin` plutôt qu'une vérification écrite ici : le code
 * acceptait `agent`, alors que la matrice de `CLAUDE.md` réserve cette route
 * aux administrateurs. Un technicien terrain lisait donc les adresses de toute
 * l'équipe, les adresses IP, les agents utilisateurs et les métadonnées de
 * chaque action de sa commune — un journal d'audit sert à contrôler ceux qui
 * agissent, il ne peut pas être lisible par tous ceux qu'il surveille.
 *
 * Le garde rend aussi `super_admin` sans requête supplémentaire, ce que la
 * vérification manuelle refaisait à la main.
 */
router.get('/logs', verifyToken, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = readLimit(req.query.limit)
    const offset = (page - 1) * limit

    const tenantSlug = req.query.tenant as string | undefined
    const userEmail  = req.query.user as string | undefined
    const action     = req.query.action as string | undefined
    const search     = req.query.search as string | undefined
    const startDate  = req.query.startDate as string | undefined
    const endDate    = req.query.endDate as string | undefined

    // `requireTenantAdmin` a déjà tranché : il ne reste qu'à savoir si l'on
    // doit borner la lecture à une commune.
    const isSuperAdmin = req.userRole === 'super_admin'

    let query = supabaseAdmin
      .from('audit_logs')
      .select('*', { count: 'exact' })

    if (!isSuperAdmin && req.tenant?.id) {
      query = query.eq('tenant_id', req.tenant.id)
    }

    if (tenantSlug) query = query.eq('tenant_slug', tenantSlug)
    if (userEmail)  query = query.ilike('user_email', `%${userEmail}%`)
    if (action)     query = query.eq('action', action)
    /**
     * Le terme de recherche est assaini avant d'entrer dans un `or=`.
     *
     * Les virgules et les parenthèses y sont des **opérateurs** : un terme brut
     * réécrivait la clause, et au minimum provoquait des 500 à volonté.
     * `sanitizeSearch` existait déjà pour les signalements et n'avait pas été
     * appliqué ici — le même filtre, le même danger, un seul des deux protégé.
     */
    const safeSearch = sanitizeSearch(String(search ?? ''))

    if (safeSearch) {
      query = query.or(
        `user_email.ilike.%${safeSearch}%,entity_id.ilike.%${safeSearch}%,metadata::text.ilike.%${safeSearch}%`
      )
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
router.get('/stats', verifyToken, requirePlatformAdmin, async (req: Request, res: Response, next: NextFunction) => {
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
// La nomenclature des actions auditées : ce que le back-office met dans son
// filtre. Réservée à l'équipe, comme le journal qu'elle décrit — toute
// session, y compris anonyme, y avait accès.
router.get('/actions', verifyToken, requireTenantAdmin, (_req: Request, res: Response) => {
  res.json({
    actions: [
      'auth.login',
      'user.created',
      'user.invited',
      'report.status_changed',
      'report.deleted',
      'report.bulk_deleted',
      'report.service_notified',
      'service.acknowledged',
      'service.completed',
      'tenant.created',
      'tenant.status_changed',
      'tenant_config.updated',
      'tenant_categories.updated',
    ],
  })
})

// ─── GET /api/audit/tenants ─── Super Admin ─────────────────────
router.get('/tenants', verifyToken, requirePlatformAdmin, async (_req: Request, res: Response, next: NextFunction) => {
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
