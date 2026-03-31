import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'

export const validate = (schema: z.ZodTypeAny) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync(req.body)
      next()
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages = error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        }))
        return res.status(400).json({
          error: 'Validation échouée',
          details: errorMessages,
        })
      }
      return res.status(500).json({ error: 'Erreur de validation' })
    }
  }
}
