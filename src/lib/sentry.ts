import * as Sentry from '@sentry/node'

/**
 * La supervision des erreurs du serveur.
 *
 * Un `console.error` sur Railway se lit tant qu'on regarde au bon moment : les
 * journaux défilent, ne se cherchent pas, et personne ne les surveille la nuit.
 * `errorHandler` fabriquait déjà un `errorId` pour relier le message rendu à
 * l'habitant à la trace écrite côté serveur — un identifiant qui ne menait
 * nulle part. Il mène maintenant à un événement nommé.
 *
 * **Deux refus, qui sont le cœur de ce fichier.**
 *
 * `dataCollection` ferme ce que le SDK ajoute **de lui-même**. Un par un, et
 * non par un interrupteur global : `sendDefaultPii: false` n'existe plus en
 * SDK v11, et ce qui l'a remplacé est permissif par défaut — adresse IP,
 * cookies, en-têtes, corps des requêtes *et des réponses*, paramètres liés des
 * requêtes SQL, et les variables locales de chaque pile. Omettre l'option,
 * c'est donc tout envoyer : la valeur par défaut a changé de camp entre deux
 * versions majeures.
 *
 * `beforeSend` couvre l'autre moitié, que nulle option n'atteint : ce que
 * *nos* erreurs transportent — un message qui cite une URL, une requête
 * Supabase qui cite un `anonymous_token`, une pile qui cite une adresse
 * e-mail.
 *
 * Ce qui ne doit jamais sortir d'ici, et pourquoi :
 *
 *  - **`anonymous_token`** — c'est la *preuve d'identité* de l'auteur d'un
 *    dépôt sans compte. L'audit du 12/11/2026 a montré ce qu'on fait avec :
 *    lire sa conversation privée avec sa mairie, et y répondre en son nom ;
 *  - **les jetons de service** (`/api/service/<jeton>`) — ils valent deux
 *    changements de statut sur un signalement réel ;
 *  - **les JWT** — une session de mairie ;
 *  - **les adresses e-mail** — celles des habitants comme celles des agents.
 *
 * Rien ne part sans `SENTRY_DSN`. L'absence n'est pas une panne : c'est le
 * mode de fonctionnement du poste de développement, et des tests.
 */

const DSN = process.env.SENTRY_DSN

/** Vrai quand les événements partent effectivement. */
export const sentryEnabled = Boolean(DSN)

/** Les deux formes d'URL qui portent un jeton dans leur chemin. */
const TOKEN_IN_PATH = /\/(service|signalement\/suivi)\/[^/?#\s"']+/gi

/** Un jeton passé en paramètre, quel qu'en soit le nom. */
const TOKEN_IN_QUERY = /\b(token|jeton|anonymous_token|access_token|refresh_token|apikey|api_key|key)=[^&\s"']+/gi

const EMAIL = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g

/** `eyJ…` : l'en-tête base64 d'un JWT, suivi de ses deux autres segments. */
const JWT = /eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g

/**
 * Les clés dont la valeur ne s'inspecte pas : on la remplace sans la lire.
 *
 * Par clé et non par contenu, parce qu'un jeton de suivi est une chaîne
 * d'apparence banale — aucune expression régulière ne le reconnaîtrait.
 */
const SENSITIVE_KEY =
  /^(anonymous_token|anonymous_email|token|jeton|access_token|refresh_token|password|new_password|secret|authorization|cookie|set-cookie|apikey|api_key|x-report-token|x-api-key|email|contact_email)$/i

const REDACTED = '[redacted]'

/** Remplace dans un texte ce qui ne doit pas voyager. */
export function scrubText(value: string): string {
  return value
    .replace(TOKEN_IN_PATH, (_m, kind: string) => `/${kind}/${REDACTED}`)
    .replace(TOKEN_IN_QUERY, (_m, key: string) => `${key}=${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(EMAIL, REDACTED)
}

/**
 * Relit une structure de part en part.
 *
 * La profondeur est bornée : un événement Sentry contient des objets que le
 * SDK a lui-même construits, et une référence circulaire ferait tourner le
 * nettoyage à la place de l'envoi.
 */
function scrubDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return value
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, depth + 1))

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubDeep(item, depth + 1)
    }
    return out
  }

  return value
}

/**
 * Le dernier filtre avant l'envoi.
 *
 * Exporté pour être éprouvé par les tests sans réseau ni DSN : c'est la seule
 * fonction de ce fichier dont une erreur se paie en données d'habitants.
 */
export function beforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  // L'identité n'ajoute rien à un diagnostic de panne, et c'est une donnée
  // personnelle. Le `tenant` suffit à savoir qui est touché.
  delete event.user

  if (event.request) {
    // Les en-têtes portent `Authorization`, `Cookie` et `X-Report-Token` :
    // aucun ne se nettoie utilement, tous se jettent.
    delete event.request.headers
    delete event.request.cookies
    delete event.request.data
  }

  return scrubDeep(event) as Sentry.ErrorEvent
}

/**
 * Branche la supervision. À appeler **avant toute autre importation** : le SDK
 * instrumente `http` et Express au chargement, et ne rattrape pas un module
 * déjà évalué.
 */
export function initSentry(): void {
  if (!DSN) return

  Sentry.init({
    dsn: DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SENTRY_RELEASE,

    /**
     * Tout ce que le SDK collecterait seul, refermé.
     *
     * Chaque ligne vaut `true` par défaut, et chacune porterait quelque chose
     * qui n'a rien à faire ailleurs que sur ce serveur :
     *
     *  - `userInfo` : l'IP de l'habitant, déduite des en-têtes ;
     *  - `httpHeaders` : `Authorization`, `Cookie`, `X-Report-Token` ;
     *  - `httpBodies` : un mot de passe de connexion, une adresse e-mail ;
     *  - `urlQueryParams` : `?token=…` ;
     *  - `databaseQueryData` : les paramètres liés d'une requête — donc
     *    l'`anonymous_token` recherché par la clause `where` ;
     *  - `stackFrameVariables` : les variables locales de la fonction qui a
     *    levé, c'est-à-dire précisément ce qu'elle manipulait.
     *
     * `frameContextLines` garde son défaut : c'est notre code source, pas une
     * donnée d'habitant, et sans lui une trace est illisible.
     */
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },

    // Et le dernier filtre, pour ce que nos propres erreurs citent.
    beforeSend,

    /**
     * Zéro par défaut, et c'est un choix.
     *
     * La performance se mesure déjà côté métier (page Performance, délais de
     * traitement). Tracer chaque requête HTTP consommerait un quota qui doit
     * servir aux erreurs — ce pour quoi on installe ça. À relever
     * ponctuellement par la variable, le jour où on cherche une lenteur.
     */
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
  })
}

/**
 * Signale une erreur inattendue, avec de quoi la situer.
 *
 * `errorId` est l'identifiant déjà rendu à l'appelant : c'est lui qui relie un
 * habitant au téléphone, ou un agent dans un e-mail, à un événement précis.
 */
export function captureError(
  error: unknown,
  context: { errorId: string; method?: string; path?: string; tenant?: string },
): void {
  if (!sentryEnabled) return

  Sentry.withScope((scope) => {
    scope.setTag('error_id', context.errorId)
    if (context.tenant) scope.setTag('tenant', context.tenant)
    if (context.method) scope.setTag('http.method', context.method)
    // Le gabarit de route, pas l'URL : `/api/service/:token` regroupe, et
    // l'URL réelle porterait le jeton.
    if (context.path) scope.setTag('route', scrubText(context.path))

    Sentry.captureException(error)
  })
}

export { Sentry }
