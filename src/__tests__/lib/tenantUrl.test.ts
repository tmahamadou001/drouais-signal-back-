import { describe, it, expect, afterEach } from 'vitest'
import { tenantWebUrl } from '../../lib/tenantUrl.js'

const ORIGINAL = process.env.FRONTEND_URL
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.FRONTEND_URL
  else process.env.FRONTEND_URL = ORIGINAL
})

describe('tenantWebUrl', () => {
  it('puts the commune on its own subdomain', () => {
    process.env.FRONTEND_URL = 'https://onsignale.fr'
    expect(tenantWebUrl('dreux')).toBe('https://dreux.onsignale.fr')
  })

  it('drops www, which is the presentation site and knows no commune', () => {
    process.env.FRONTEND_URL = 'https://www.onsignale.fr'
    expect(tenantWebUrl('la-loupe')).toBe('https://la-loupe.onsignale.fr')
  })

  it('leaves a local front alone: there is no subdomain to aim at', () => {
    process.env.FRONTEND_URL = 'http://localhost:5173'
    expect(tenantWebUrl('dreux')).toBe('http://localhost:5173')
  })

  it('keeps an environment that already carries a subdomain', () => {
    process.env.FRONTEND_URL = 'https://staging.onsignale.fr'
    expect(tenantWebUrl('dreux')).toBe('https://staging.onsignale.fr')
  })

  it('falls back to the base when no commune is known', () => {
    process.env.FRONTEND_URL = 'https://onsignale.fr'
    expect(tenantWebUrl(null)).toBe('https://onsignale.fr')
  })
})
