import { Router } from 'express'
import {
  getComments,
  createAgentComment,
  createCitizenComment,
  getUnreadCount,
} from './comments.handler.js'
import { verifyToken } from '../../middleware/auth.js'
import {
  requireTenantAdmin,
} from '../../middleware/roleGuard.js'
import { commentsLimiter } from '../../middleware/rateLimits.js'

const router: Router = Router({ mergeParams: true })
// mergeParams pour accéder à :reportId depuis le router parent

// GET /api/reports/:reportId/comments
// → Accessible au citoyen auteur + agents
router.get(
  '/',
  verifyToken,
  getComments
)

// POST /api/reports/:reportId/comments/agent
// → Agents et admins uniquement
router.post(
  '/agent',
  verifyToken,
  requireTenantAdmin,
  commentsLimiter,
  createAgentComment
)

// POST /api/reports/:reportId/comments/citizen
// → Citoyen connecté uniquement
router.post(
  '/citizen',
  verifyToken,
  commentsLimiter,
  createCitizenComment
)

export default router
