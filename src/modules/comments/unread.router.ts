import { Router } from 'express'
import { getUnreadCount } from './comments.handler.js'
import { verifyToken } from '../../middleware/auth.js'
import { requireTenantAdmin } from '../../middleware/roleGuard.js'

const router = Router()

// GET /api/comments/unread
// → Dashboard agent : compteur non lus
router.get(
  '/unread',
  verifyToken,
  requireTenantAdmin,
  getUnreadCount
)

export default router
