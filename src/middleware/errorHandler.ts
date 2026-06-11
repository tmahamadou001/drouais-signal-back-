import type { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function notFound(resource = 'Ressource'): never {
  throw new AppError(404, 'not_found', `${resource} introuvable.`)
}

export function forbidden(message = 'Accès non autorisé.'): never {
  throw new AppError(403, 'forbidden', message)
}

export function badRequest(message: string): never {
  throw new AppError(400, 'bad_request', message)
}

// Mappe les codes d'erreur PostgreSQL vers des messages génériques
function pgErrorToAppError(err: { code?: string }): AppError | null {
  switch (err.code) {
    case '23505':
      return new AppError(409, 'conflict', 'Cette ressource existe déjà.')
    case '23503':
      return new AppError(409, 'conflict', 'Référence invalide.')
    case '23502':
      return new AppError(400, 'bad_request', 'Champ obligatoire manquant.')
    case 'PGRST116':
      return new AppError(404, 'not_found', 'Ressource introuvable.')
    default:
      return null
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.code, message: err.message })
    return
  }

  if (err instanceof ZodError) {
    res.status(422).json({
      error: 'validation_error',
      message: 'Données invalides.',
      details: err.issues.map(e => ({ field: e.path.join('.'), message: e.message })),
    })
    return
  }

  if (err && typeof err === 'object' && 'code' in err) {
    const mapped = pgErrorToAppError(err as { code?: string })
    if (mapped) {
      res.status(mapped.status).json({ error: mapped.code, message: mapped.message })
      return
    }
  }

  // Erreur inattendue — log complet côté serveur, message générique côté client
  const errorId = `err_${Date.now().toString(36)}`
  console.error(`[${errorId}] Erreur non gérée:`, err)

  res.status(500).json({
    error: 'internal_error',
    message: 'Une erreur interne est survenue.',
    errorId,
  })
}
