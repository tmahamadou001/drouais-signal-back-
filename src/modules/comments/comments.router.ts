import { Router } from 'express'
import {
  getComments,
  createAgentComment,
  createCitizenComment,
  getUnreadCount,
} from './comments.handler.js'
import { verifyToken, verifyTokenOptional } from '../../middleware/auth.js'
import {
  requireAgent,
} from '../../middleware/roleGuard.js'
import { commentsLimiter } from '../../middleware/rateLimits.js'

const router: Router = Router({ mergeParams: true })
// mergeParams pour accéder à :reportId depuis le router parent

// GET /api/reports/:reportId/comments
// → Agents de la commune, et auteur du signalement
//
// `verifyTokenOptional` : l'auteur d'un signalement déposé sans compte n'a pas
// forcément de session. Il prouve son droit avec l'en-tête `X-Report-Token`,
// le jeton de suivi que le serveur lui a remis une fois à la création.
router.get(
  '/',
  verifyTokenOptional,
  getComments
)

// POST /api/reports/:reportId/comments/agent
// → Agents et admins. Répondre à un habitant est du traitement, pas du
//   réglage : c'est le geste quotidien d'un technicien terrain.
router.post(
  '/agent',
  verifyToken,
  requireAgent,
  commentsLimiter,
  createAgentComment
)

// POST /api/reports/:reportId/comments/citizen
// → Auteur du signalement, par son compte ou son jeton de suivi
router.post(
  '/citizen',
  verifyTokenOptional,
  commentsLimiter,
  createCitizenComment
)

export default router
