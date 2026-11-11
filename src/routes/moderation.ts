import { Router, Request, Response, NextFunction } from 'express'
import type { Router as ExpressRouter } from 'express'
import { verifyToken } from '../middleware/auth.js'
import { requireSuperAdmin } from '../middleware/roleGuard.js'
import { badRequest } from '../middleware/errorHandler.js'
import { createAuditLog } from '../services/auditService.js'
import {
  listModerationQueue,
  retractReport,
  restoreReport,
  removeReportPhoto,
} from '../services/moderationService.js'

const router: ExpressRouter = Router()

/**
 * La modération des communes ouvertes au public sans mairie.
 *
 * Hors de `/api/reports`, et pour une raison qui n'est pas de rangement : ces
 * routes travaillent **en travers des communes**, alors que tout ce qui est
 * monté sous `/api/reports` passe par `requireTenant` et ne voit qu'une commune
 * à la fois. Modérer depuis le sous-domaine de chaque commune aurait voulu dire
 * les visiter une par une pour découvrir ce qui vient d'y être publié.
 *
 * Super-administrateur uniquement. C'est le pendant de la décision d'ouvrir une
 * commune : nous publions sans elle, donc nous répondons de ce qui est publié.
 */

const MAX_LIMIT = 100

router.use(verifyToken, requireSuperAdmin)

router.get('/reports', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, MAX_LIMIT)
    const page = Math.max(Number(req.query.page) || 1, 1)

    const { data, total } = await listModerationQueue({ limit, page })

    res.json({ data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } })
  } catch (err) {
    next(err)
  }
})

/**
 * Le motif est obligatoire.
 *
 * Un retrait sans motif est incontestable, donc inaudit : six mois plus tard,
 * personne — ni nous, ni la mairie, ni l'habitant qui réclame — ne peut dire
 * pourquoi son signalement a disparu. Il est court, il est libre, et il est
 * écrit dans le journal.
 */
function reasonFrom(body: unknown): string {
  const reason = (body as { reason?: unknown })?.reason

  if (typeof reason !== 'string' || reason.trim().length < 3) {
    throw badRequest('Un motif est nécessaire : il sera conservé dans le journal d’audit.')
  }

  return reason.trim().slice(0, 500)
}

/** Les trois gestes partagent leur forme : agir, puis écrire ce qu'on a fait. */
function moderationRoute(
  path: string,
  action: 'report.retracted' | 'report.restored' | 'report.photo_removed',
  run: (reportId: string) => Promise<{ title: string; tenantId: string; tenantSlug: string }>
) {
  router.post(path, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reason = reasonFrom(req.body)
      const outcome = await run(req.params.id)

      await createAuditLog({
        userId: req.userId,
        action,
        entityType: 'report',
        entityId: req.params.id,
        tenantId: outcome.tenantId,
        tenantSlug: outcome.tenantSlug,
        metadata: { report_title: outcome.title, reason },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      })

      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  })
}

moderationRoute('/reports/:id/retract', 'report.retracted', retractReport)
moderationRoute('/reports/:id/restore', 'report.restored', restoreReport)
moderationRoute('/reports/:id/photo', 'report.photo_removed', removeReportPhoto)

export default router
