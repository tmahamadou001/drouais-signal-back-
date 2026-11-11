import { Router, Request, Response, NextFunction } from 'express'
import type { Router as ExpressRouter } from 'express'
import { verifyToken, verifyTokenOptional } from '../middleware/auth.js'
import { voteLimiter, voteReadLimiter } from '../middleware/rateLimits.js'
import { upload } from '../middleware/upload.js'
import { AppError, badRequest } from '../middleware/errorHandler.js'
import { uploadPhoto } from '../lib/photoUpload.js'
import { claimResolution, readResolution, type ClaimKind } from '../services/resolutionService.js'

const router: ExpressRouter = Router()

/**
 * Les constats d'habitants, dans une commune sans mairie.
 *
 * Deux gestes symétriques — « c'est réparé », « c'est toujours là » — et une
 * seule route, parce que c'est le même geste avec la même preuve : on passe
 * devant, on regarde, on le dit. Les séparer ferait diverger leurs règles,
 * alors que la seule différence est le sens dans lequel le statut bascule.
 *
 * La photo est exigée pour déclarer une réparation et **pas** pour la
 * contester. Dire « c'est réparé » ferme un signalement : ça se prouve. Dire
 * « c'est toujours là » le rouvre, c'est-à-dire ne retire rien à personne — et
 * exiger une photo du problème qu'on vient déjà de photographier une fois
 * ajouterait un obstacle du mauvais côté.
 *
 * `voteLimiter` plutôt qu'un limiteur à part : c'est le même rythme humain, un
 * constat se fait en marchant.
 */

/**
 * Une coordonnée lue dans un formulaire, ou `null`.
 *
 * `multipart/form-data` ne transporte que des chaînes, et `Number()` en fait
 * deux choses dangereuses : `Number('ici')` vaut `NaN`, et **`NaN > 150` est
 * faux** — la vérification de distance laissait donc passer un constat déposé
 * de n'importe où ; `Number('')` vaut `0`, c'est-à-dire un point au large du
 * golfe de Guinée accepté comme une position valide.
 *
 * C'est la faille la plus discrète de ce dispositif : elle ne produit aucune
 * erreur, elle produit une fermeture de signalement.
 */
function coordinate(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Le même type de corps que le dépôt : une photo accompagne le constat. */
router.post(
  '/:id/resolution',
  verifyToken,
  voteLimiter,
  upload.single('photo'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      /**
       * Une session anonyme n'est pas un habitant.
       *
       * L'application se connecte anonymement pour que ses requêtes portent un
       * jeton vérifiable : c'est une preuve d'origine, pas une identité. Or
       * ces sessions s'obtiennent à volonté — et la règle du second constat
       * suppose **deux personnes**. Sans ce refus, il suffisait de deux
       * sessions pour fermer, seul, le signalement de n'importe qui, à
       * condition d'être devant.
       */
      if (req.isAnonymousUser) {
        throw new AppError(
          403,
          'account_required',
          'Constater une réparation demande un compte : c’est ce qui garantit qu’un constat vaut pour une personne.'
        )
      }

      const kind = String(req.body.kind ?? '') as ClaimKind

      if (kind !== 'repaired' && kind !== 'still_there') {
        throw badRequest('Nature du constat invalide.')
      }

      const lat = coordinate(req.body.lat)
      const lng = coordinate(req.body.lng)

      if (lat === null || lng === null) {
        throw badRequest('Votre position est nécessaire pour constater sur place.')
      }

      if (kind === 'repaired' && !req.file) {
        throw badRequest('Une photo est nécessaire pour déclarer un problème réparé.')
      }

      const photoUrl = req.file ? await uploadPhoto(req.file) : null

      const state = await claimResolution({
        reportId: req.params.id,
        userId: req.userId!,
        lat,
        lng,
        kind,
        photoUrl,
        tenantId: req.tenant?.id ?? null,
      })

      res.json(state)
    } catch (err) {
      next(err)
    }
  }
)

/**
 * L'état des constats.
 *
 * Ouvert sans compte : l'écran de détail affiche « 2 habitants ont constaté la
 * réparation » à tout le monde, et ne réserve que le bouton à qui est connecté.
 */
router.get(
  '/:id/resolution',
  verifyTokenOptional,
  voteReadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = await readResolution({
        reportId: req.params.id,
        userId: req.userId ?? null,
        tenantId: req.tenant?.id ?? null,
      })

      res.json(state)
    } catch (err) {
      next(err)
    }
  }
)

export default router
