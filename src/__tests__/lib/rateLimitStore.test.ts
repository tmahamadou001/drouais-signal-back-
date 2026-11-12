import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const created: { prefix: string }[] = []

vi.mock('rate-limit-redis', () => ({
  default: class {
    constructor(options: { prefix: string }) {
      created.push(options)
    }
  },
}))

vi.mock('ioredis', () => ({
  default: class {
    on() {
      return this
    }
    quit() {
      return Promise.resolve()
    }
  },
}))

import { sharedStore, closeRateLimitStore } from '../../lib/rateLimitStore.js'

/**
 * Où se comptent les requêtes.
 *
 * En mémoire, chaque instance tient son propre registre : le plafond réel
 * d'`authLimiter` n'est pas de 5 tentatives par quart d'heure mais de 5 **par
 * instance**, remis à zéro à chaque déploiement. Pour une limite qui protège
 * une page de connexion, c'est la différence entre une protection et une
 * décoration.
 */

beforeEach(() => {
  created.length = 0
  delete process.env.REDIS_URL
})

afterEach(async () => {
  await closeRateLimitStore()
  delete process.env.REDIS_URL
})

describe('choosing where to count', () => {
  /** Développement et tests : le comportement d'avant, sans dépendance. */
  it('keeps the in-memory counting when no Redis is configured', () => {
    expect(sharedStore('auth')).toBeUndefined()
    expect(created).toHaveLength(0)
  })

  it('counts in Redis as soon as one is configured', () => {
    process.env.REDIS_URL = 'redis://localhost:6379'

    expect(sharedStore('auth')).toBeDefined()
    expect(created).toHaveLength(1)
  })

  /**
   * `express-rate-limit` refuse qu'un magasin serve deux limiteurs, et il a
   * raison : les compteurs se mélangeraient, et une tentative de connexion
   * consommerait le budget des signalements.
   */
  it('gives each limiter its own store, under its own prefix', () => {
    process.env.REDIS_URL = 'redis://localhost:6379'

    const auth = sharedStore('auth')
    const reports = sharedStore('createReport')

    expect(auth).not.toBe(reports)
    expect(created.map((options) => options.prefix)).toEqual(['rl:auth:', 'rl:createReport:'])
  })

  /** Une connexion, pas une par limiteur : il y en a quatorze. */
  it('opens a single connection for all of them', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379'

    sharedStore('a')
    sharedStore('b')
    sharedStore('c')

    // Trois magasins, et la connexion se ferme en un seul `quit`.
    expect(created).toHaveLength(3)
    await expect(closeRateLimitStore()).resolves.toBeUndefined()
  })
})
