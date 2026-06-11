import type { Request, Response, NextFunction } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import type { UserRole } from '../types/tenant.js'
import { AppError } from './errorHandler.js'

// Cache rôle utilisateur — TTL 30 secondes
export const roleCache = new Map<string, { role: UserRole; expiresAt: number }>()

// Purge des entrées expirées toutes les 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, value] of roleCache.entries()) {
    if (value.expiresAt <= now) roleCache.delete(key)
  }
}, 5 * 60 * 1000).unref()

async function getUserTenantRole(
  userId: string,
  tenantId: string
): Promise<UserRole | null> {
  const cacheKey = `${userId}:${tenantId}`
  const cached = roleCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.role
  }

  // Vérifier le rôle global (super_admin, citizen)
  const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId)
  const globalRole = userData?.user?.app_metadata?.role

  if (globalRole === 'super_admin') {
    roleCache.set(cacheKey, { role: 'super_admin', expiresAt: Date.now() + 30_000 })
    return 'super_admin'
  }

  // Vérifier le rôle tenant
  const { data } = await supabaseAdmin
    .from('tenant_users')
    .select('role, is_active')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .single()

  if (!data || !data.is_active) return null

  const role = data.role as UserRole
  roleCache.set(cacheKey, { role, expiresAt: Date.now() + 30_000 })
  return role
}

export function requireRole(...allowedRoles: UserRole[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.userId) {
      next(new AppError(401, 'unauthorized', 'Non authentifié.'))
      return
    }

    if (!req.tenant) {
      next(new AppError(400, 'bad_request', 'Tenant requis.'))
      return
    }

    const role = await getUserTenantRole(req.userId, req.tenant.id)

    if (!role || !allowedRoles.includes(role)) {
      next(new AppError(403, 'forbidden', 'Droits insuffisants.'))
      return
    }

    req.userRole = role
    next()
  }
}

export const requireSuperAdmin = requireRole('super_admin')
export const requireTenantAdmin = requireRole('super_admin', 'admin')
export const requireAgent = requireRole('super_admin', 'admin', 'agent')
export const requireObserver = requireRole('super_admin', 'admin', 'agent', 'observer')
