import { Request, Response, NextFunction } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'

declare global {
  namespace Express {
    interface Request {
      apiKey?: string
      apiKeyValid?: boolean
    }
  }
}

/**
 * Validate API key from header or query parameter.
 * Attaches apiKey and apiKeyValid to req.
 * Continues regardless of validity (let the route decide if it's required).
 */
export async function validateApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string || req.query.api_key as string

  if (!apiKey) {
    req.apiKey = undefined
    req.apiKeyValid = false
    return next()
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('tenant_configs')
      .select('tenant_id, api_key')
      .eq('api_key', apiKey)
      .single()

    if (error || !data) {
      req.apiKey = apiKey
      req.apiKeyValid = false
      return next()
    }

    req.apiKey = apiKey
    req.apiKeyValid = true
    next()
  } catch (err) {
    req.apiKey = apiKey
    req.apiKeyValid = false
    next()
  }
}
