import { Router, Request, Response, NextFunction } from 'express'
import type { Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'
import { voteLimiter, voteReadLimiter } from '../middleware/rateLimits.js'
import { AppError, notFound, badRequest } from '../middleware/errorHandler.js'

const router: ExpressRouter = Router()

/**
 * Les confirmations sur place.
 *
 * Ce qui s'appelait un vote était un geste sans contenu vérifiable : n'importe
 * qui, de n'importe où, faisait monter un compteur dont l'agent qui trie sa
 * file ne pouvait rien conclure. Le geste n'est désormais proposé qu'au citoyen
 * qui vient de photographier le même problème, et le serveur vérifie qu'il se
 * trouve à côté.
 *
 * Trois conséquences assumées :
 *
 *  - **plus de bouton « Je signale aussi » depuis le canapé.** `POST /vote` et
 *    `DELETE /vote` ont disparu : le seul chemin vers le compteur passe par
 *    l'écran de doublon, donc par une photo et une position ;
 *  - **une confirmation ne se retire pas.** Ce n'est pas un avis qu'on change,
 *    c'est un constat daté. Un citoyen qui s'est trompé de signalement crée le
 *    sien, ce que l'écran propose juste à côté ;
 *  - **la preuve est conservée**, pas seulement contrôlée — voir la migration 029.
 */

/**
 * Le rayon dans lequel une confirmation est acceptée.
 *
 * La recherche de doublons travaille à 80 m ; on accepte plus large ici, parce
 * que ce n'est pas la même mesure. Là-bas il s'agit de proposer, ici de refuser
 * — et refuser à tort la confirmation d'un citoyen réellement sur place, parce
 * que son GPS dérive de 60 m entre deux immeubles, serait le pire des deux
 * côtés. 150 m reste très en deçà de ce qu'un canapé permet.
 */
const MAX_CONFIRMATION_DISTANCE_M = 150

/** Distance à vol d'oiseau, en mètres. */
export function distanceMeters(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): number {
  const R = 6_371_000
  const toRadians = (value: number) => (value * Math.PI) / 180

  const dLat = toRadians(toLat - fromLat)
  const dLng = toRadians(toLng - fromLng)

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(dLng / 2) ** 2

  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

// ─── POST /api/reports/:id/confirm ───────────────────────────────────────────

router.post('/:id/confirm', verifyToken, voteLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reportId = req.params.id
    const { lat, lng } = req.body as { lat?: unknown; lng?: unknown }

    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw badRequest('Votre position est nécessaire pour confirmer un signalement.')
    }

    let reportQuery = supabaseAdmin
      .from('reports')
      .select('id, status, vote_count, lat, lng')
      .eq('id', reportId)
    if (req.tenant?.id) reportQuery = reportQuery.eq('tenant_id', req.tenant.id)

    const { data: report, error: reportError } = await reportQuery.single()

    if (reportError || !report) throw notFound('Signalement')

    if (report.status === 'resolu') {
      throw badRequest('Ce signalement est résolu : il n’y a plus rien à confirmer.')
    }

    const distance = distanceMeters(lat, lng, report.lat, report.lng)

    if (distance > MAX_CONFIRMATION_DISTANCE_M) {
      throw new AppError(
        400,
        'too_far',
        'Vous êtes trop loin de ce signalement pour le confirmer.'
      )
    }

    const { error: insertError } = await supabaseAdmin.from('votes').insert({
      report_id: reportId,
      user_id: req.userId!,
      tenant_id: req.tenant?.id ?? null,
      confirmed_lat: lat,
      confirmed_lng: lng,
      confirmed_distance_m: distance,
    })

    if (insertError) {
      if (insertError.code === '23505') {
        throw new AppError(
          409,
          'already_confirmed',
          'Vous avez déjà confirmé ce signalement.'
        )
      }
      throw insertError
    }

    // Le trigger `update_vote_count()` maintient le compteur ; on rend la valeur
    // attendue plutôt que de relire, pour que l'écran puisse l'afficher tout de suite.
    return res.json({ confirmation_count: (report.vote_count ?? 0) + 1, distance_meters: distance })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/reports/:id/my-confirmation ────────────────────────────────────

router.get('/:id/my-confirmation', verifyToken, voteReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await supabaseAdmin
      .from('votes')
      .select('id')
      .eq('report_id', req.params.id)
      .eq('user_id', req.userId!)
      .maybeSingle()

    return res.json({ has_confirmed: !!data })
  } catch (err) {
    next(err)
  }
})

export default router
