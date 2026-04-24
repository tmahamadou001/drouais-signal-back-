import { Router, Request, Response, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken, verifyTokenOptional } from '../middleware/auth.js'
import { validateApiKey } from '../middleware/apiKey.js'
import { createReportSchema, updateReportSchema, paginationSchema } from '../schemas/report.schema.js'
import { upload } from '../middleware/upload.js'
import crypto from 'crypto'
import { validate } from '../middleware/validate.js'
import { sendStatusChangeNotification } from '../services/notificationService.js'
import { requireTenantAdmin } from '../middleware/roleGuard.js'

const router: ExpressRouter = Router()

// ─── GET /api/reports — Public list of all reports with pagination ───
router.get('/', validate(paginationSchema), async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 20
    const offset = (page - 1) * limit
    const tenantId = req.tenant?.id

    let countQuery = supabaseAdmin.from('reports').select('*', { count: 'exact', head: true })
    if (tenantId) countQuery = countQuery.eq('tenant_id', tenantId)

    const { count, error: countError } = await countQuery
    if (countError) throw countError

    let dataQuery = supabaseAdmin.from('reports').select('*').order('created_at', { ascending: false }).range(offset, offset + limit - 1)
    if (tenantId) dataQuery = dataQuery.eq('tenant_id', tenantId)

    const { data, error } = await dataQuery

    if (error) throw error

    res.json({
      data,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erreur serveur.' })
  }
})

// ─── GET /api/reports/mine — Reports of the logged-in user ───
router.get('/mine', verifyToken, async (req: Request, res: Response) => {
  try {
    let query = supabaseAdmin
      .from('reports')
      .select('*')
      .eq('user_id', req.userId!)
      .order('created_at', { ascending: false })

    if (req.tenant?.id) query = query.eq('tenant_id', req.tenant.id)

    const { data, error } = await query

    if (error) throw error
    res.json(data)
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erreur serveur.' })
  }
})

// ─── GET /api/reports/anonymous/:token — Get anonymous report by token ───
router.get('/anonymous/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params

    let reportQuery = supabaseAdmin
      .from('reports')
      .select('id, title, category, status, created_at, address_approx, lat, lng, photo_url')
      .eq('anonymous_token', token)
      .eq('is_anonymous', true)

    if (req.tenant?.id) reportQuery = reportQuery.eq('tenant_id', req.tenant.id)

    const reportResult = await reportQuery.single()

    if (reportResult.error) {
      return res.status(404).json({ error: 'Signalement introuvable.' })
    }

    res.json(reportResult.data)
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erreur serveur.' })
  }
})

// ─── GET /api/reports/:id — Single report with history ───
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params

    let reportQuery = supabaseAdmin.from('reports').select('*').eq('id', id)
    if (req.tenant?.id) reportQuery = reportQuery.eq('tenant_id', req.tenant.id)

    const [reportResult, historyResult] = await Promise.all([
      reportQuery.single(),
      supabaseAdmin
        .from('status_history')
        .select('*')
        .eq('report_id', id)
        .order('changed_at', { ascending: true }),
    ])

    if (reportResult.error) {
      return res.status(404).json({ error: 'Signalement introuvable.' })
    }

    res.json({
      report: reportResult.data,
      history: historyResult.data || [],
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erreur serveur.' })
  }
})

// ─── POST /api/reports — Create a new report (authenticated or anonymous) ───
router.post('/',verifyTokenOptional,  validateApiKey, upload.single('photo'), validate(createReportSchema), async (req: Request, res: Response) => {
  try {

    const { title, category, description, lat, lng, address_approx, anonymous_email } = req.body
    const ai_assisted = req.body.ai_assisted === 'true' || req.body.ai_assisted === true
    const isAnonymous = !req.userId
    const anonymousToken = isAnonymous ? crypto.randomBytes(32).toString('hex') : null

    if (isAnonymous && !req.apiKeyValid) {
      return res.status(401).json({ error: 'Clé API invalide ou manquante pour les signalements anonymes.' })
    }

    // Valider la catégorie contre les catégories actives du tenant
    if (req.tenant?.id) {
      const { data: validCategories } = await supabaseAdmin
        .from('tenant_categories')
        .select('slug')
        .eq('tenant_id', req.tenant.id)
        .eq('is_active', true)
      if (validCategories && validCategories.length > 0) {
        const validSlugs = validCategories.map((c: any) => c.slug)
        if (!validSlugs.includes(category)) {
          return res.status(400).json({ error: `Catégorie invalide : "${category}"` })
        }
      }
    }

    // Valider que les coordonnées sont dans le périmètre du tenant
    if (req.tenant?.id) {
      const { data: tenantConfig } = await supabaseAdmin
        .from('tenant_configs')
        .select('map_lat, map_lng, map_radius_km')
        .eq('tenant_id', req.tenant.id)
        .single()

      if (tenantConfig?.map_lat && tenantConfig?.map_lng) {
        const reportLat = parseFloat(lat)
        const reportLng = parseFloat(lng)
        const radiusKm = tenantConfig.map_radius_km ?? 15

        const R = 6371
        const dLat = (reportLat - tenantConfig.map_lat) * Math.PI / 180
        const dLng = (reportLng - tenantConfig.map_lng) * Math.PI / 180
        const a = Math.sin(dLat / 2) ** 2
          + Math.cos(tenantConfig.map_lat * Math.PI / 180) * Math.cos(reportLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
        const distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

        if (distanceKm > radiusKm) {
          return res.status(422).json({
            error: `La position est en dehors de la zone autorisée (rayon : ${radiusKm} km).`,
          })
        }
      }
    }

    // Upload photo to Supabase Storage if present
    let photo_url: string | null = null
    if (req.file) {
      const ext = req.file.mimetype.split('/')[1] || 'jpg'
      const fileName = `${crypto.randomUUID()}.${ext}`
      const filePath = `reports/${fileName}`

      const { error: uploadError } = await supabaseAdmin.storage
        .from('photos')
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        })

      if (uploadError) throw uploadError

      const { data: urlData, error: urlError } = await supabaseAdmin.storage
        .from('photos')
        .createSignedUrl(filePath, 31536000)

      if (urlError) throw urlError

      photo_url = urlData.signedUrl
    }

    if (!req.tenant) {
      return res.status(400).json({ error: 'Tenant requis pour créer un signalement.' })
    }

    // Insert report
    const { data, error } = await supabaseAdmin
      .from('reports')
      .insert({
        title: title.trim(),
        category,
        description: description?.trim() || null,
        photo_url,
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        address_approx: address_approx?.trim() || null,
        status: 'en_attente',
        user_id: req.userId || null,
        is_anonymous: isAnonymous,
        anonymous_token: anonymousToken,
        anonymous_email: isAnonymous && anonymous_email ? anonymous_email.trim() : null,
        ai_assisted,
        tenant_id: req.tenant.id,
      })
      .select('id, anonymous_token')
      .single()

    if (error) throw error

    // Insert initial status history entry
    await supabaseAdmin.from('status_history').insert({
      report_id: data.id,
      old_status: 'en_attente',
      new_status: 'en_attente',
      changed_at: new Date().toISOString(),
      tenant_id: req.tenant.id,
    })

    const response: any = { id: data.id }
    if (isAnonymous) {
      response.anonymous_token = data.anonymous_token
      console.log(`📝 [Anonymous Report] Token: ${anonymousToken?.substring(0, 8)}... | Email: ${anonymous_email || 'none'}`)
    }
    res.status(201).json(response)
  } catch (err: any) {
    console.error('Erreur création signalement:', err)
    res.status(500).json({ error: 'Erreur lors de la création du signalement.' })
  }
})

// ─── PATCH /api/reports/:id/status — Admin: update report status ───
router.patch('/:id/status', verifyToken, requireTenantAdmin,validate(updateReportSchema), async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const { status, comment } = req.body

    const { data: currentReport, error: fetchError } = await supabaseAdmin
      .from('reports')
      .select('id, title, status, category, address_approx, photo_url, created_at, user_id, tenant_id, is_anonymous, anonymous_token')
      .eq('id', id)
      .single()

    if (fetchError || !currentReport) {
      return res.status(404).json({ error: 'Signalement introuvable.' })
    }

    const oldStatus = currentReport.status

    const { data: updatedReport, error: updateError } = await supabaseAdmin
      .from('reports')
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()

    if (updateError) throw updateError

    await supabaseAdmin.from('status_history').insert({
      report_id: id,
      old_status: oldStatus,
      new_status: status,
      agent_id: req.userId,
      changed_at: new Date().toISOString(),
      comment: comment || null,
      tenant_id: req.tenant?.id ?? currentReport.tenant_id,
    })

    res.json({ data: updatedReport })

    sendStatusChangeNotification({
      reportId: currentReport.id,
      reportTitle: currentReport.title,
      newStatus: status,
      previousStatus: oldStatus,
      category: currentReport.category,
      addressApprox: currentReport.address_approx,
      photoUrl: currentReport.photo_url,
      createdAt: currentReport.created_at,
      userId: currentReport.user_id,
      isAnonymous: currentReport.is_anonymous,
      anonymousToken: currentReport.anonymous_token,
    }).catch(err => {
      console.error('[Notification] Erreur background:', err)
    })

  } catch (err: any) {
    console.error('Erreur mise à jour statut:', err)
    res.status(500).json({ error: err.message || 'Erreur serveur.' })
  }
})

export default router
