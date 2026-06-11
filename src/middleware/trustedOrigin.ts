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
 * Blocks requests that don't come from a trusted frontend origin.
 * Used on endpoints that allow unauthenticated access but must not be
 * reachable from arbitrary scripts or curl (e.g. anonymous report creation).
 */
export function requireTrustedOrigin(req: Request, _res: Response, next: NextFunction) {
  if (isTrustedOrigin(req.headers.origin)) return next()
  next(new AppError(403, 'forbidden', 'Origine non autorisée.'))
}
