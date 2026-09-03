import { Request, Response, NextFunction } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { AppError } from './errorHandler.js'

// Extend Express Request to include user info
declare global {
  namespace Express {
    interface Request {
      userId?: string
      userEmail?: string
      userRole?: string
      /**
       * True when the token belongs to a Supabase *anonymous* sign-in.
       *
       * The mobile app signs in anonymously so its requests carry a real,
       * server-verifiable token instead of a spoofable `Origin` header. That
       * token proves the request came from the app — it is not an identity, and
       * routes must keep treating such a user as an anonymous citizen.
       */
      isAnonymousUser?: boolean
    }
  }
}

/**
 * Verify the Supabase JWT from the Authorization header.
 * Attaches userId, userEmail, userRole to req.
 * Returns 401 if token is invalid or missing.
 */
export async function verifyToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    next(new AppError(401, 'unauthorized', 'Token d\'authentification manquant.'))
    return
  }

  const token = authHeader.replace('Bearer ', '')

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !data.user) {
      next(new AppError(401, 'unauthorized', 'Token invalide ou expiré.'))
      return
    }

    req.userId = data.user.id
    req.userEmail = data.user.email
    req.userRole = data.user.app_metadata?.role || 'citizen'

    next()
  } catch (err) {
    next(new AppError(401, 'unauthorized', 'Erreur de vérification du token.'))
  }
}

/**
 * Optional token verification for anonymous support.
 * Attaches userId, userEmail, userRole to req if token is valid.
 * Continues to next middleware if no token or invalid token (userId will be undefined).
 */
export const verifyTokenOptional = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization

  if (!authHeader?.startsWith('Bearer ')) {
    return next()
  }

  const token = authHeader.replace('Bearer ', '')

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !data.user) {
      return next()
    }

    req.userId = data.user.id
    req.userEmail = data.user.email
    req.userRole = data.user.app_metadata?.role || 'citizen'
    req.isAnonymousUser = data.user.is_anonymous ?? false

    next()
  } catch (err) {
    next()
  }
}

/**
 * Check that the authenticated user has admin role.
 * Must be used AFTER verifyToken.
 */
// export function requireAdmin(req: Request, res: Response, next: NextFunction) {
//   if (req.userRole !== 'admin') {
//     return res.status(403).json({ error: 'Accès réservé aux administrateurs.' })
//   }
//   next()
// }
