import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { isTrustedOrigin, requireTrustedOrigin } from '../../middleware/trustedOrigin.js'
import { AppError } from '../../middleware/errorHandler.js'

function run(req: Partial<Request>): { error: unknown; passed: boolean } {
  let error: unknown = null
  let passed = false

  const next: NextFunction = ((err?: unknown) => {
    if (err) error = err
    else passed = true
  }) as NextFunction

  requireTrustedOrigin(req as Request, {} as Response, next)

  return { error, passed }
}

describe('isTrustedOrigin', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('accepts the production apex, www and any tenant sub-domain', () => {
    expect(isTrustedOrigin('https://onsignale.fr')).toBe(true)
    expect(isTrustedOrigin('https://www.onsignale.fr')).toBe(true)
    expect(isTrustedOrigin('https://dreux.onsignale.fr')).toBe(true)
  })

  it('accepts localhost so the dev front is not locked out', () => {
    expect(isTrustedOrigin('http://localhost:5173')).toBe(true)
  })

  it('rejects an unrelated origin, and a look-alike domain', () => {
    expect(isTrustedOrigin('https://evil.com')).toBe(false)
    // The suffix check is on ".onsignale.fr", so a domain merely *ending* in
    // the brand name must not qualify.
    expect(isTrustedOrigin('https://notonsignale.fr')).toBe(false)
  })

  it('rejects a missing origin', () => {
    expect(isTrustedOrigin(undefined)).toBe(false)
  })
})

describe('requireTrustedOrigin', () => {
  it('lets a request from a trusted origin through', () => {
    const { passed, error } = run({ headers: { origin: 'https://dreux.onsignale.fr' } })

    expect(passed).toBe(true)
    expect(error).toBeNull()
  })

  it('blocks an untrusted origin with 403', () => {
    const { passed, error } = run({ headers: { origin: 'https://evil.com' } })

    expect(passed).toBe(false)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(403)
  })

  it('blocks a request with neither an origin nor a token', () => {
    // curl, a scraper, or any script — the case the guard exists for.
    const { passed, error } = run({ headers: {} })

    expect(passed).toBe(false)
    expect((error as AppError).status).toBe(403)
  })

  it('lets a verified token through without any origin — the native app', () => {
    // A native request never carries an Origin header. `verifyTokenOptional`
    // runs first and is what put `userId` here, so this is a token the server
    // checked against Supabase, not a string the caller chose.
    const { passed, error } = run({ headers: {}, userId: 'user-123' })

    expect(passed).toBe(true)
    expect(error).toBeNull()
  })

  it('lets an anonymous sign-in through — an anonymous report still needs to post', () => {
    const { passed } = run({ headers: {}, userId: 'anon-456', isAnonymousUser: true })

    expect(passed).toBe(true)
  })

  it('still blocks when a token was offered but failed verification', () => {
    // `verifyTokenOptional` swallows a bad token and leaves `userId` unset, so
    // an attacker cannot buy a pass simply by sending an Authorization header.
    const { passed, error } = run({
      headers: { authorization: 'Bearer forged' },
    })

    expect(passed).toBe(false)
    expect((error as AppError).status).toBe(403)
  })
})
