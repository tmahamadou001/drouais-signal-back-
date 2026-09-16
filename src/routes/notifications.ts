import { Router, Request, Response, NextFunction, type Router as ExpressRouter } from 'express'
import { verifyToken } from '../middleware/auth.js'
import { badRequest } from '../middleware/errorHandler.js'
import {
  getPreferences,
  setPreferences,
  isOptedOut,
  optOut,
  optIn,
  emailFromUnsubscribeToken,
  type NotificationPreferences,
} from '../services/notificationPreferences.js'
import { getAuthUserEmail } from '../lib/authHelpers.js'

const router: ExpressRouter = Router()

const SWITCHES = ['email_status', 'email_comment', 'push_status', 'push_comment'] as const

/**
 * ─── GET /api/notifications/preferences ───
 *
 * La grille complète, plus l'état du désabonnement global. Les deux sont
 * distincts : une adresse désabonnée fait taire l'e-mail quelles que soient les
 * cases, et l'écran doit pouvoir le dire au lieu d'afficher des cases cochées
 * qui n'envoient rien.
 */
router.get('/preferences', verifyToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const preferences = await getPreferences(req.userId!)
    const email = await getAuthUserEmail(req.userId!)

    res.json({
      ...preferences,
      email,
      email_opted_out: email ? await isOptedOut(email) : false,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * ─── PATCH /api/notifications/preferences ───
 *
 * Les champs absents sont laissés tels quels, pour que quatre interrupteurs
 * puissent être manipulés indépendamment sans s'écraser.
 *
 * Recocher une case e-mail lève le désabonnement global : le citoyen vient de
 * demander cet e-mail, et le laisser muet en silence serait la pire réponse
 * possible à un geste explicite.
 */
router.patch('/preferences', verifyToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Record<string, unknown>
    const patch: Partial<NotificationPreferences> = {}

    for (const key of SWITCHES) {
      const value = body[key]
      if (value === undefined) continue
      if (typeof value !== 'boolean') throw badRequest(`${key} doit être un booléen.`)
      patch[key] = value
    }

    if (Object.keys(patch).length === 0) throw badRequest('Aucune préférence à modifier.')

    const preferences = await setPreferences(req.userId!, patch)

    if (patch.email_status === true || patch.email_comment === true) {
      const email = await getAuthUserEmail(req.userId!)
      if (email) await optIn(email)
    }

    res.json(preferences)
  } catch (err) {
    next(err)
  }
})

/**
 * ─── GET|POST /api/notifications/unsubscribe/:token ───
 *
 * Ce que désigne l'en-tête `List-Unsubscribe`. Public par construction : le
 * jeton signé *est* l'authentification, et un citoyen anonyme n'a pas de compte
 * avec quoi se connecter.
 *
 * Les deux verbes, pour deux appelants distincts :
 *
 *  - **POST** — Gmail et Yahoo, qui désabonnent en un clic sans ouvrir de
 *    navigateur (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`) ;
 *  - **GET** — l'humain qui clique le lien en pied d'e-mail, et à qui il faut
 *    une page.
 *
 * Un jeton invalide rend 400 sans rien dire de l'adresse : ce point d'entrée
 * ne doit pas devenir un oracle qui confirme qu'une adresse est chez nous.
 */
async function handleUnsubscribe(req: Request, res: Response, next: NextFunction) {
  try {
    const email = emailFromUnsubscribeToken(req.params.token ?? '')

    if (!email) {
      res.status(400).type('html').send(page('Lien invalide', 'Ce lien de désabonnement n’est plus valide.'))
      return
    }

    await optOut(email)
    console.log('[Désabonnement] Adresse retirée des envois')

    // Gmail n'affiche pas la réponse d'un POST en un clic ; 200 suffit.
    if (req.method === 'POST') {
      res.status(200).json({ unsubscribed: true })
      return
    }

    res.type('html').send(
      page(
        'Désabonnement pris en compte',
        `L’adresse ${escapeHtml(email)} ne recevra plus d’e-mail d’OnSignale.<br><br>` +
          'Les notifications dans l’application, elles, continuent — vous pouvez les régler depuis votre profil.'
      )
    )
  } catch (err) {
    next(err)
  }
}

router.get('/unsubscribe/:token', handleUnsubscribe)
router.post('/unsubscribe/:token', handleUnsubscribe)

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char
  )
}

/**
 * La page rendue au citoyen.
 *
 * Servie par l'API et non par le front : le front web est réservé à
 * l'administration depuis la v2, et faire dépendre un lien d'e-mail d'un
 * déploiement Vercel distinct est exactement ce qui a produit le 404 que cette
 * route corrige.
 */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — OnSignale</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #F7F8FA; color: #1F2933; padding: 24px; }
  main { max-width: 34rem; background: #fff; border: 1px solid #E4E7EB;
         border-radius: 16px; padding: 32px; }
  h1 { margin: 0 0 12px; font-size: 20px; }
  p  { margin: 0; color: #52606D; }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${body}</p></main></body>
</html>`
}

export default router
