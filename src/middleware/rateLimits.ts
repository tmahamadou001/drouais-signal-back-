import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import type { Request } from 'express'
import { sharedStore } from '../lib/rateLimitStore.js'

/*
 * Chaque limiteur compte dans son propre espace, partagé entre les instances.
 *
 * En mémoire par défaut — donc **par processus**, ce qui multiplie chaque
 * plafond par le nombre d'instances et le remet à zéro à chaque déploiement.
 * Avec `REDIS_URL`, le comptage est partagé et le plafond devient celui qu'on
 * a écrit. Voir `lib/rateLimitStore.ts`.
 */

/**
 * Rate-limit key: the signed-in user when there is one, otherwise the IP.
 *
 * Keying on IP alone was fine while the only client was a browser on a home or
 * office connection. It is not fine for the mobile app: a carrier NAT puts
 * hundreds of unrelated subscribers behind one address, so the third person in
 * a town to open the app inherits the first two's budget and is told to come
 * back in fifteen minutes.
 *
 * A verified `userId` is a far better bucket — including for the app's
 * anonymous sign-ins, which get one identity per install. The IP fallback still
 * covers genuinely token-less callers, and `ipKeyGenerator` is what normalises
 * IPv6 into a /64 subnet rather than letting one client rotate through
 * addresses it was handed for free.
 */
function userOrIpKey(req: Request): string {
  return req.userId ? `u:${req.userId}` : `ip:${ipKeyGenerator(req.ip ?? '')}`
}


/**
 * Coarse backstop against a flood, and nothing finer.
 *
 * It is mounted on `/api/` ahead of every auth middleware, so it cannot key on
 * a user — `req.userId` does not exist yet — and IP is all it has. That makes
 * its ceiling a *shared* budget behind a carrier NAT, which is why it is set
 * far above what one person does: the precise limits live on the individual
 * routes below, where a token has been verified and `userOrIpKey` can bucket
 * per citizen.
 *
 * Raising this does not loosen the report, vote or analysis limits.
 */
export const globalApiLimiter = rateLimit({
  store: sharedStore('globalApi'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 600,
  message: { error: 'rate_limit', message: 'Trop de requêtes. Réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Auth endpoints (login, register)
export const authLimiter = rateLimit({
  store: sharedStore('auth'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'rate_limit', message: 'Trop de tentatives. Réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Create report limiter
export const createReportLimiter = rateLimit({
  store: sharedStore('createReport'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  keyGenerator: userOrIpKey,
  windowMs: 1 * 60 * 1000,
  max: 3,
  message: { error: 'rate_limit', message: 'Trop de signalements. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

export const duplicateCheckLimiter = rateLimit({
  store: sharedStore('duplicateCheck'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  keyGenerator: userOrIpKey,
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { error: 'rate_limit', message: 'Trop de requêtes. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

export const voteLimiter = rateLimit({
  store: sharedStore('vote'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  keyGenerator: userOrIpKey,
  windowMs: 1 * 60 * 1000,
  max: 5,
  message: { error: 'rate_limit', message: 'Trop de votes. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

export const voteReadLimiter = rateLimit({
  store: sharedStore('voteRead'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  keyGenerator: userOrIpKey,
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { error: 'rate_limit', message: 'Trop de requêtes. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

/**
 * Résolution position → commune.
 *
 * Chaque appel sollicite un service public gratuit (BAN, puis geo.api.gouv.fr).
 * L'app résout une fois au lancement et à la demande du citoyen : 20 par minute
 * couvrent largement un usage honnête, tout en empêchant qu'on se serve de nous
 * comme d'un géocodeur gratuit — ce qui nous ferait bannir des deux API avant
 * de nous coûter quoi que ce soit.
 */
export const geoResolveLimiter = rateLimit({
  store: sharedStore('geoResolve'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  keyGenerator: userOrIpKey,
  windowMs: 1 * 60 * 1000,
  max: 20,
  message: { error: 'rate_limit', message: 'Trop de requêtes de localisation. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

/**
 * L'annuaire des communes clientes.
 *
 * Il tient dans une réponse et ne change qu'à la signature d'un contrat : le
 * client le charge une fois et le garde. Une cadence généreuse pour un usage
 * normal, assez basse pour qu'aspirer la liste des clients d'OnSignale en
 * boucle ne soit pas gratuit.
 */
export const publicTenantsLimiter = rateLimit({
  store: sharedStore('publicTenants'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Trop de requêtes. Réessayez dans une minute.' },
})

/**
 * S'inscrire pour être prévenu quand sa commune arrive.
 *
 * Écriture **sans compte** : la route insère une adresse e-mail dans
 * `commune_waitlist`, laquelle alimente ensuite un envoi Resend de masse le
 * jour où la commune est activée. Seul le plafond global de 600 requêtes par
 * quart d'heure la couvrait : de quoi déposer des milliers d'adresses
 * arbitraires, et faire partir un jour, en notre nom, autant de messages non
 * sollicités. C'est la réputation d'expéditeur du domaine qui se joue là.
 *
 * Trois par heure : personne n'inscrit sa commune quatre fois.
 */
export const waitlistLimiter = rateLimit({
  store: sharedStore('waitlist'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'rate_limit', message: 'Trop de demandes. Réessayez dans une heure.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
})

export const analyzeLimiter = rateLimit({
  store: sharedStore('analyze'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  keyGenerator: userOrIpKey,
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { error: 'rate_limit', message: 'Trop d\'analyses. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

export const heatmapLimiter = rateLimit({
  store: sharedStore('heatmap'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'rate_limit', message: 'Trop de requêtes heatmap. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Admin slow down (progressive delay)
export const adminSlowDown = rateLimit({
  store: sharedStore('adminslow'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  windowMs: 1 * 60 * 1000,
  max: 20,
  message: { error: 'rate_limit', message: 'Trop de requêtes admin. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

/**
 * Les liens remis aux services extérieurs.
 *
 * Généreux, parce qu'un service peut cliquer plusieurs fois, recharger, revenir
 * le lendemain — et parce que le jeton fait 32 octets : ce plafond n'est pas
 * là pour arrêter une énumération, il est là pour qu'un lien fuité ne serve pas
 * de levier contre l'API.
 */
export const serviceHandoffLimiter = rateLimit({
  store: sharedStore('serviceHandoff'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Trop de requêtes. Réessayez dans quelques minutes.' },
})

export const weeklyReportLimiter = rateLimit({
  store: sharedStore('weeklyReport'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 5,
  message: { error: 'rate_limit', message: 'Trop d\'envois de rapports. Réessayez dans 1 heure.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Comments limiter (10 messages per hour)
export const commentsLimiter = rateLimit({
  store: sharedStore('comments'),
  // Une panne de Redis laisse passer plutôt que de refuser : un plafond
  // temporairement absent vaut mieux qu'une API muette.
  passOnStoreError: true,
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 10,
  message: { error: 'rate_limit', message: 'Trop de messages. Réessayez dans 1 heure.' },
  standardHeaders: true,
  legacyHeaders: false,
})
