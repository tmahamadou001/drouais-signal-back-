import { Router, type Request, type Response, NextFunction, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { findHandoff } from '../lib/serviceHandoff.js'
import { createAuditLog } from '../services/auditService.js'
import { AppError, badRequest } from '../middleware/errorHandler.js'
import { serviceHandoffLimiter } from '../middleware/rateLimits.js'
import { isFinal } from '../lib/statusFlow.js'

/**
 * Ce qu'un service extérieur peut faire, sans compte.
 *
 * Le jeton du lien reçu par e-mail tient lieu d'autorisation. Il vaut pour un
 * signalement, et n'ouvre que deux transitions : accuser la prise en charge, et
 * clôturer. Pas de liste, pas de recherche, pas de suppression, et aucune
 * donnée personnelle de l'habitant — ni son adresse e-mail, ni son compte.
 *
 * Chaque geste est écrit dans les logs d'audit avec l'adresse à laquelle le
 * lien avait été envoyé. C'est ce qui rend le dispositif défendable : on sait
 * toujours dans quelle boîte se trouvait le lien qui a été cliqué.
 */

const router: ExpressRouter = Router()

/** Le signalement, réduit à ce qu'un intervenant a besoin de savoir. */
const REPORT_FIELDS = 'id, reference, title, description, category, status, address_approx, lat, lng, photo_url, created_at'

function gone(reason: 'unknown' | 'expired'): AppError {
  return reason === 'expired'
    ? new AppError(410, 'handoff_expired', 'Ce lien a expiré. Contactez la mairie pour en recevoir un nouveau.')
    : new AppError(404, 'handoff_unknown', 'Ce lien n’est pas valide.')
}

// ─── GET /api/service/:token — le signalement confié ───
router.get('/:token', serviceHandoffLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lookup = await findHandoff(req.params.token)
    if (!lookup.ok) throw gone(lookup.reason)

    const { handoff } = lookup

    /**
     * Le signalement est lu **avec** la commune du lien.
     *
     * Elle est déjà celle du signalement par construction — le jeton a été créé
     * à partir de lui. Le filtre n'en est pas moins écrit : c'est la seule
     * route de la plateforme qui sert des données sans compte ni en-tête de
     * commune, et une isolation qui ne tient que par construction finit par
     * céder à la première requête qu'on ajoute au-dessus.
     */
    const [{ data: report }, { data: tenant }] = await Promise.all([
      supabaseAdmin
        .from('reports')
        .select(REPORT_FIELDS)
        .eq('id', handoff.report_id)
        .eq('tenant_id', handoff.tenant_id)
        .single(),
      supabaseAdmin.from('tenants').select('name').eq('id', handoff.tenant_id).single(),
    ])

    if (!report) throw gone('unknown')

    res.json({
      report,
      commune: tenant?.name ?? 'la commune',
      service: {
        name: handoff.service_name,
        category: handoff.category,
      },
      acknowledgedAt: handoff.acknowledged_at,
      completedAt: handoff.completed_at,
      expiresAt: handoff.expires_at,
      /**
       * Ce que la commune a fait du signalement depuis l'envoi du lien.
       *
       * `report.status` était déjà renvoyé et l'écran l'ignorait : un
       * signalement clôturé par un agent laissait le service devant deux
       * boutons, et son clic partait modifier un signalement déjà réglé. Le
       * jeton reste valable — ce n'est pas lui qui a changé — mais il n'ouvre
       * plus rien.
       */
      closedByCommune: isFinal(report.status) && !handoff.completed_at,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * Applique une transition au signalement.
 *
 * Passe par le même RPC atomique que le back-office, avec `p_agent_id` à
 * `null` : ce n'est pas un agent municipal, et le commentaire d'historique dit
 * qui a agi. Réutiliser le chemin des agents garantit que l'historique, les
 * notifications et les compteurs restent cohérents.
 */
async function applyTransition(params: {
  token: string
  next: 'pris_en_charge' | 'resolu'
  action: 'service.acknowledged' | 'service.completed'
  note?: string | null
  req: Request
}) {
  const lookup = await findHandoff(params.token)
  if (!lookup.ok) throw gone(lookup.reason)

  const { handoff } = lookup

  if (handoff.completed_at) {
    throw new AppError(409, 'already_completed', 'Ce signalement a déjà été clôturé.')
  }

  /**
   * La commune peut avoir clôturé de son côté entre-temps.
   *
   * Rien ne l'en empêche : elle est responsable du signalement, le lien ne lui
   * en retire pas la main. Mais le service ne doit pas pouvoir faire reculer
   * un statut terminal — c'est la même règle que pour le back-office, et elle
   * s'applique ici aussi, sinon la seule porte laissée ouverte serait celle
   * qu'on ne contrôle pas.
   */
  const { data: report } = await supabaseAdmin
    .from('reports')
    .select('status')
    .eq('id', handoff.report_id)
    .eq('tenant_id', handoff.tenant_id)
    .single()

  if (report && isFinal(report.status)) {
    throw new AppError(
      409,
      'already_closed',
      'Ce signalement a été clôturé par la commune. Aucune action n’est nécessaire.'
    )
  }

  const { error } = await supabaseAdmin.rpc('update_report_status_atomic', {
    p_report_id: handoff.report_id,
    p_new_status: params.next,
    p_agent_id: null,
    p_tenant_id: handoff.tenant_id,
    p_comment: params.note
      ? `${handoff.service_name ?? handoff.recipient} : ${params.note}`
      : `Via le lien de transmission (${handoff.service_name ?? handoff.recipient})`,
  })

  if (error) throw new AppError(500, 'internal_error', 'Impossible de mettre à jour le signalement.')

  const stamp = params.next === 'resolu'
    ? { completed_at: new Date().toISOString(), completion_note: params.note ?? null }
    : { acknowledged_at: new Date().toISOString() }

  await supabaseAdmin.from('service_handoffs').update(stamp).eq('id', handoff.id)

  createAuditLog({
    action: params.action,
    entityType: 'report',
    entityId: handoff.report_id,
    tenantId: handoff.tenant_id,
    // Pas de `userId` : personne n'est connecté. Le destinataire du lien est la
    // seule identité vérifiable, et c'est elle qui est tracée — dans
    // `user_email`, pour que la colonne UTILISATEUR des logs le montre.
    userEmail: handoff.recipient,
    userRole: 'service',
    metadata: {
      recipient: handoff.recipient,
      service_name: handoff.service_name,
      category: handoff.category,
      note: params.note ?? null,
    },
    ipAddress: params.req.ip,
    userAgent: params.req.get('user-agent'),
  }).catch((err) => console.error('[Handoff] Audit impossible :', err))

  return handoff
}

/**
 * La précision laissée par le service.
 *
 * Elle part dans `status_history.comment`, préfixée du nom du service — c'est
 * elle que le back-office affiche dans le journal du signalement. Facultative
 * des deux côtés : un service qui clique sans écrire dit déjà l'essentiel.
 */
function readNote(req: Request): string | null {
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null
  if (note !== null && note.length === 0) throw badRequest('Note vide.')
  return note
}

// ─── POST /api/service/:token/ack — « je m'en occupe » ───
router.post('/:token/ack', serviceHandoffLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // La note est acceptée ici aussi : « on passe jeudi » est exactement ce
    // qu'une commune veut savoir en prenant connaissance de l'accusé, et la
    // réserver à la clôture obligeait le service à attendre l'intervention
    // pour le dire.
    await applyTransition({
      token: req.params.token,
      next: 'pris_en_charge',
      action: 'service.acknowledged',
      note: readNote(req),
      req,
    })
    res.json({ status: 'pris_en_charge' })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/service/:token/done — « c'est fait » ───
router.post('/:token/done', serviceHandoffLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await applyTransition({
      token: req.params.token,
      next: 'resolu',
      action: 'service.completed',
      note: readNote(req),
      req,
    })
    res.json({ status: 'resolu' })
  } catch (err) {
    next(err)
  }
})

export default router
