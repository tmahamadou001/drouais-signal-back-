import { Router } from 'express'
import { getUnreadCount, getMyUnreadCount } from './comments.handler.js'
import { verifyToken } from '../../middleware/auth.js'
import { requireTenantAdmin } from '../../middleware/roleGuard.js'

const router: Router = Router()

// GET /api/comments/unread
// → Dashboard agent : compteur non lus
router.get(
  '/unread',
  verifyToken,
  requireTenantAdmin,
  getUnreadCount
)

// GET /api/comments/unread/mine
// → Citoyen connecté : ses propres signalements uniquement
router.get(
  '/unread/mine',
  verifyToken,
  getMyUnreadCount
)

export default router
