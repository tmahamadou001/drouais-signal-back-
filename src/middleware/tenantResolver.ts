import type { Request, Response, NextFunction } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import type { Tenant } from '../types/tenant.js'
import { AppError } from './errorHandler.js'

declare global {
  namespace Express {
    interface Request {
      tenant?: Tenant
    }
  }
}

// Cache mémoire — TTL 60 secondes
const tenantCache = new Map<string, { tenant: Tenant; expiresAt: number }>()

// Purge des entrées expirées toutes les 5 minutes pour éviter un memory leak graduel
setInterval(() => {
  const now = Date.now()
  for (const [key, value] of tenantCache.entries()) {
    if (value.expiresAt <= now) tenantCache.delete(key)
  }
}, 5 * 60 * 1000).unref()

async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const cached = tenantCache.get(slug)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tenant
  }

  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select('*')
    .eq('slug', slug)
    .single()

  if (error || !data) return null

  tenantCache.set(slug, {
    tenant: data as Tenant,
    expiresAt: Date.now() + 60_000,
  })

  return data as Tenant
}

export function invalidateTenantCache(slug: string): void {
  tenantCache.delete(slug)
}

export async function resolveTenant(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Priorité 1 : header X-Tenant-Slug
  let slug = req.headers['x-tenant-slug'] as string | undefined

  // Priorité 2 : sous-domaine
  if (!slug) {
    const host = req.hostname
    const parts = host.split('.')
    const subdomain = parts[0]
    const isValidSubdomain =
      parts.length >= 3 &&
      subdomain !== 'www' &&
      subdomain !== 'api' &&
      subdomain !== 'localhost'

    if (isValidSubdomain) {
      slug = subdomain
    }
  }

  // Priorité 3 : query param (dev uniquement)
  if (!slug && process.env.NODE_ENV === 'development') {
    slug = (req.query.tenant as string) ?? process.env.DEV_TENANT_SLUG ?? 'dreux'
  }

  if (!slug) {
    next()
    return
  }

  const tenant = await getTenantBySlug(slug)

  if (!tenant) {
    next(new AppError(404, 'not_found', 'Ville introuvable.'))
    return
  }

  if (tenant.status === 'suspended') {
    next(new AppError(403, 'suspended', 'Ce service est suspendu.'))
    return
  }

  req.tenant = tenant
  next()
}

export function requireTenant(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.tenant) {
    next(new AppError(400, 'bad_request', 'Tenant requis.'))
    return
  }
  next()
}
