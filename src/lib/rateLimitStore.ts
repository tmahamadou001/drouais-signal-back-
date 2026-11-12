import type { Store } from 'express-rate-limit'
import RedisStore from 'rate-limit-redis'
import Redis from 'ioredis'

/**
 * Où se comptent les requêtes.
 *
 * `express-rate-limit` compte **en mémoire** par défaut. Sur une plateforme
 * qui lance plusieurs instances — Railway en lance deux, trois appels
 * successifs à l'API rendent des compteurs divergents — chaque processus tient
 * donc son propre registre. Le plafond réel d'`authLimiter` n'est pas de 5
 * tentatives par quart d'heure mais de 5 **par instance**, et il repart à zéro
 * à chaque déploiement. Pour une limite qui protège une page de connexion,
 * c'est la différence entre une protection et une décoration.
 *
 * Un Redis partagé règle les deux. Trois précautions, parce qu'un limiteur ne
 * doit jamais pouvoir couper le service qu'il protège :
 *
 *  - **sans `REDIS_URL`, on garde la mémoire.** C'est le cas en développement
 *    et en test, et c'est le comportement d'avant ;
 *  - **une panne de Redis ne lève pas.** `ioredis` reconnecte seul ; en
 *    attendant, `express-rate-limit` laisse passer plutôt que de refuser —
 *    préférer un plafond temporairement absent à une API muette ;
 *  - **un seul client pour tous les limiteurs**, ouvert à la première
 *    demande : une douzaine de connexions pour une douzaine de limiteurs
 *    serait absurde.
 */

let client: Redis | null = null
let warned = false

function redis(): Redis | null {
  const url = process.env.REDIS_URL
  if (!url) return null

  if (!client) {
    client = new Redis(url, {
      // Deux essais, pas davantage : un limiteur n'est pas sur le chemin
      // critique, et une requête ne doit pas attendre Redis.
      maxRetriesPerRequest: 2,
      /**
       * Une commande qui n'aboutit pas en une demi-seconde est abandonnée.
       *
       * Sans ce délai, une panne de Redis fait **attendre** chaque requête le
       * temps des reconnexions : mesuré, des appels sans réponse au bout de
       * huit secondes. Un plafond qui disparaît est acceptable ; une API qui
       * ralentit pour compter ses requêtes ne l'est pas.
       */
      commandTimeout: 500,
      /**
       * La file hors ligne reste active, et c'est nécessaire.
       *
       * `rate-limit-redis` téléverse un script Lua à la création du limiteur,
       * c'est-à-dire **avant** que la connexion soit établie. Sans file, cet
       * envoi échoue, l'erreur remonte en rejet non traité, et le processus
       * s'arrête au démarrage — un limiteur qui tue le serveur qu'il protège.
       * Vérifié : c'est exactement ce qui se produit avec `false`.
       */
      enableOfflineQueue: true,
    })

    client.on('error', (error) => {
      // Une fois, pas à chaque reconnexion : `ioredis` réessaie en boucle, et
      // un journal rempli par un service dégradé masque le reste.
      if (warned) return
      warned = true
      console.error('[RateLimit] Redis injoignable, comptage en mémoire :', error.message)
    })
  }

  return client
}

/**
 * Le magasin d'**un** limiteur, ou `undefined` pour garder la mémoire.
 *
 * Une instance par limiteur, avec son propre préfixe : `express-rate-limit`
 * refuse qu'on partage un magasin entre deux limiteurs, et il a raison — les
 * compteurs se mélangeraient, et une tentative de connexion consommerait le
 * budget des signalements. La connexion Redis, elle, reste unique.
 *
 * `undefined` est ce qu'`express-rate-limit` attend pour son magasin par
 * défaut : on ne fabrique pas un faux magasin mémoire, on le laisse faire.
 */
export function sharedStore(name: string): Store | undefined {
  const connection = redis()
  if (!connection) return undefined

  return new RedisStore({
    prefix: `rl:${name}:`,
    sendCommand: (...args: string[]) => connection.call(...(args as [string, ...string[]])) as never,
  })
}

/** Ferme la connexion — pour les tests, et pour un arrêt propre. */
export async function closeRateLimitStore(): Promise<void> {
  if (!client) return

  await client.quit().catch(() => undefined)
  client = null
  warned = false
}
