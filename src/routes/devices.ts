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
 * ─── GET /api/devices/preferences — What this citizen agreed to receive ───
 *
 * Answers for the account rather than for one install: the switches live on the
 * profile screen, which is account-scoped, so a citizen who silences status
 * updates on their phone expects their tablet to fall silent too.
 *
 * Defaults to both on when no device is registered yet — that is what a fresh
 * install will get, and showing the switches off would misdescribe it.
 */
router.get('/preferences', verifyToken, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('device_tokens')
      .select('notify_status, notify_comment')
      .eq('user_id', req.userId!)
      .eq('tenant_id', req.tenant!.id)
      .limit(1)
      .maybeSingle()

    if (error) throw error

    res.json({
      notify_status: data?.notify_status ?? true,
      notify_comment: data?.notify_comment ?? true,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * ─── PATCH /api/devices/preferences — Change what gets sent ───
 *
 * Applied to every one of the caller's devices in this commune, for the same
 * reason the read is account-scoped. Absent fields are left alone, so the two
 * switches can be flipped independently without either overwriting the other.
 */
router.patch('/preferences', verifyToken, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as { notify_status?: unknown; notify_comment?: unknown }
    const patch: Record<string, boolean> = {}

    for (const key of ['notify_status', 'notify_comment'] as const) {
      const value = body[key]
      if (value === undefined) continue
      if (typeof value !== 'boolean') throw badRequest(`${key} doit être un booléen.`)
      patch[key] = value
    }

    if (Object.keys(patch).length === 0) {
      throw badRequest('Aucune préférence à modifier.')
    }

    const { error } = await supabaseAdmin
      .from('device_tokens')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('user_id', req.userId!)
      .eq('tenant_id', req.tenant!.id)

    if (error) throw error

    // No row yet simply means push has not been registered on this device;
    // the preference is stored the moment it is, from the defaults.
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
