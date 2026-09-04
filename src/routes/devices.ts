import { Router, Request, Response, NextFunction, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'
import { requireTenant } from '../middleware/tenantResolver.js'
import { badRequest } from '../middleware/errorHandler.js'

const router: ExpressRouter = Router()

/** Expo issues one of these per install: `ExponentPushToken[…]`. */
const EXPO_TOKEN = /^ExponentPushToken\[[^\]]+\]$/

/**
 * ─── POST /api/devices — Register this install for push ───
 *
 * Upserted on the token, which is the natural key: Expo mints a distinct one
 * per install, and re-registering on every launch is how the app copes with a
 * token that rotated. The row moves to whoever signed in last on that device —
 * two people sharing a phone must not receive each other's notifications.
 */
router.post('/', verifyToken, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, platform } = req.body as { token?: string; platform?: string }

    if (!token || !EXPO_TOKEN.test(token)) {
      throw badRequest('Token de notification invalide.')
    }

    if (platform && platform !== 'ios' && platform !== 'android') {
      throw badRequest('Plateforme invalide.')
    }

    const { error } = await supabaseAdmin.from('device_tokens').upsert(
      {
        token,
        user_id: req.userId!,
        tenant_id: req.tenant!.id,
        platform: platform ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'token' }
    )

    if (error) throw error

    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

/**
 * ─── DELETE /api/devices/:token — Stop pushing to this install ───
 *
 * Called on sign-out. Scoped to the caller so one account cannot unregister
 * another's device by guessing a token.
 */
router.delete('/:token', verifyToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { error } = await supabaseAdmin
      .from('device_tokens')
      .delete()
      .eq('token', req.params.token)
      .eq('user_id', req.userId!)

    if (error) throw error

    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

export default router
