import { describe, it, expect } from 'vitest'
import { isAllowedOrigin } from '../../lib/corsOrigin.js'

/**
 * Qui a le droit de lire les réponses de l'API depuis un navigateur.
 *
 * Les deux premiers cas sont ceux que la règle précédente laissait passer, et
 * ils ne se devinent pas à la lecture : `origin.includes('localhost')` et
 * `origin.endsWith('.onsignale.fr')` ressemblent à des vérifications.
 */

const PROD = { clientUrl: 'https://dreux.onsignale.fr', nodeEnv: 'production' }
const DEV = { clientUrl: 'http://localhost:5173', nodeEnv: 'development' }

describe('what a domain name can pretend to be', () => {
  /** Un domaine qui s'enregistre en cinq minutes. */
  it('refuses a domain that merely contains "localhost"', () => {
    expect(isAllowedOrigin('https://localhost.attaquant.example', PROD)).toBe(false)
    expect(isAllowedOrigin('https://monlocalhost.example', PROD)).toBe(false)
    expect(isAllowedOrigin('http://localhost.evil.test', PROD)).toBe(false)
  })

  /** `onsignale.fr.attaquant.example` finit par ressembler, et n'est pas à nous. */
  it('refuses a domain that merely ends with our name', () => {
    expect(isAllowedOrigin('https://onsignale.fr.attaquant.example', PROD)).toBe(false)
    expect(isAllowedOrigin('https://notonsignale.fr', PROD)).toBe(false)
    expect(isAllowedOrigin('https://evil.com/?x=https://onsignale.fr', PROD)).toBe(false)
  })

  /** Un sous-domaine de commune a une forme : un seul niveau, en https. */
  it('accepts a commune subdomain, and only one level', () => {
    expect(isAllowedOrigin('https://dreux.onsignale.fr', PROD)).toBe(true)
    expect(isAllowedOrigin('https://la-loupe.onsignale.fr', PROD)).toBe(true)

    expect(isAllowedOrigin('https://a.b.onsignale.fr', PROD)).toBe(false)
    expect(isAllowedOrigin('http://dreux.onsignale.fr', PROD)).toBe(false)
  })

  it('accepts the apex and www', () => {
    expect(isAllowedOrigin('https://onsignale.fr', PROD)).toBe(true)
    expect(isAllowedOrigin('https://www.onsignale.fr', PROD)).toBe(true)
  })

  it('accepts the configured client URL', () => {
    expect(isAllowedOrigin('https://dreux.onsignale.fr', PROD)).toBe(true)
  })
})

describe('development origins', () => {
  it('are accepted outside production', () => {
    expect(isAllowedOrigin('http://localhost:5173', DEV)).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:3001', DEV)).toBe(true)
    expect(isAllowedOrigin('http://localhost', DEV)).toBe(true)
  })

  /** Une origine de développement n'a rien à faire en production. */
  it('are refused in production', () => {
    expect(isAllowedOrigin('http://localhost:5173', PROD)).toBe(false)
    expect(isAllowedOrigin('http://127.0.0.1:3001', PROD)).toBe(false)
  })

  it('does not take a port for a domain', () => {
    expect(isAllowedOrigin('http://localhost:5173.attaquant.example', DEV)).toBe(false)
  })
})

describe('a missing configuration', () => {
  it('never turns an empty CLIENT_URL into a wildcard', () => {
    expect(isAllowedOrigin('', { clientUrl: '', nodeEnv: 'production' })).toBe(false)
    expect(isAllowedOrigin('https://nimporte.quoi', { nodeEnv: 'production' })).toBe(false)
  })
})
