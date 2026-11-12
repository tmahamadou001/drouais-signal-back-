import { z } from 'zod'

/**
 * Ce que le serveur exige pour démarrer, et ce qu'il accepte de supposer.
 *
 * Une variable absente ne produisait aucune erreur : chaque lecteur avait son
 * repli, écrit loin de la configuration, et le repli devenait la vérité sans
 * que personne le décide. `lib/tenantUrl.ts` retombait ainsi sur l'apex — qui
 * sert le site de présentation depuis Cloudflare — et un lien de
 * réinitialisation demandé sans commune menait à une page qui n'existe pas.
 * Le défaut qu'`accountLinkService` dit avoir corrigé, réintroduit par une
 * variable manquante.
 *
 * Deux niveaux, donc :
 *
 *  - **requis partout** : sans eux le serveur ne sait rien faire, il refuse de
 *    démarrer plutôt que de répondre 500 à la première requête ;
 *  - **requis en production** : des valeurs dont le repli est acceptable sur
 *    un poste de développement et faux en ligne. L'absence est alors criée au
 *    démarrage, une fois, là où quelqu'un la lit.
 */

const schema = z.object({
  SUPABASE_URL: z.string().url('SUPABASE_URL doit être une URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, 'SUPABASE_SERVICE_ROLE_KEY manquante'),
  NODE_ENV: z.string().optional(),
  PORT: z.string().optional(),
  CLIENT_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional(),
  API_URL: z.string().url().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_ASSET_URL: z.string().url().optional(),
  UNSUBSCRIBE_SECRET: z.string().min(16).optional(),
  REDIS_URL: z.string().optional(),
})

/**
 * Ce qui manque en production, nommé.
 *
 * Exporté plutôt que journalisé sur place : `index.ts` décide quoi en faire —
 * et les tests peuvent l'éprouver sans démarrer un serveur.
 */
export function missingInProduction(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return []

  const required: [string, string][] = [
    ['CLIENT_URL', 'les liens des e-mails retomberaient sur l’apex, qui sert le site de présentation'],
    ['RESEND_API_KEY', 'aucun e-mail ne partirait — invitations, changements de statut, réponses de la mairie'],
    ['UNSUBSCRIBE_SECRET', 'les liens de désabonnement seraient signés par la clé service_role'],
  ]

  return required.filter(([name]) => !env[name]).map(([name, why]) => `${name} — ${why}`)
}

/** Lit et valide la configuration. Lève si le serveur ne peut pas fonctionner. */
export function readEnv(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env)

  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`Configuration invalide :\n${details.join('\n')}`)
  }

  return parsed.data
}
