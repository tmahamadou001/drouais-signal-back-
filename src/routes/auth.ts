import { Router, type Request, type Response, NextFunction, type Router as ExpressRouter } from 'express'
import { Resend } from 'resend'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'
import { AppError, badRequest } from '../middleware/errorHandler.js'
import { buildResetEmail } from '../templates/inviteNotification.js'

const router: ExpressRouter = Router()

// ─── POST /api/auth/set-password ───────────────────────────
// Appelé depuis /set-password après invitation.
// Le front envoie le token dans Authorization: Bearer — verifyToken
// le valide via supabaseAdmin.auth.getUser() et attache req.userId.
router.post('/set-password', verifyToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { password } = req.body

    if (!password || typeof password !== 'string' || password.length < 8) {
      throw badRequest('Le mot de passe doit contenir au moins 8 caractères.')
    }

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(req.userId!, {
      password,
    })

    if (updateError) {
      console.error('[SetPassword] Erreur mise à jour:', updateError)
      throw new AppError(500, 'internal_error', 'Erreur lors de la mise à jour du mot de passe.')
    }

    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/auth/forgot-password ───────────────────────
// Public. Génère un lien de reset via Supabase admin et l'envoie via Resend.
// Retourne toujours 200 pour éviter l'énumération d'emails.
router.post('/forgot-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body
    if (!email || typeof email !== 'string') {
      throw badRequest('Email requis.')
    }

    const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:5173'

    // Récupère le city_name du tenant si présent (pour personnaliser l'email)
    let cityName: string | null = null
    if (req.tenant?.id) {
      const { data } = await supabaseAdmin
        .from('tenant_configs')
        .select('city_name')
        .eq('tenant_id', req.tenant.id)
        .single()
      cityName = data?.city_name ?? null
    }

    // Génère le lien de reset — si l'email n'existe pas, Supabase retourne une erreur
    // qu'on ignore volontairement (pas de fuite d'info)
    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: {
        redirectTo: `${clientUrl}/set-password`,
      },
    })

    if (!linkError && linkData?.properties?.action_link) {
      // Récupère le prénom si l'utilisateur est dans tenant_users
      let firstName: string | null = null
      if (linkData.user?.id && req.tenant?.id) {
        const { data: member } = await supabaseAdmin
          .from('tenant_users')
          .select('first_name')
          .eq('user_id', linkData.user.id)
          .eq('tenant_id', req.tenant.id)
          .single()
        firstName = member?.first_name ?? null
      }

      const resend = new Resend(process.env.RESEND_API_KEY)
      const { html, text } = buildResetEmail({
        recipientEmail: email,
        firstName,
        cityName,
        actionLink: linkData.properties.action_link,
      })

      await resend.emails.send({
        from: `OnSignale <${process.env.EMAIL_FROM ?? 'notifications@onsignale.fr'}>`,
        to: email,
        subject: `Réinitialisation de votre mot de passe — OnSignale`,
        html,
        text,
      }).catch(err => console.error('[ForgotPassword] Erreur envoi email:', err))
    } else if (linkError) {
      console.error('[ForgotPassword] generateLink error (non-fatal):', linkError.message)
    }

    // Toujours renvoyer 200 — pas de fuite sur l'existence du compte
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

export default router
