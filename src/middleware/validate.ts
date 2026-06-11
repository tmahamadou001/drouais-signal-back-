import { Request, Response, NextFunction } from 'express'
import { z, ZodError } from 'zod'

 
export function validate(schema: z.ZodTypeAny) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      })

      const parsedObj = parsed as { body?: unknown; query?: unknown; params?: unknown }
      if (parsedObj.body   !== undefined) req.body   = parsedObj.body
      if (parsedObj.query  !== undefined) req.query  = parsedObj.query  as Request['query']
      if (parsedObj.params !== undefined) req.params = parsedObj.params as Request['params']

      next()
    } catch (err) {
      next(err)
    }
  }
}

