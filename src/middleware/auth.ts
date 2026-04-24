import { Request, Response, NextFunction } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'

// Extend Express Request to include user info
declare global {
  namespace Express {
    interface Request {
      userId?: string
      userEmail?: string
      userRole?: string
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
    return res.status(401).json({ error: 'Token d\'authentification manquant.' })
  }

  const token = authHeader.replace('Bearer ', '')

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !data.user) {
      return res.status(401).json({ error: 'Token invalide ou expiré.' })
    }

    req.userId = data.user.id
    req.userEmail = data.user.email
    req.userRole = data.user.user_metadata?.role || 'citizen'

    next()
  } catch (err) {
    return res.status(401).json({ error: 'Erreur de vérification du token.' })
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
    req.userRole = data.user.user_metadata?.role || 'citizen'

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
