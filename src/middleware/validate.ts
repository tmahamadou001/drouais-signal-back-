import { Request, Response, NextFunction } from 'express'
import { z ,ZodError} from 'zod'

 
export function validate(schema: z.ZodTypeAny) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      // Valider et remplacer les données brutes par les données parsées et typées
      // Zod transforme automatiquement les types (ex: string → number)
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      })

      // Remplacer les données brutes par les données validées
      req.body = (parsed as any).body || req.body
      req.query = (parsed as any).query || req.query
      req.params = (parsed as any).params || req.params

      next()
    } catch (err) {
      if (err instanceof ZodError) {
        // Formater les erreurs Zod de manière lisible
        return res.status(422).json({
          error: 'Données invalides',
          details: err.issues.map((e: z.ZodIssue) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        })
      }
      // Erreur inattendue → passer au error handler global
      console.error('[Validate] Erreur non-Zod:', err)
      next(err)
    }
  }
}

// export const validate = (schema: z.ZodTypeAny) => {
//   return async (req: Request, res: Response, next: NextFunction) => {
//     try {
//       console.log('Validation request body:', req.query)
//       await schema.parseAsync(req.query)
//       next()
//     } catch (error) {
//       if (error instanceof z.ZodError) {
//         const errorMessages = error.issues.map((issue) => ({
//           path: issue.path.join('.'),
//           message: issue.message,
//         }))
//         console.error('Validation error:', errorMessages)
//         return res.status(400).json({
//           error: 'Validation échouée',
//           details: errorMessages,
//         })
//       }
//       return res.status(500).json({ error: 'Erreur de validation' })
//     }
//   }
// }

