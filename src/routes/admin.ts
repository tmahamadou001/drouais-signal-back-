import { Router, Request, Response, NextFunction, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'
import { requireTenantAdmin, requireTeamMember } from '../middleware/roleGuard.js'
import { resolveCategories } from '../services/categoryService.js'

/** Le délai par défaut de `tenant_categories`, quand la commune n'en a fixé aucun. */
const DEFAULT_SLA_HOURS = 168

const router: ExpressRouter = Router()

/**
 * ─── GET /api/admin/stats — Les quatre compteurs de l'écran d'accueil ───
 *
 * Chaque compteur porte une mention de contexte, et c'est elle qui fait le
 * travail : « 21 en attente » ne dit pas s'il faut s'inquiéter, « dont 7 en
 * retard » si. Elles sont donc calculées ici plutôt que devinées côté client.
 *
 * « En retard » se lit sur le délai de la catégorie (`sla_hours`), pas sur un
 * seuil unique : une fuite d'eau et un tag n'ont pas la même urgence, et c'est
 * précisément ce que la commune règle dans ses paramètres.
 */
/**
 * Ces compteurs n'avaient **aucun garde** : ni jeton, ni rôle.
 *
 * Montés sous `/api/admin`, ils n'héritaient que de `requireTenant` et du
 * ralentisseur — n'importe qui pouvait lire, pour n'importe quelle commune, son
 * nombre de signalements en retard et son taux de résolution. La carte publique
 * expose les signalements, pas l'agrégat de ce que la mairie n'a pas encore
 * traité : c'est une information qu'une commune choisit de publier, ou pas.
 */
router.get('/stats', verifyToken, requireTeamMember, async (req: Request, res: Response, next: NextFunction) => {
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

    const now = new Date()
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

    const countSince = (column: 'created_at' | 'updated_at', since: string, status?: string) => {
      let q = supabaseAdmin
        .from('reports')
        .select('*', { count: 'exact', head: true })
        .gte(column, since)
      if (tenantId) q = q.eq('tenant_id', tenantId)
      if (status)   q = q.eq('status', status)
      return q
    }

    // Les signalements encore ouverts, avec ce qu'il faut pour juger du retard.
    let openQuery = supabaseAdmin
      .from('reports')
      .select('category, created_at')
      .neq('status', 'resolu')
    if (tenantId) openQuery = openQuery.eq('tenant_id', tenantId)

    const [total, enAttente, transmis, prisEnCharge, resolu, newThisWeek, resolvedThisMonth, open, categories] =
      await Promise.all([
        buildCount(),
        buildCount('en_attente'),
        buildCount('transmis'),
        buildCount('pris_en_charge'),
        buildCount('resolu'),
        countSince('created_at', weekAgo),
        countSince('updated_at', monthStart, 'resolu'),
        openQuery,
        resolveCategories(tenantId),
      ])

    if (total.error) throw total.error

    const slaByCategory = new Map(categories.map((category) => [category.slug, category.sla_hours]))

    const overdue = (open.data ?? []).filter((report) => {
      const sla = slaByCategory.get(report.category) ?? DEFAULT_SLA_HOURS
      return Date.parse(report.created_at) + sla * 3600_000 < now.getTime()
    }).length

    res.json({
      total:          total.count        ?? 0,
      en_attente:     enAttente.count    ?? 0,
      /** Transmis à un service extérieur, sans réponse de sa part (migration 034). */
      transmis:       transmis.count     ?? 0,
      pris_en_charge: prisEnCharge.count ?? 0,
      resolu:         resolu.count       ?? 0,
      /** Contexte affiché sous chaque compteur. */
      new_this_week:       newThisWeek.count       ?? 0,
      resolved_this_month: resolvedThisMonth.count ?? 0,
      overdue,
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/admin/performance — SLA & performance metrics (via SQL RPC) ───
router.get('/performance', verifyToken, requireTeamMember, async (req: Request, res: Response, next: NextFunction) => {
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
