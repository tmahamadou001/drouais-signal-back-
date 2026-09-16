import { plainSubject } from '../templates/brand.js'
import { Router, type Request, type Response, NextFunction, type Router as ExpressRouter } from 'express'
import { Resend } from 'resend'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { createCredentialsClient } from '../lib/supabaseAuthClient.js'
import { verifyToken } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { buildResetEmail } from '../templates/inviteNotification.js'
import { validate } from '../middleware/validate.js'
import { authLimiter } from '../middleware/rateLimits.js'
import { buildAuthPayload, resolveRole } from '../lib/sessionPayload.js'
import { createAuditLog } from '../services/auditService.js'
import {
  loginSchema,
  registerSchema,
  forgotPasswordSchema,
  setPasswordSchema,
} from '../schemas/auth.schema.js'

const router: ExpressRouter = Router()

/**
 * L'authentification passe par l'API, plus par Supabase depuis le navigateur.
 *
 * Le client appelait `supabase.auth.signInWithPassword` directement. Ça
 * marchait, mais tout ce qui entoure une connexion échappait au serveur : pas
 * de limitation de débit sur les identifiants, pas de validation de la charge
 * utile, aucune trace dans les logs d'audit, et un second appel pour apprendre
 * le rôle — l'application connaissait donc l'utilisateur avant de savoir ce
 * qu'il avait le droit de faire.
 *
 * Le jeton rendu reste celui de Supabase : le client le confie au SDK, qui
 * continue d'assurer le rafraîchissement et la persistance. Réécrire cette
 * mécanique serait le meilleur moyen d'y introduire des bogues, pour aucun gain.
 */

// ─── POST /api/auth/login ───────────────────────────────────
router.post('/login', authLimiter, validate(loginSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body

    // Client jetable : une session posée sur `supabaseAdmin` ferait perdre le
    // contournement du RLS à tout le processus. Voir `supabaseAuthClient.ts`.
    const { data, error } = await createCredentialsClient().auth.signInWithPassword({ email, password })

    /**
     * Une seule réponse pour « adresse inconnue » et « mot de passe faux ».
     *
     * Les distinguer transformerait cet endpoint en outil de vérification des
     * adresses employées par une mairie. Supabase le fait déjà ; on ne le
     * défait pas en relayant son message d'origine.
     */
    if (error || !data.session || !data.user) {
      throw new AppError(401, 'invalid_credentials', 'Adresse e-mail ou mot de passe incorrect.')
    }

    const payload = await buildAuthPayload(data.user, data.session, req.tenant?.id)

    createAuditLog({
      userId: data.user.id,
      userEmail: data.user.email ?? undefined,
      userRole: payload.user.role,
      action: 'auth.login',
      entityType: 'user',
      entityId: data.user.id,
      tenantId: req.tenant?.id,
      tenantSlug: req.tenant?.slug,
      metadata: { method: 'password' },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('[Auth] Audit impossible :', err))

    res.json(payload)
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/auth/register ────────────────────────────────
router.post('/register', authLimiter, validate(registerSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, firstName } = req.body

    const { data, error } = await createCredentialsClient().auth.signUp({
      email,
      password,
      options: { data: { first_name: firstName ?? '' } },
    })

    if (error) {
      // Une adresse déjà prise ne se dit pas : ce serait la même fuite que
      // ci-dessus, par une autre porte. Supabase rend d'ailleurs un utilisateur
      // sans identité dans ce cas, plutôt qu'une erreur.
      throw new AppError(400, 'signup_failed', 'Inscription impossible. Vérifiez vos informations.')
    }

    // Confirmation d'e-mail activée : pas de session tant que le lien n'est pas
    // suivi. Le client doit le dire plutôt que d'attendre un jeton qui ne
    // viendra pas.
    if (!data.session || !data.user) {
      res.status(202).json({ pending: 'email_confirmation' })
      return
    }

    res.status(201).json(await buildAuthPayload(data.user, data.session, req.tenant?.id))
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/auth/session ──────────────────────────────────
// Qui suis-je, et qu'ai-je le droit de faire dans cette commune.
router.get('/session', verifyToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await supabaseAdmin.auth.getUser(
      req.headers.authorization?.replace('Bearer ', '') ?? ''
    )

    if (!data.user) throw new AppError(401, 'unauthorized', 'Session expirée.')

    res.json({
      user: {
        id: data.user.id,
        email: data.user.email ?? null,
        role: await resolveRole(data.user, req.tenant?.id),
        isAnonymous: data.user.is_anonymous === true,
      },
    })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/auth/logout ──────────────────────────────────
router.post('/logout', verifyToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    /**
     * Révoque la session côté serveur, et pas seulement dans le navigateur.
     *
     * Effacer le stockage local laissait le jeton de rafraîchissement valide :
     * quiconque l'avait recopié pouvait continuer à obtenir des jetons d'accès
     * longtemps après la « déconnexion ». C'est le genre de détail qu'on ne
     * peut corriger que depuis le serveur.
     */
    const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
    const { error } = await supabaseAdmin.auth.admin.signOut(token, 'global')

    // Un jeton déjà expiré n'est pas une erreur : le résultat voulu est atteint.
    if (error) console.warn('[Auth] Révocation partielle :', error.message)

    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/auth/set-password ───────────────────────────
// Appelé depuis /set-password après invitation.
// Le front envoie le token dans Authorization: Bearer — verifyToken
// le valide via supabaseAdmin.auth.getUser() et attache req.userId.
router.post('/set-password', verifyToken, validate(setPasswordSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { password } = req.body

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
router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body

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
        subject: plainSubject(`Réinitialisation de votre mot de passe — OnSignale`),
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
