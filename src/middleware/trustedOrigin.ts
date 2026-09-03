import { Request, Response, NextFunction } from 'express'
import { AppError } from './errorHandler.js'

export function isTrustedOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  return (
    origin.endsWith('.onsignale.fr') ||
    origin === 'https://onsignale.fr' ||
    origin === 'https://www.onsignale.fr' ||
    origin.includes('localhost') ||
    origin === process.env.CLIENT_URL
  )
}

/**
 * Blocks requests that don't come from a trusted client on endpoints that allow
 * unauthenticated access but must not be reachable from arbitrary scripts
 * (e.g. anonymous report creation).
 *
 * Two ways through:
 *
 * 1. A trusted `Origin` header — how the web front qualifies. Note this only
 *    constrains *browsers*, which are the ones forced to send an honest Origin;
 *    `curl -H "Origin: https://onsignale.fr"` has always sailed past it. The
 *    real brake on abuse here is `createReportLimiter`, not this check.
 *
 * 2. A Supabase token the server itself verified — how the native app
 *    qualifies, since a native request carries no Origin at all and there is no
 *    header it could send that a script could not copy. The mobile app signs in
 *    anonymously when the citizen has no account, so even an anonymous report
 *    arrives with a token minted by Supabase for that install.
 *
 * The second route is strictly stronger evidence than the first: a token is
 * issued by Supabase and checked against it, where an Origin is a string the
 * caller chose. This must therefore run *after* `verifyTokenOptional`, which is
 * what puts `req.userId` in place.
 */
export function requireTrustedOrigin(req: Request, _res: Response, next: NextFunction) {
  if (isTrustedOrigin(req.headers.origin)) return next()
  if (req.userId) return next()

  next(new AppError(403, 'forbidden', 'Origine non autorisée.'))
}
