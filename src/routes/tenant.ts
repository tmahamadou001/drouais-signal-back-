import { Router, type Request, type Response, NextFunction, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'
import { requireTenant, invalidateTenantCache } from '../middleware/tenantResolver.js'
import { requireTenantAdmin, requireSuperAdmin } from '../middleware/roleGuard.js'
import { auditUserCreated, auditTenantCreated, auditTenantStatusChanged, createAuditLog } from '../services/auditService.js'
import { AppError, notFound, badRequest } from '../middleware/errorHandler.js'
import { getAuthEmailMap } from '../lib/authHelpers.js'
import type { TenantUser, TenantCategory } from '../types/tenant.js'

const router: ExpressRouter = Router()

// ─── GET /api/tenant/my-role ─── Authenticated ──────────
router.get('/my-role', verifyToken, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const globalRole: string = req.userRole ?? ''

    if (globalRole === 'super_admin') {
      return res.json({ role: 'super_admin', tenantRole: null })
    }

    const { data, error } = await supabaseAdmin
      .from('tenant_users')
      .select('role, is_active')
      .eq('tenant_id', req.tenant!.id)
      .eq('user_id', req.userId!)
      .single()

    if (error || !data || !data.is_active) {
      return res.json({ role: 'citizen', tenantRole: null })
    }

    return res.json({ role: data.role, tenantRole: data.role })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/tenant/config ─── Public ──────────────────
router.get('/config', requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [configResult, categoriesResult] = await Promise.all([
      supabaseAdmin
        .from('tenant_configs')
        .select('tenant_id, city_name, map_lat, map_lng, map_zoom, map_radius_km, primary_color, feature_anonymous_reports, feature_votes, feature_ai_analysis, feature_weekly_report, feature_heatmap, updated_at')
        .eq('tenant_id', req.tenant!.id)
        .single(),
      supabaseAdmin
        .from('tenant_categories')
        .select('*')
        .eq('tenant_id', req.tenant!.id)
        .eq('is_active', true)
        .order('sort_order'),
    ])

    if (configResult.error) throw new AppError(500, 'internal_error', 'Erreur configuration tenant.')

    res.json({
      slug: req.tenant!.slug,
      name: req.tenant!.name,
      status: req.tenant!.status,
      plan: req.tenant!.plan,
      config: configResult.data,
      categories: categoriesResult.data ?? [],
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/tenant/categories ─── Public ──────────────
router.get('/categories', requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tenant_categories')
      .select('*')
      .eq('tenant_id', req.tenant!.id)
      .order('sort_order')

    if (error) throw error
    res.json(data)
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /api/tenant/config ─── Admin ─────────────────
router.patch('/config', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Explicit whitelist — never spread req.body directly into a DB update
    const {
      city_name, primary_color, logo_url, welcome_message,
      map_lat, map_lng, map_zoom, map_radius_km,
      feature_anonymous_reports, feature_votes, feature_ai_analysis,
      feature_weekly_report, feature_heatmap,
      weekly_report_day, weekly_report_hour, weekly_report_emails,
    } = req.body

    const allowedUpdate: Record<string, unknown> = {}
    if (city_name               !== undefined) allowedUpdate.city_name                = city_name
    if (primary_color           !== undefined) allowedUpdate.primary_color            = primary_color
    if (logo_url                !== undefined) allowedUpdate.logo_url                 = logo_url
    if (welcome_message         !== undefined) allowedUpdate.welcome_message          = welcome_message
    if (map_lat                 !== undefined) allowedUpdate.map_lat                  = map_lat
    if (map_lng                 !== undefined) allowedUpdate.map_lng                  = map_lng
    if (map_zoom                !== undefined) allowedUpdate.map_zoom                 = map_zoom
    if (map_radius_km           !== undefined) allowedUpdate.map_radius_km            = map_radius_km
    if (feature_anonymous_reports !== undefined) allowedUpdate.feature_anonymous_reports = feature_anonymous_reports
    if (feature_votes           !== undefined) allowedUpdate.feature_votes            = feature_votes
    if (feature_ai_analysis     !== undefined) allowedUpdate.feature_ai_analysis      = feature_ai_analysis
    if (feature_weekly_report   !== undefined) allowedUpdate.feature_weekly_report    = feature_weekly_report
    if (feature_heatmap         !== undefined) allowedUpdate.feature_heatmap          = feature_heatmap
    if (weekly_report_day       !== undefined) allowedUpdate.weekly_report_day        = weekly_report_day
    if (weekly_report_hour      !== undefined) allowedUpdate.weekly_report_hour       = weekly_report_hour
    if (weekly_report_emails    !== undefined) allowedUpdate.weekly_report_emails     = weekly_report_emails

    if (Object.keys(allowedUpdate).length === 0) {
      return res.status(400).json({ error: 'Aucun champ modifiable fourni.' })
    }

    const { data, error } = await supabaseAdmin
      .from('tenant_configs')
      .update({ ...allowedUpdate, updated_at: new Date().toISOString() })
      .eq('tenant_id', req.tenant!.id)
      .select('tenant_id, city_name, map_lat, map_lng, map_zoom, map_radius_km, primary_color, logo_url, welcome_message, feature_anonymous_reports, feature_votes, feature_ai_analysis, feature_weekly_report, feature_heatmap, weekly_report_day, weekly_report_hour, weekly_report_emails, updated_at')
      .single()

    if (error) throw error

    createAuditLog({
      userId: req.userId,
      action: 'tenant_config.updated',
      entityType: 'tenant_config',
      entityId: req.tenant!.id,
      tenantId: req.tenant!.id,
      tenantSlug: req.tenant!.slug,
      metadata: { updated_fields: Object.keys(req.body) },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => console.error('[Audit] Erreur:', err))

    res.json(data)
  } catch (err) {
    next(err)
  }
})

// ─── PUT /api/tenant/categories ─── Admin ───────────────
router.put('/categories', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    type CategoryInput = { slug: string; label: string; icon?: string; color?: string; description?: string; isActive?: boolean; sortOrder?: number; slaHours?: number }
    const { categories } = req.body as { categories: CategoryInput[] }
    if (!Array.isArray(categories) || categories.length === 0) {
      throw badRequest('categories requis.')
    }

    const { data, error } = await supabaseAdmin
      .from('tenant_categories')
      .upsert(
        categories.map((cat, index) => ({
          tenant_id: req.tenant!.id,
          slug: cat.slug,
          label: cat.label,
          icon: cat.icon,
          color: cat.color,
          description: cat.description ?? null,
          is_active: cat.isActive ?? true,
          sort_order: cat.sortOrder ?? index,
          sla_hours: cat.slaHours ?? 168,
        })),
        { onConflict: 'tenant_id,slug' }
      )
      .select()

    if (error) throw error

    createAuditLog({
      userId: req.userId,
      action: 'tenant_categories.updated',
      entityType: 'tenant_categories',
      entityId: req.tenant!.id,
      tenantId: req.tenant!.id,
      tenantSlug: req.tenant!.slug,
      metadata: {
        categories_count: categories.length,
        category_slugs: categories.map(c => c.slug),
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => console.error('[Audit] Erreur:', err))

    res.json(data)
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/tenant/users ─── Admin ────────────────────
router.get('/users', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tenant_users')
      .select('*')
      .eq('tenant_id', req.tenant!.id)
      .order('created_at')

    if (error) throw error

    const userIds = data.map((u: TenantUser) => u.user_id)
    const emailMap = await getAuthEmailMap(userIds)

    const enriched = data.map((u: TenantUser) => ({
      ...u,
      email: emailMap.get(u.user_id) ?? null,
    }))

    res.json(enriched)
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/tenant/users/invite ─── Admin ────────────
router.post('/users/invite', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, role, firstName, lastName, jobTitle } = req.body

    if (!email || !role) throw badRequest('email et role requis.')

    let userId: string

    const { data: userData, error: userError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
        app_metadata: { role: 'agent' },
      })

    if (userError?.message?.includes('already registered')) {
      const { data: existing } = await supabaseAdmin.auth.admin.listUsers()
      const found = existing?.users?.find((u) => u.email === email)
      if (!found) throw new AppError(500, 'internal_error', 'Utilisateur introuvable.')
      userId = found.id
    } else if (userError || !userData.user) {
      console.error('[Invite] Erreur création utilisateur Supabase:', userError)
      throw new AppError(500, 'internal_error', 'Erreur lors de la création du compte utilisateur.')
    } else {
      userId = userData.user.id
    }

    const { data, error } = await supabaseAdmin
      .from('tenant_users')
      .upsert({
        tenant_id: req.tenant!.id,
        user_id: userId,
        role,
        first_name: firstName ?? null,
        last_name: lastName ?? null,
        job_title: jobTitle ?? null,
        is_active: true,
        invited_by: req.userId,
        invited_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,user_id' })
      .select()
      .single()

    if (error) throw error

    auditUserCreated({
      userId,
      userEmail: email,
      userRole: role,
      createdBy: req.userId,
      tenantId: req.tenant!.id,
      tenantSlug: req.tenant!.slug,
      metadata: { first_name: firstName, last_name: lastName, job_title: jobTitle },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => console.error('[Audit] Erreur:', err))

    res.status(201).json(data)
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /api/tenant/users/:userId ─── Admin ──────────
router.patch('/users/:userId', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params
    const { role, isActive, firstName, lastName, jobTitle } = req.body

    type UserUpdate = Partial<{ role: string; is_active: boolean; first_name: string; last_name: string; job_title: string }>
    const updates: UserUpdate = {}
    if (role      !== undefined) updates.role       = role
    if (isActive  !== undefined) updates.is_active  = isActive
    if (firstName !== undefined) updates.first_name = firstName
    if (lastName  !== undefined) updates.last_name  = lastName
    if (jobTitle  !== undefined) updates.job_title  = jobTitle

    const { data, error } = await supabaseAdmin
      .from('tenant_users')
      .update(updates)
      .eq('tenant_id', req.tenant!.id)
      .eq('user_id', userId)
      .select()
      .single()

    if (error || !data) throw notFound('Utilisateur')

    if (role !== undefined) {
      createAuditLog({
        userId: req.userId,
        action: 'user.role_changed',
        entityType: 'user',
        entityId: userId,
        tenantId: req.tenant!.id,
        tenantSlug: req.tenant!.slug,
        metadata: { new_role: role },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      }).catch(err => console.error('[Audit] Erreur:', err))
    }

    res.json(data)
  } catch (err) {
    next(err)
  }
})

// ─── DELETE /api/tenant/users/:userId ─── Admin ─────────
router.delete('/users/:userId', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params

    const { data: existing } = await supabaseAdmin
      .from('tenant_users')
      .select('role')
      .eq('tenant_id', req.tenant!.id)
      .eq('user_id', userId)
      .single()

    const { error } = await supabaseAdmin
      .from('tenant_users')
      .update({ is_active: false })
      .eq('tenant_id', req.tenant!.id)
      .eq('user_id', userId)

    if (error) throw notFound('Utilisateur')

    createAuditLog({
      userId: req.userId,
      action: 'user.revoked',
      entityType: 'user',
      entityId: userId,
      tenantId: req.tenant!.id,
      tenantSlug: req.tenant!.slug,
      metadata: { revoked_user_role: existing?.role ?? null },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => console.error('[Audit] Erreur:', err))

    res.json({ message: 'Accès révoqué' })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/tenant/all ─── Super Admin ────────────────
router.get('/all', verifyToken, requireSuperAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tenants')
      .select(`
        *,
        config:tenant_configs(*),
        reports_count:reports(count),
        users_count:tenant_users(count)
      `)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json(data)
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/tenant ─── Super Admin ───────────────────
router.post('/', verifyToken, requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      slug, name, plan, contactEmail,
      cityName, mapLat, mapLng, primaryColor, categories,
    } = req.body

    if (!slug || !name || !cityName) {
      throw badRequest('slug, name et cityName requis.')
    }

    const { data: tenant, error: tenantError } = await supabaseAdmin
      .from('tenants')
      .insert({
        slug,
        name,
        plan: plan ?? 'starter',
        status: 'trial',
        contact_email: contactEmail ?? null,
        trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single()

    if (tenantError) {
      if (tenantError.code === '23505') {
        throw new AppError(409, 'conflict', 'Ce slug existe déjà.')
      }
      throw tenantError
    }

    await supabaseAdmin.from('tenant_configs').insert({
      tenant_id: tenant.id,
      city_name: cityName,
      map_lat: mapLat ?? 48.7322,
      map_lng: mapLng ?? 1.3664,
      primary_color: primaryColor ?? '#1A56A0',
    })

    type DefaultCategory = { slug: string; label: string; icon: string; color: string; sort_order: number; sla_hours: number }
    const defaultCategories: DefaultCategory[] = categories ?? [
      { slug: 'voirie',    label: 'Voirie',    icon: '🛣️', color: '#EF4444', sort_order: 0, sla_hours: 72 },
      { slug: 'eclairage', label: 'Éclairage', icon: '💡', color: '#F59E0B', sort_order: 1, sla_hours: 48 },
      { slug: 'dechets',   label: 'Déchets',   icon: '🗑️', color: '#10B981', sort_order: 2, sla_hours: 48 },
      { slug: 'autre',     label: 'Autre',     icon: '📌', color: '#6B7280', sort_order: 3, sla_hours: 168 },
    ]

    await supabaseAdmin.from('tenant_categories').insert(
      defaultCategories.map(cat => ({ ...cat, tenant_id: tenant.id }))
    )

    auditTenantCreated({
      tenantId: tenant.id,
      tenantSlug: slug,
      tenantName: name,
      createdBy: req.userId!,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => console.error('[Audit] Erreur:', err))

    res.status(201).json(tenant)
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /api/tenant/:tenantId/status ─── Super Admin ─
router.patch('/:tenantId/status', verifyToken, requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = req.params
    const { status } = req.body

    const validStatuses = ['trial', 'active', 'suspended', 'demo']
    if (!validStatuses.includes(status)) {
      throw badRequest('Statut invalide.')
    }

    const { data: currentTenant } = await supabaseAdmin
      .from('tenants')
      .select('status, slug')
      .eq('id', tenantId)
      .single()

    const { data, error } = await supabaseAdmin
      .from('tenants')
      .update({
        status,
        updated_at: new Date().toISOString(),
        ...(status === 'active' ? { activated_at: new Date().toISOString() } : {}),
      })
      .eq('id', tenantId)
      .select()
      .single()

    if (error || !data) throw notFound('Tenant')

    invalidateTenantCache(data.slug)

    if (currentTenant && currentTenant.status !== status) {
      auditTenantStatusChanged({
        tenantId,
        tenantSlug: data.slug,
        oldStatus: currentTenant.status,
        newStatus: status,
        changedBy: req.userId!,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      }).catch(err => console.error('[Audit] Erreur:', err))
    }

    res.json(data)
  } catch (err) {
    next(err)
  }
})

export default router
