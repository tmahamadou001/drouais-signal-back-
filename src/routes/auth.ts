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
  verifyLinkSchema,
} from '../schemas/auth.schema.js'
import { buildAccountLink, buildSignupLink, redeemAccountLink, consumeRedemption } from '../services/accountLinkService.js'
import { buildConfirmEmail } from '../templates/confirmEmail.js'
import { publicSiteUrl } from '../lib/tenantUrl.js'
import { deleteAccount } from '../services/accountDeletionService.js'

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
/**
 * Un mot de passe refusé se dit — contrairement à une adresse déjà prise.
 *
 * Supabase peut refuser un mot de passe qui figure dans le corpus de fuites de
 * *Have I Been Pwned* (réglage « Leaked Password Protection »), ou qui ne
 * satisfait pas les exigences du projet. Il répond alors `weak_password`.
 *
 * Sans ce tri, ce refus sortait déguisé : « Inscription impossible. Vérifiez
 * vos informations. » à l'inscription, et une **erreur 500** au choix du mot de
 * passe après invitation. Un agent qui vient de cliquer sur son invitation et
 * à qui l'écran répond « erreur serveur » retape le même mot de passe, obtient
 * la même erreur, et appelle la mairie : le blocage a l'air d'une panne.
 *
 * Le flou volontaire des routes d'authentification vise les **adresses** — les
 * distinguer ferait de ces routes un outil de vérification des comptes d'une
 * mairie. Un mot de passe refusé ne dit rien de l'existence d'un compte : il
 * n'y a rien à protéger en le taisant, et tout à perdre.
 */
function rejectWeakPassword(error: { code?: string } | null): void {
  if (error?.code !== 'weak_password') return

  throw new AppError(
    422,
    'weak_password',
    'Ce mot de passe est trop courant ou figure dans des fuites de données connues. Choisissez-en un autre.'
  )
}

/**
 * L'inscription, et l'e-mail qui la confirme — le nôtre.
 *
 * Cette route appelait `auth.signUp`, qui demande à **Supabase** d'envoyer
 * l'e-mail de confirmation. C'était le dernier envoi de la plateforme à
 * échapper à Resend : expéditeur inconnu de l'habitant, gabarit qui n'est pas
 * le nôtre, et un lien vers `<projet>.supabase.co` pour tout premier contact
 * avec le service. Voir `buildSignupLink` pour le remplacement.
 *
 * **La réponse ne dit jamais si l'adresse était déjà prise.** 202 dans les
 * deux cas : la distinction ferait de cette route un outil de vérification des
 * adresses, exactement ce que `login` refuse déjà. Ce qui diffère, c'est
 * l'e-mail — et lui ne part qu'à l'adresse concernée, donc ne révèle rien.
 */
router.post('/register', authLimiter, validate(registerSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, firstName } = req.body

    const link = await buildSignupLink({ email, password, firstName })

    if (!link.ok) {
      // Un mot de passe refusé se dit : il ne renseigne sur l'existence
      // d'aucun compte, et le taire transforme un refus en panne apparente.
      rejectWeakPassword({ code: link.reason })

      if (link.reason === 'error') {
        console.error('[Auth] Inscription impossible :', link.message)
        throw new AppError(400, 'signup_failed', 'Inscription impossible. Vérifiez vos informations.')
      }
    }

    /**
     * L'e-mail part **après** la réponse décidée, et son échec ne la change
     * pas : un compte créé dont l'e-mail n'est pas parti se rattrape par
     * « mot de passe oublié », alors qu'un 500 laisserait l'habitant croire
     * que rien n'a eu lieu et le ferait recommencer — sur une adresse
     * désormais prise.
     */
    sendConfirmEmail({
      email,
      firstName,
      actionLink: link.ok ? link.url : null,
    }).catch((err) => console.error('[Auth] E-mail de confirmation non envoyé :', err))

    // Pas de session tant que le lien n'est pas suivi : le client doit le dire
    // plutôt que d'attendre un jeton qui ne viendra pas.
    res.status(202).json({ pending: 'email_confirmation' })
  } catch (err) {
    next(err)
  }
})

/** L'envoi lui-même, isolé pour que la route reste lisible et testable. */
async function sendConfirmEmail(params: {
  email: string
  firstName?: string | null
  actionLink: string | null
}): Promise<void> {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[Auth] RESEND_API_KEY absente : aucun e-mail de confirmation envoyé.')
    return
  }

  const { html, text } = buildConfirmEmail({
    recipientEmail: params.email,
    firstName: params.firstName,
    actionLink: params.actionLink,
    // La page d'accueil du site, et non `/confirmation` : il n'y a rien à
    // confirmer dans ce cas, et c'est de là que partent les liens vers les
    // applications. Un citoyen se connecte dans l'app, pas dans un back-office.
    loginUrl: publicSiteUrl(),
  })

  const resend = new Resend(process.env.RESEND_API_KEY)

  await resend.emails.send({
    // `EMAIL_FROM` est une adresse nue partout dans ce dépôt, jamais un
    // en-tête complet : le nom d'affichage s'ajoute ici, comme ailleurs.
    from: `OnSignale <${process.env.EMAIL_FROM ?? 'notifications@onsignale.fr'}>`,
    to: params.email,
    subject: plainSubject(
      params.actionLink ? 'Confirmez votre adresse e-mail' : 'Vous avez déjà un compte OnSignale'
    ),
    html,
    text,
  })
}

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

// ─── POST /api/auth/verify-link ────────────────────────────
/**
 * Échange le jeton d'un lien d'invitation ou de réinitialisation.
 *
 * C'est ce qui permet au lien reçu par e-mail d'être **le nôtre**. Avant, il
 * pointait sur `https://<projet>.supabase.co/auth/v1/verify?token=…` : le nom
 * de notre fournisseur d'authentification dans la boîte mail d'un agent
 * municipal, une adresse qu'il ne peut pas reconnaître comme légitime, et une
 * dépendance gravée dans des e-mails qu'on ne pourra jamais reprendre.
 *
 * Publique par nécessité — celui qui l'appelle n'a pas encore de session,
 * c'est tout l'objet de l'appel. Le jeton en est la seule preuve ; il est à
 * usage unique, daté, et `authLimiter` borne les tentatives.
 */
router.post('/verify-link', authLimiter, validate(verifyLinkSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, type } = req.body

    const session = await redeemAccountLink({ token, type })

    res.json({ access_token: session.accessToken, email: session.email })
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

    /**
     * Une session seule ne suffit plus.
     *
     * La route n'exigeait qu'un jeton d'accès valide : tout porteur d'une
     * session posait un mot de passe sans connaître l'ancien et sans venir
     * d'un lien. Un jeton recopié sur un poste partagé devenait une prise de
     * contrôle définitive, et la déconnexion globale n'y pouvait plus rien —
     * l'attaquant avait le mot de passe.
     *
     * Le droit vient de ce qui précède : avoir échangé un lien d'invitation ou
     * de réinitialisation dans les quinze dernières minutes
     * (`accountLinkService`). C'est précisément le parcours de l'écran
     * `/set-password`, et rien d'autre ne mène ici.
     *
     * Une session anonyme n'y a jamais droit : elle ne désigne personne, et
     * poser un mot de passe dessus fabriquerait un compte fantôme.
     */
    if (req.isAnonymousUser || !consumeRedemption(req.userId!)) {
      throw new AppError(
        403,
        'link_required',
        'Pour définir un mot de passe, passez par le lien reçu par e-mail. Demandez-en un nouveau si le vôtre a expiré.'
      )
    }

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(req.userId!, {
      password,
    })

    if (updateError) {
      rejectWeakPassword(updateError)

      console.error('[SetPassword] Erreur mise à jour:', updateError)
      throw new AppError(500, 'internal_error', 'Erreur lors de la mise à jour du mot de passe.')
    }

    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ─── DELETE /api/auth/account ──────────────────────────────
/**
 * Supprimer son compte, depuis l'application.
 *
 * Apple exige que la suppression soit initiable depuis l'app ; au-delà de la
 * règle, demander d'écrire un e-mail pour disparaître est une friction qu'on
 * n'imposerait pas pour s'inscrire.
 *
 * Ce qui part et ce qui reste est décrit par `accountDeletionService`, et dit
 * publiquement sur `/supprimer-mes-donnees`. Une session anonyme n'a rien à
 * supprimer : elle ne désigne personne et disparaît avec l'installation.
 */
router.delete('/account', verifyToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isAnonymousUser) {
      throw new AppError(
        403,
        'account_required',
        'Cette session n’est rattachée à aucun compte : il n’y a rien à supprimer.'
      )
    }

    const outcome = await deleteAccount(req.userId!)

    createAuditLog({
      userId: req.userId,
      action: 'user.deleted',
      entityType: 'user',
      entityId: req.userId!,
      metadata: { ...outcome },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('[Audit] Erreur:', err))

    res.json({ success: true, ...outcome })
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

    // Le lien de réinitialisation — le nôtre, sur le sous-domaine de la
    // commune, et échangé par l'API : voir `accountLinkService`. Une adresse
    // inconnue ne produit aucun lien, et on l'ignore volontairement pour ne
    // pas révéler qui a un compte.
    const link = await buildAccountLink({
      type: 'recovery',
      email,
      tenantSlug: req.tenant?.slug ?? null,
    })

    if (link) {
      // Récupère le prénom si l'utilisateur est dans tenant_users
      let firstName: string | null = null
      if (link.userId && req.tenant?.id) {
        const { data: member } = await supabaseAdmin
          .from('tenant_users')
          .select('first_name')
          .eq('user_id', link.userId)
          .eq('tenant_id', req.tenant.id)
          .single()
        firstName = member?.first_name ?? null
      }

      const resend = new Resend(process.env.RESEND_API_KEY)
      const { html, text } = buildResetEmail({
        recipientEmail: email,
        firstName,
        cityName,
        actionLink: link.url,
      })

      await resend.emails.send({
        from: `OnSignale <${process.env.EMAIL_FROM ?? 'notifications@onsignale.fr'}>`,
        to: email,
        subject: plainSubject(`Réinitialisation de votre mot de passe — OnSignale`),
        html,
        text,
      }).catch(err => console.error('[ForgotPassword] Erreur envoi email:', err))
    }

    // Toujours renvoyer 200 — pas de fuite sur l'existence du compte
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

export default router
