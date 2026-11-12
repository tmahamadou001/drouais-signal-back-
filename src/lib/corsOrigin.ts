/**
 * Quelle origine a le droit d'appeler l'API.
 *
 * La règle précédente tenait en cinq conditions, dont deux fausses :
 *
 *  - **`origin.includes('localhost')`** acceptait n'importe quel domaine
 *    contenant ce mot. `https://localhost.attaquant.example` s'enregistre en
 *    cinq minutes, et avec `credentials: true`, toute page qu'il sert lisait
 *    les réponses de l'API dans le navigateur de la victime. L'impact restait
 *    borné parce que l'authentification passe par un en-tête `Authorization`,
 *    non envoyé automatiquement — mais la règle était fausse, et elle le
 *    serait restée le jour où un cookie apparaîtrait ;
 *  - **`origin.endsWith('.onsignale.fr')`** acceptait `evil.onsignale.fr`
 *    comme `dreux.onsignale.fr` : un enregistrement DNS oublié, un CNAME
 *    récupéré chez un hébergeur, et l'origine devient légitime. Un sous-domaine
 *    de commune a une forme, et elle se vérifie.
 *
 * Le développement est reconnu explicitement, et seulement hors production :
 * une origine `localhost` n'a rien à faire dans les réponses d'un serveur de
 * production, même en lecture.
 */

/** `dreux.onsignale.fr`, `la-loupe.onsignale.fr` — un seul niveau, en https. */
const COMMUNE_ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?\.onsignale\.fr$/

/** `http://localhost:5173`, `http://127.0.0.1:3001` — avec ou sans port. */
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/

export function isAllowedOrigin(
  origin: string,
  env: { clientUrl?: string; nodeEnv?: string } = {}
): boolean {
  const fixed = new Set(
    ['https://onsignale.fr', 'https://www.onsignale.fr', env.clientUrl].filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    )
  )

  if (fixed.has(origin)) return true
  if (COMMUNE_ORIGIN.test(origin)) return true

  return env.nodeEnv !== 'production' && DEV_ORIGIN.test(origin)
}
