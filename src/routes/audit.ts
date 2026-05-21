import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'
import { requireSuperAdmin } from '../middleware/roleGuard.js'

const router: ExpressRouter = Router()

/**
 * ═══════════════════════════════════════════════════════════════
 * ROUTES AUDIT LOGS
 * ═══════════════════════════════════════════════════════════════
 * Accessible uniquement par super admin et tenant admin (avec RLS)
 */

// ─── GET /api/audit/logs ─── Super Admin / Tenant Admin ────────
router.get('/logs', verifyToken, async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 100) // Max 100
    const offset = (page - 1) * limit

    // Filtres
    const tenantSlug = req.query.tenant as string | undefined
    const userEmail = req.query.user as string | undefined
    const action = req.query.action as string | undefined
    const search = req.query.search as string | undefined
    const startDate = req.query.startDate as string | undefined
    const endDate = req.query.endDate as string | undefined

    // Vérifier les permissions
    const userRole = (req as any).userRole
    const isSuperAdmin = userRole === 'super_admin'

    // Si pas super admin, vérifier qu'il est admin/agent d'un tenant
    if (!isSuperAdmin) {
      if (!req.tenant?.id) {
        return res.status(403).json({ error: 'Accès refusé' })
      }

      // Vérifier le rôle dans tenant_users
      const { data: tenantUser } = await supabaseAdmin
        .from('tenant_users')
        .select('role')
        .eq('user_id', req.userId!)
        .eq('tenant_id', req.tenant.id)
        .eq('is_active', true)
        .single()

      if (!tenantUser || (tenantUser.role !== 'admin' && tenantUser.role !== 'agent')) {
        return res.status(403).json({ error: 'Accès refusé' })
      }
    }

    // Construction de la requête
    let query = supabaseAdmin
      .from('audit_logs')
      .select('*', { count: 'exact' })

    // Filtres de sécurité : tenant admin ne voit que son tenant
    if (!isSuperAdmin && req.tenant?.id) {
      query = query.eq('tenant_id', req.tenant.id)
    }

    // Filtres utilisateur
    if (tenantSlug) {
      query = query.eq('tenant_slug', tenantSlug)
    }

    if (userEmail) {
      query = query.ilike('user_email', `%${userEmail}%`)
    }

    if (action) {
      query = query.eq('action', action)
    }

    if (search) {
      // Recherche dans user_email, entity_id, et metadata
      query = query.or(`user_email.ilike.%${search}%,entity_id.ilike.%${search}%,metadata::text.ilike.%${search}%`)
    }

    if (startDate) {
      query = query.gte('created_at', startDate)
    }

    if (endDate) {
      query = query.lte('created_at', endDate)
    }

    // Pagination et tri
    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    const { data, error, count } = await query

    if (error) {
      console.error('[Audit] Erreur récupération logs:', error)
      return res.status(500).json({ error: 'Erreur récupération logs' })
    }

    res.json({
      data: data || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    })
  } catch (err: any) {
    console.error('[Audit] Exception:', err)
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/audit/stats ─── Super Admin ───────────────────────
router.get('/stats', verifyToken, requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30

    // Statistiques globales
    const { count: totalLogs } = await supabaseAdmin
      .from('audit_logs')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString())

    // Actions par type
    const { data: actionStats } = await supabaseAdmin
      .from('audit_logs')
      .select('action')
      .gte('created_at', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString())

    const actionCounts: Record<string, number> = {}
    actionStats?.forEach((log: any) => {
      actionCounts[log.action] = (actionCounts[log.action] || 0) + 1
    })

    // Utilisateurs les plus actifs
    const { data: userStats } = await supabaseAdmin
      .from('audit_logs')
      .select('user_email')
      .gte('created_at', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString())
      .not('user_email', 'is', null)

    const userCounts: Record<string, number> = {}
    userStats?.forEach((log: any) => {
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
  } catch (err: any) {
    console.error('[Audit] Exception stats:', err)
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/audit/actions ─── Super Admin / Tenant Admin ──────
router.get('/actions', verifyToken, async (req: Request, res: Response) => {
  try {
    // Liste des actions disponibles (pour le filtre)
    const actions = [
      'user.created',
      'user.invited',
      'report.status_changed',
      'report.deleted',
      'report.bulk_deleted',
      'tenant.created',
      'tenant.status_changed',
      'tenant_config.updated',
      'tenant_categories.updated',
    ]

    res.json({ actions })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/audit/tenants ─── Super Admin ─────────────────────
router.get('/tenants', verifyToken, requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    // Liste des tenants (pour le filtre)
    const { data, error } = await supabaseAdmin
      .from('tenants')
      .select('slug, name')
      .order('name')

    if (error) throw error

    res.json({ tenants: data || [] })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

export default router
