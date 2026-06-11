import { Router, type Router as ExpressRouter, NextFunction } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import {
  addRecipientSchema,
  updateRecipientSchema,
} from '../schemas/weeklyReport.schema.js'
import {
  generateAndSendWeeklyReport,
  generateReportPreview,
} from '../lib/weeklyReportGenerator.js'
import { requireTenantAdmin } from '../middleware/roleGuard.js'
import { AppError, notFound } from '../middleware/errorHandler.js'

const router: ExpressRouter = Router()

router.use(verifyToken, requireTenantAdmin)

// GET /api/admin/weekly-report/preview
router.get('/weekly-report/preview', async (req, res, next: NextFunction) => {
  try {
    const tenantId = req.tenant?.id
    const { stats, html } = await generateReportPreview(tenantId)
    res.json({ stats, html })
  } catch (err) {
    next(err)
  }
})

// POST /api/admin/weekly-report/send
router.post('/weekly-report/send', async (_req, res, next: NextFunction) => {
  try {
    const stats = await generateAndSendWeeklyReport()
    res.json({ success: true, message: 'Rapport envoyé avec succès', stats })
  } catch (err) {
    next(err)
  }
})

// GET /api/admin/weekly-report/recipients
router.get('/weekly-report/recipients', async (req, res, next: NextFunction) => {
  try {
    let query = supabaseAdmin
      .from('weekly_report_recipients')
      .select('*')
      .order('created_at', { ascending: false })

    if (req.tenant?.id) query = query.eq('tenant_id', req.tenant.id)

    const { data, error } = await query
    if (error) throw error

    res.json({ recipients: data || [] })
  } catch (err) {
    next(err)
  }
})

// POST /api/admin/weekly-report/recipients
router.post('/weekly-report/recipients', validate(addRecipientSchema), async (req, res, next: NextFunction) => {
  try {
    const { email, name, role } = req.body

    const { data, error } = await supabaseAdmin
      .from('weekly_report_recipients')
      .insert({
        email: email.trim().toLowerCase(),
        name: name.trim(),
        role: role || 'elu',
        is_active: true,
        tenant_id: req.tenant?.id ?? null,
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'conflict', 'Cet email est déjà enregistré.')
      }
      throw error
    }

    res.status(201).json({ success: true, recipient: data })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/admin/weekly-report/recipients/:id
router.patch('/weekly-report/recipients/:id', validate(updateRecipientSchema), async (req, res, next: NextFunction) => {
  try {
    const { id } = req.params
    const { email, name, role, is_active } = req.body

    type RecipientUpdate = Partial<{ email: string; name: string; role: string; is_active: boolean }>
    const updates: RecipientUpdate = {}
    if (email     !== undefined) updates.email     = email.trim().toLowerCase()
    if (name      !== undefined) updates.name      = name.trim()
    if (role      !== undefined) updates.role      = role
    if (is_active !== undefined) updates.is_active = is_active

    let q = supabaseAdmin
      .from('weekly_report_recipients')
      .update(updates)
      .eq('id', id)
    if (req.tenant?.id) q = q.eq('tenant_id', req.tenant.id)
    const { data, error } = await q.select().single()

    if (error) throw error
    if (!data) throw notFound('Destinataire')

    res.json({ success: true, recipient: data })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/admin/weekly-report/recipients/:id
router.delete('/weekly-report/recipients/:id', async (req, res, next: NextFunction) => {
  try {
    const { id } = req.params

    let q = supabaseAdmin
      .from('weekly_report_recipients')
      .update({ is_active: false })
      .eq('id', id)
    if (req.tenant?.id) q = q.eq('tenant_id', req.tenant.id)
    const { data, error } = await q.select().single()

    if (error) throw error
    if (!data) throw notFound('Destinataire')

    res.json({ success: true, message: 'Destinataire désactivé', recipient: data })
  } catch (err) {
    next(err)
  }
})

export default router
