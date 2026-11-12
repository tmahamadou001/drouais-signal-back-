import { plainSubject } from '../templates/brand.js'
import { Router, type Request, type Response, NextFunction, type Router as ExpressRouter } from 'express'
import { Resend } from 'resend'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { resolveCategories, resolveActiveCategories } from '../services/categoryService.js'
import { verifyToken } from '../middleware/auth.js'
import { requireTenant, invalidateTenantCache } from '../middleware/tenantResolver.js'
import { requireTenantAdmin, requirePlatformAdmin } from '../middleware/roleGuard.js'
import { auditUserCreated, auditTenantCreated, auditTenantStatusChanged, auditCommunePublication, createAuditLog } from '../services/auditService.js'
import { launchCommune, publishTenantHistory, unpublishTenantHistory } from '../services/communeLaunchService.js'
import { isTenantStatus, publicationEffect, isLaunch, isPartner } from '../lib/tenantMode.js'
import { AppError, notFound, badRequest } from '../middleware/errorHandler.js'
import { listTeam, countOtherAdmins } from '../services/teamService.js'
import { provisionInvite } from '../services/inviteService.js'
import { buildAccountLink } from '../services/accountLinkService.js'
import { isAssignableRole } from '../lib/teamRoles.js'

/**
 * Le refus qui protège la commune d'elle-même.
 *
 * 409 et non 403 : l'administrateur a bien le droit de faire ce geste, c'est
 * l'état de la commune qui l'en empêche — et le message dit comment s'en
 * sortir plutôt que de constater l'interdiction.
 */
function lastAdmin(): never {
  throw new AppError(
    409,
    'last_admin',
    'Cette commune n’aurait plus aucun administrateur. Nommez-en un autre avant de retirer celui-ci.'
  )
}
import { getAuthEmailMap } from '../lib/authHelpers.js'
import { buildInviteEmail } from '../templates/inviteNotification.js'
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

/**
 * La configuration d'un tenant qui n'en a pas.
 *
 * Un prospect est une coquille : personne ne l'a paramétré, et personne ne le
 * fera avant que la mairie signe. Les coordonnées de carte restent absentes
 * plutôt que d'hériter d'un défaut — centrer la carte d'une commune inconnue
 * sur la mairie de Dreux serait pire que de ne rien centrer du tout.
 */
function defaultConfig(tenantId: string, name: string) {
  return {
    tenant_id: tenantId,
    city_name: name,
    map_lat: null,
    map_lng: null,
    map_zoom: null,
    primary_color: '#1A56A0',
    feature_votes: true,
    feature_ai_analysis: true,
    feature_weekly_report: false,
    feature_heatmap: false,
    updated_at: null,
  }
}

// ─── GET /api/tenant/config ─── Public ──────────────────
router.get('/config', requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [configResult, categories] = await Promise.all([
      supabaseAdmin
        .from('tenant_configs')
        .select('tenant_id, city_name, map_lat, map_lng, map_zoom, primary_color, feature_votes, feature_ai_analysis, feature_weekly_report, feature_heatmap, updated_at')
        .eq('tenant_id', req.tenant!.id)
        // `maybeSingle`, pas `single` : un tenant prospect est créé sans ligne
        // de configuration, et `single` traitait cette absence comme une erreur
        // serveur. L'app de l'habitant recevait un 500 et affichait « impossible
        // de charger votre commune » — il était bloqué à l'entrée.
        .maybeSingle(),
      // Le `slug` rendu est le slug **canonique**, jamais le slug local :
      // c'est celui que porte `reports.category` et celui que les clients
      // comparent pour retrouver un libellé.
      resolveActiveCategories(req.tenant!.id),
    ])

    if (configResult.error) throw new AppError(500, 'internal_error', 'Erreur configuration tenant.')

    res.json({
      slug: req.tenant!.slug,
      name: req.tenant!.name,
      status: req.tenant!.status,
      plan: req.tenant!.plan,
      /**
       * Y a-t-il une mairie qui répond ?
       *
       * C'est ce dont l'application a besoin, et le statut ne le dit pas sans
       * interprétation : `community` est une commune ouverte au public sans
       * mairie (migration 040), et l'app doit alors changer de vocabulaire —
       * ni délai annoncé, ni « la mairie traite votre signalement », ni frise
       * à quatre étapes. Le faire déduire au client aurait dispersé la règle.
       */
      partner: isPartner(req.tenant!.status),
      // Une commune sans configuration rend des valeurs par défaut plutôt que
      // `null` : tous les clients lisent `config.city_name` et `config.*`, et
      // leur faire gérer l'absence partout pour un cas de bord se paierait en
      // écrans à moitié vides.
      config: configResult.data ?? defaultConfig(req.tenant!.id, req.tenant!.name),
      categories,
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/tenant/categories ─── Public ──────────────
router.get('/categories', requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Les inactives comprises : le back-office doit pouvoir les réactiver, et
    // un signalement déjà enregistré dans une catégorie désactivée a encore
    // besoin de son libellé.
    res.json(await resolveCategories(req.tenant!.id))
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /api/tenant/config ─── Admin ─────────────────
router.patch('/config', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Explicit whitelist — never spread req.body directly into a DB update
    const {
      city_name, primary_color,
      map_lat, map_lng, map_zoom,
      feature_votes, feature_ai_analysis,
      feature_weekly_report, feature_heatmap,
      weekly_report_day, weekly_report_hour,
    } = req.body

    const allowedUpdate: Record<string, unknown> = {}
    if (city_name               !== undefined) allowedUpdate.city_name                = city_name
    if (primary_color           !== undefined) allowedUpdate.primary_color            = primary_color
    if (map_lat                 !== undefined) allowedUpdate.map_lat                  = map_lat
    if (map_lng                 !== undefined) allowedUpdate.map_lng                  = map_lng
    if (map_zoom                !== undefined) allowedUpdate.map_zoom                 = map_zoom
    if (feature_votes           !== undefined) allowedUpdate.feature_votes            = feature_votes
    if (feature_ai_analysis     !== undefined) allowedUpdate.feature_ai_analysis      = feature_ai_analysis
    if (feature_weekly_report   !== undefined) allowedUpdate.feature_weekly_report    = feature_weekly_report
    if (feature_heatmap         !== undefined) allowedUpdate.feature_heatmap          = feature_heatmap
    if (weekly_report_day       !== undefined) allowedUpdate.weekly_report_day        = weekly_report_day
    if (weekly_report_hour      !== undefined) allowedUpdate.weekly_report_hour       = weekly_report_hour

    if (Object.keys(allowedUpdate).length === 0) {
      return res.status(400).json({ error: 'Aucun champ modifiable fourni.' })
    }

    const { data, error } = await supabaseAdmin
      .from('tenant_configs')
      .update({ ...allowedUpdate, updated_at: new Date().toISOString() })
      .eq('tenant_id', req.tenant!.id)
      .select('tenant_id, city_name, map_lat, map_lng, map_zoom, primary_color, feature_votes, feature_ai_analysis, feature_weekly_report, feature_heatmap, weekly_report_day, weekly_report_hour, updated_at')
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
/**
 * Ce que la commune décide de la taxonomie nationale.
 *
 * Elle n'en crée ni n'en supprime aucune : les slugs sont canoniques, c'est ce
 * qui rend comparables deux signalements de deux communes et mesurable la
 * justesse de l'IA. Elle règle le libellé affiché, le service destinataire, le
 * délai, et si elle traite ou non cette catégorie.
 *
 * Un slug hors liste est **refusé** plutôt qu'ignoré : l'ancien éditeur
 * fabriquait des `cat_1775827638804`, invisibles de l'IA comme de la
 * validation, et personne ne s'en apercevait avant de chercher pourquoi une
 * catégorie ne recevait jamais rien.
 */
router.put('/categories', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    type CategoryInput = {
      slug: string
      label?: string
      isActive?: boolean
      sortOrder?: number
      slaHours?: number
      serviceName?: string | null
      serviceEmails?: string[]
    }
    const { categories } = req.body as { categories: CategoryInput[] }
    if (!Array.isArray(categories) || categories.length === 0) {
      throw badRequest('categories requis.')
    }

    const { data: canonical } = await supabaseAdmin.from('categories').select('slug, label_default')
    const known = new Map((canonical ?? []).map((c) => [c.slug, c.label_default]))

    const unknown = categories.filter((cat) => !known.has(cat.slug)).map((cat) => cat.slug)
    if (unknown.length > 0) {
      throw badRequest(`Catégorie inconnue : ${unknown.join(', ')}. La liste est nationale.`)
    }

    const { data, error } = await supabaseAdmin
      .from('tenant_categories')
      .upsert(
        categories.map((cat, index) => ({
          tenant_id: req.tenant!.id,
          category_slug: cat.slug,
          // `slug` reste NOT NULL et unique par tenant depuis la 006. Pour une
          // ligne créée après la 026 les deux coïncident ; les anciennes lignes
          // gardent leur slug local, qui ne sort plus jamais de la base.
          slug: cat.slug,
          label: cat.label?.trim() || known.get(cat.slug)!,
          is_active: cat.isActive ?? true,
          sort_order: cat.sortOrder ?? index,
          sla_hours: cat.slaHours ?? 168,
          service_name: cat.serviceName ?? null,
          service_emails: cat.serviceEmails ?? [],
        })),
        { onConflict: 'tenant_id,category_slug' }
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

    res.json(await resolveCategories(req.tenant!.id))
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/tenant/users ─── Admin ────────────────────
router.get('/users', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listTeam(req.tenant!.id))
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/tenant/users/invite ─── Admin ────────────
router.post('/users/invite', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, role, firstName, lastName, jobTitle } = req.body

    if (!email || !role) throw badRequest('email et role requis.')

    /**
     * Une commune n'attribue que des rôles d'équipe.
     *
     * Le rôle arrivait du corps de la requête et partait directement en base.
     * `super_admin` y était refusé par une contrainte `CHECK` — le dernier
     * rempart, pas le premier. Voir `lib/teamRoles.ts`.
     */
    if (!isAssignableRole(role)) {
      throw badRequest('Rôle invalide : administrateur, agent ou observateur.')
    }

    // Récupère la config du tenant pour city_name
    const { data: tenantConfig } = await supabaseAdmin
      .from('tenant_configs')
      .select('city_name')
      .eq('tenant_id', req.tenant!.id)
      .single()

    // Trouve ou crée le compte de l'invité — voir `services/inviteService.ts`
    // pour ce que Supabase refuse de faire lui-même.
    const { userId, actionLink, alreadyRegistered } = await provisionInvite(
      email,
      req.tenant!.slug
    )

    // Upsert dans tenant_users
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

    // Email : avec lien de création de mdp pour un nouveau compte,
    // ou simple notification pour un compte existant
    const resend = new Resend(process.env.RESEND_API_KEY)
    const cityLabel = tenantConfig?.city_name ?? req.tenant!.name
    const { html, text } = buildInviteEmail({
      recipientEmail: email,
      firstName: firstName ?? null,
      role,
      tenantName: req.tenant!.name,
      cityName: tenantConfig?.city_name ?? null,
      actionLink,
    })

    await resend.emails.send({
      from: `OnSignale <${process.env.EMAIL_FROM ?? 'invitations@onsignale.fr'}>`,
      to: email,
      subject: plainSubject(alreadyRegistered
        ? `Vous avez rejoint l'équipe OnSignale — ${cityLabel}`
        : `Invitation à rejoindre OnSignale — ${cityLabel}`),
      html,
      text,
    }).catch(err => console.error('[Invite] Erreur envoi email:', err))

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

// ─── POST /api/tenant/users/:userId/resend-invite ─── Admin ─
router.post('/users/:userId/resend-invite', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params

    // Récupère le membre pour avoir son email
    const { data: member, error: memberError } = await supabaseAdmin
      .from('tenant_users')
      .select('user_id, role, first_name')
      .eq('tenant_id', req.tenant!.id)
      .eq('user_id', userId)
      .single()

    if (memberError || !member) throw notFound('Membre')

    // Récupère l'email depuis auth
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId)
    if (authError || !authUser.user?.email) throw new AppError(500, 'internal_error', 'Impossible de récupérer l\'email.')

    const email = authUser.user.email

    const { data: tenantConfig } = await supabaseAdmin
      .from('tenant_configs')
      .select('city_name')
      .eq('tenant_id', req.tenant!.id)
      .single()

    // Un lien de réinitialisation, porté par le sous-domaine de la commune et
    // échangé par notre API — jamais l'URL de Supabase (`accountLinkService`).
    const link = await buildAccountLink({ type: 'recovery', email, tenantSlug: req.tenant!.slug })

    if (!link) {
      console.error('[ResendInvite] Lien impossible à générer pour', email)
      throw new AppError(500, 'internal_error', 'Erreur lors de la génération du lien.')
    }

    const resend = new Resend(process.env.RESEND_API_KEY)
    const { html, text } = buildInviteEmail({
      recipientEmail: email,
      firstName: member.first_name ?? null,
      role: member.role,
      tenantName: req.tenant!.name,
      cityName: tenantConfig?.city_name ?? null,
      actionLink: link.url,
    })

    await resend.emails.send({
      from: `OnSignale <${process.env.EMAIL_FROM ?? 'invitations@onsignale.fr'}>`,
      to: email,
      subject: plainSubject(`Accès à votre compte OnSignale — ${tenantConfig?.city_name ?? req.tenant!.name}`),
      html,
      text,
    })

    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /api/tenant/users/:userId ─── Admin ──────────
router.patch('/users/:userId', verifyToken, requireTenant, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params
    const { role, isActive, firstName, lastName, jobTitle } = req.body

    // Même règle qu'à l'invitation : une commune n'attribue que des rôles
    // d'équipe, et jamais le rôle de plateforme.
    if (role !== undefined && !isAssignableRole(role)) {
      throw badRequest('Rôle invalide : administrateur, agent ou observateur.')
    }

    /**
     * Une commune ne peut pas se retrouver sans administrateur.
     *
     * Rien n'empêchait un administrateur de se rétrograder lui-même, ni de
     * suspendre le dernier de ses pairs : la commune perdait alors le droit
     * d'inviter qui que ce soit, de changer un réglage, ou de rendre la main —
     * et il fallait un super-administrateur pour la débloquer.
     *
     * Vérifié ici, sur le rôle qu'on s'apprête à retirer, et pas seulement
     * masqué dans l'écran : le bouton se cache, la règle se tient.
     */
    const losesAdmin = role !== undefined && role !== 'admin'
    const getsSuspended = isActive === false

    if (losesAdmin || getsSuspended) {
      const { data: current } = await supabaseAdmin
        .from('tenant_users')
        .select('role, is_active')
        .eq('tenant_id', req.tenant!.id)
        .eq('user_id', userId)
        .single()

      if (current?.role === 'admin' && current.is_active) {
        const others = await countOtherAdmins(req.tenant!.id, userId)
        if (others === 0) throw lastAdmin()
      }
    }

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
      .select('role, is_active')
      .eq('tenant_id', req.tenant!.id)
      .eq('user_id', userId)
      .single()

    // Révoquer le dernier administrateur laisserait la commune sans personne
    // pour inviter son remplaçant.
    if (existing?.role === 'admin' && existing.is_active) {
      const others = await countOtherAdmins(req.tenant!.id, userId)
      if (others === 0) throw lastAdmin()
    }

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
router.get('/all', verifyToken, requirePlatformAdmin, async (_req: Request, res: Response, next: NextFunction) => {
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
/**
 * ─── GET /api/tenant/prospects — Les communes sans mairie ───
 *
 * Les communes dont des habitants signalent déjà, sans que la mairie y ait
 * accès : les silencieuses (`prospect`) et celles qu'on a ouvertes au public
 * (`community`, migration 040).
 *
 * L'écran ne sert plus seulement à préparer un rendez-vous commercial. Il sert
 * à **décider d'ouvrir une commune**, ce qui demande de savoir si le fonds vaut
 * une page publique : est-il vivant, combien d'habitants distincts, avec quelles
 * photos, sur quels sujets. D'où les agrégats, et d'où le fait qu'ils soient
 * calculés en base.
 *
 * Une seule requête, et c'est le point : la version précédente en lançait deux
 * **par commune** dans un `Promise.all`. Tenable à vingt communes, intenable à
 * quatre cents — et quatre cents est l'ordre de grandeur visé, puisqu'une
 * commune entre dans ce tableau au premier signalement de n'importe lequel de
 * ses habitants.
 */
router.get('/prospects', verifyToken, requirePlatformAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabaseAdmin.rpc('commune_pipeline_stats')

    if (error) throw error

    res.json(data ?? [])
  } catch (err) {
    next(err)
  }
})

router.post('/', verifyToken, requirePlatformAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      slug, name, plan, contactEmail,
      cityName, mapLat, mapLng, primaryColor,
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
      // Laissées vides quand elles ne sont pas fournies. Le défaut était la
      // mairie de Dreux, héritée du temps où la plateforme n'avait qu'une
      // commune : pour toutes les autres, la carte s'ouvrait sur le mauvais
      // département sans que rien ne signale l'erreur. Une valeur absente se
      // corrige, une valeur fausse se recopie.
      map_lat: mapLat ?? null,
      map_lng: mapLng ?? null,
      primary_color: primaryColor ?? '#1A56A0',
    })

    // Aucune catégorie n'est insérée : depuis la 026 la liste nationale
    // s'applique par défaut, et une ligne de `tenant_categories` ne sert qu'à
    // porter une décision de la commune. Une commune neuve n'en a pris aucune.

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
router.patch('/:tenantId/status', verifyToken, requirePlatformAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = req.params
    const { status } = req.body

    /**
     * La liste des statuts valides vient de `lib/tenantMode.ts`.
     *
     * Elle était recopiée ici, et `prospect` y avait manqué : on pouvait faire
     * passer une commune de prospect à active, jamais l'inverse — une
     * asymétrie non voulue, qui interdisait de défaire une activation
     * prématurée autrement qu'en base. `community` aurait connu le même sort.
     */
    if (!isTenantStatus(status)) {
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
        // Quand la commune a été ouverte au public sans mairie. On ne l'écrase
        // pas à la fermeture : c'est une date d'ouverture, pas un drapeau, et
        // elle dit depuis quand les signalements ont été visibles.
        ...(status === 'community' ? { published_at: new Date().toISOString() } : {}),
      })
      .eq('id', tenantId)
      .select()
      .single()

    if (error || !data) throw notFound('Tenant')

    invalidateTenantCache(data.slug)

    /**
     * La commune sort de l'état prospect : c'est le jour de son lancement.
     *
     * Deux gestes suivent, et aucun des deux ne doit pouvoir faire échouer
     * l'activation elle-même — d'où le `.catch` sur chacun. Publier
     * l'historique est ce qui donne à la commune quelque chose à traiter dès
     * le premier jour ; prévenir la liste d'attente tient la promesse faite à
     * ses habitants, qui ont laissé leur adresse pour cela.
     */
    /**
     * L'historique suit la publication, dans les deux sens.
     *
     * Ouvrir une commune au public rend visible tout ce qu'elle avait reçu en
     * silence ; la refermer — ou la perdre comme cliente — remet tout hors de
     * vue. C'est la décision prise avec la responsable produit : une commune
     * qui s'en va retombe au silence, elle ne reste pas citoyenne. Laisser son
     * inventaire public ferait du non-renouvellement un moyen de pression.
     *
     * Volontairement hors du chemin de la bascule elle-même : le statut est
     * déjà enregistré, et ni la publication ni les e-mails ne doivent pouvoir
     * la faire échouer.
     */
    const effect = currentTenant
      ? publicationEffect(currentTenant.status, status)
      : 'none'

    if (effect !== 'none') {
      void (async () => {
        const affected = effect === 'publish'
          ? await publishTenantHistory(tenantId)
          : await unpublishTenantHistory(tenantId)

        await auditCommunePublication({
          tenantId,
          tenantSlug: data.slug,
          opened: effect === 'publish',
          affectedReports: affected,
          changedBy: req.userId!,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        }).catch(err => console.error('[Audit] Erreur:', err))
      })().catch(err => console.error('[Commune] Publication :', err))
    }

    /**
     * Le jour où la commune devient partenaire.
     *
     * Depuis la migration 040 elle peut y venir de deux états : silencieuse ou
     * citoyenne. Dans les deux cas ses habitants s'étaient inscrits pour être
     * prévenus que leur mairie rejoigne la plateforme, et c'est maintenant.
     *
     * `launchCommune` publie aussi l'historique, ce qui ne fait rien de plus
     * quand il l'est déjà : la requête ne prend que les lignes non publiées.
     */
    if (currentTenant && isLaunch(currentTenant.status, status)) {
      void launchCommune({
        tenantId,
        tenantSlug: data.slug,
        tenantName: data.name,
        activatedBy: req.userId!,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      })
    }

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
