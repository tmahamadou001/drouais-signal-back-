import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'
import { requireTenant, invalidateTenantCache } from '../middleware/tenantResolver.js'
import { requireTenantAdmin, requireSuperAdmin } from '../middleware/roleGuard.js'

const router: ExpressRouter = Router()

// ─── GET /api/tenant/my-role ─── Authenticated ──────────
router.get('/my-role', verifyToken, requireTenant, async (req: Request, res: Response) => {
  try {
    const globalRole: string = (req as any).userRole ?? ''

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
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/tenant/config ─── Public ──────────────────
router.get('/config', requireTenant, async (req: Request, res: Response) => {
  try {
    const [configResult, categoriesResult] = await Promise.all([
      supabaseAdmin
        .from('tenant_configs')
        .select('*')
        .eq('tenant_id', req.tenant!.id)
        .single(),
      supabaseAdmin
        .from('tenant_categories')
        .select('*')
        .eq('tenant_id', req.tenant!.id)
        .eq('is_active', true)
        .order('sort_order'),
    ])

    if (configResult.error) {
      return res.status(500).json({ error: 'Erreur configuration tenant' })
    }

    res.json({
      slug: req.tenant!.slug,
      name: req.tenant!.name,
      status: req.tenant!.status,
      plan: req.tenant!.plan,
      config: configResult.data,
      categories: categoriesResult.data ?? [],
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/tenant/categories ─── Public ──────────────
router.get('/categories', requireTenant, async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tenant_categories')
      .select('*')
      .eq('tenant_id', req.tenant!.id)
      .order('sort_order')

    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── PATCH /api/tenant/config ─── Admin ─────────────────
router.patch('/config', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tenant_configs')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('tenant_id', req.tenant!.id)
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── PUT /api/tenant/categories ─── Admin ───────────────
router.put('/categories', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { categories } = req.body
    if (!Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({ error: 'categories requis' })
    }

    const { data, error } = await supabaseAdmin
      .from('tenant_categories')
      .upsert(
        categories.map((cat: any, index: number) => ({
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

    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/tenant/users ─── Admin ────────────────────
router.get('/users', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tenant_users')
      .select('*')
      .eq('tenant_id', req.tenant!.id)
      .order('created_at')

    if (error) return res.status(500).json({ error: error.message })

    // Récupérer les emails depuis auth.users
    const userIds = data.map((u: any) => u.user_id)
    const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers()
    const emailMap = new Map(
      (authUsers?.users ?? []).map((u) => [u.id, u.email])
    )

    const enriched = data.map((u: any) => ({
      ...u,
      email: emailMap.get(u.user_id) ?? null,
    }))

    res.json(enriched)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/tenant/users/invite ─── Admin ────────────
router.post('/users/invite', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { email, role, firstName, lastName, jobTitle } = req.body

    if (!email || !role) {
      return res.status(400).json({ error: 'email et role requis' })
    }

    let userId: string

    const { data: userData, error: userError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { role: 'agent' },
      })

    if (userError?.message?.includes('already registered')) {
      const { data: existing } = await supabaseAdmin.auth.admin.listUsers()
      const found = existing?.users?.find((u) => u.email === email)
      if (!found) return res.status(500).json({ error: 'Utilisateur introuvable' })
      userId = found.id
    } else if (userError || !userData.user) {
      return res.status(500).json({ error: userError?.message ?? 'Erreur création utilisateur' })
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

    if (error) return res.status(500).json({ error: error.message })
    res.status(201).json(data)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── PATCH /api/tenant/users/:userId ─── Admin ──────────
router.patch('/users/:userId', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params
    const { role, isActive, firstName, lastName, jobTitle } = req.body

    const updates: any = {}
    if (role !== undefined)      updates.role = role
    if (isActive !== undefined)  updates.is_active = isActive
    if (firstName !== undefined) updates.first_name = firstName
    if (lastName !== undefined)  updates.last_name = lastName
    if (jobTitle !== undefined)  updates.job_title = jobTitle

    const { data, error } = await supabaseAdmin
      .from('tenant_users')
      .update(updates)
      .eq('tenant_id', req.tenant!.id)
      .eq('user_id', userId)
      .select()
      .single()

    if (error || !data) return res.status(404).json({ error: 'Utilisateur introuvable' })
    res.json(data)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── DELETE /api/tenant/users/:userId ─── Admin ─────────
router.delete('/users/:userId', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params

    const { error } = await supabaseAdmin
      .from('tenant_users')
      .update({ is_active: false })
      .eq('tenant_id', req.tenant!.id)
      .eq('user_id', userId)

    if (error) return res.status(404).json({ error: 'Utilisateur introuvable' })
    res.json({ message: 'Accès révoqué' })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/tenant/all ─── Super Admin ────────────────
router.get('/all', verifyToken, requireSuperAdmin, async (_req: Request, res: Response) => {
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

    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/tenant ─── Super Admin ───────────────────
router.post('/', verifyToken, requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const {
      slug, name, plan, contactEmail,
      cityName, mapLat, mapLng, primaryColor, categories,
    } = req.body

    if (!slug || !name || !cityName) {
      return res.status(400).json({ error: 'slug, name et cityName requis' })
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
      if (tenantError.message?.includes('unique')) {
        return res.status(409).json({ error: 'Ce slug existe déjà' })
      }
      return res.status(500).json({ error: tenantError.message })
    }

    await supabaseAdmin.from('tenant_configs').insert({
      tenant_id: tenant.id,
      city_name: cityName,
      map_lat: mapLat ?? 48.7322,
      map_lng: mapLng ?? 1.3664,
      primary_color: primaryColor ?? '#1A56A0',
    })

    const defaultCategories = categories ?? [
      { slug: 'voirie',   label: 'Voirie',    icon: '🛣️', color: '#EF4444', sort_order: 0, sla_hours: 72 },
      { slug: 'eclairage',label: 'Éclairage', icon: '💡', color: '#F59E0B', sort_order: 1, sla_hours: 48 },
      { slug: 'dechets',  label: 'Déchets',   icon: '🗑️', color: '#10B981', sort_order: 2, sla_hours: 48 },
      { slug: 'autre',    label: 'Autre',     icon: '📌', color: '#6B7280', sort_order: 3, sla_hours: 168 },
    ]

    await supabaseAdmin.from('tenant_categories').insert(
      defaultCategories.map((cat: any) => ({ ...cat, tenant_id: tenant.id }))
    )

    res.status(201).json(tenant)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── PATCH /api/tenant/:tenantId/status ─── Super Admin ─
router.patch('/:tenantId/status', verifyToken, requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params
    const { status } = req.body

    const validStatuses = ['trial', 'active', 'suspended', 'demo']
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Statut invalide' })
    }

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

    if (error || !data) return res.status(404).json({ error: 'Tenant introuvable' })

    invalidateTenantCache(data.slug)

    res.json(data)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

export default router
