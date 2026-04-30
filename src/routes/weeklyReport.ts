import { Router, type Router as ExpressRouter } from 'express'
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

const router: ExpressRouter = Router()

router.use(verifyToken, requireTenantAdmin)

// GET /api/admin/weekly-report/preview
router.get('/weekly-report/preview', async (req, res) => {
  try {
    const tenantId = req.tenant?.id
    const { stats, html } = await generateReportPreview(tenantId)
    res.json({ stats, html })
  } catch (err: any) {
    console.error('Erreur génération preview:', err)
    res.status(500).json({
      error: 'Erreur lors de la génération du rapport',
      details: err.message,
    })
  }
})

// POST /api/admin/weekly-report/send
router.post('/weekly-report/send', async (req, res) => {
  try {
    const stats = await generateAndSendWeeklyReport()
    res.json({
      success: true,
      message: 'Rapport envoyé avec succès',
      stats,
    })
  } catch (err: any) {
    console.error('Erreur envoi rapport:', err)
    res.status(500).json({
      error: 'Erreur lors de l\'envoi du rapport',
      details: err.message,
    })
  }
})

// GET /api/admin/weekly-report/recipients
router.get('/weekly-report/recipients', async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('weekly_report_recipients')
      .select('*')
      .order('created_at', { ascending: false })

    if (req.tenant?.id) query = query.eq('tenant_id', req.tenant.id)

    const { data, error } = await query

    if (error) {
      throw error
    }

    res.json({ recipients: data || [] })
  } catch (err: any) {
    console.error('Erreur récupération destinataires:', err)
    res.status(500).json({
      error: 'Erreur lors de la récupération des destinataires',
      details: err.message,
    })
  }
})

// POST /api/admin/weekly-report/recipients
router.post('/weekly-report/recipients', validate(addRecipientSchema), async (req, res) => {
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
      // Erreur de contrainte UNIQUE sur l'email
      if (error.code === '23505') {
        return res.status(400).json({
          error: 'Cet email est déjà enregistré',
        })
      }
      throw error
    }

    res.status(201).json({
      success: true,
      recipient: data,
    })
  } catch (err: any) {
    console.error('Erreur ajout destinataire:', err)
    res.status(500).json({
      error: 'Erreur lors de l\'ajout du destinataire',
      details: err.message,
    })
  }
})

// PATCH /api/admin/weekly-report/recipients/:id
router.patch('/weekly-report/recipients/:id', validate(updateRecipientSchema), async (req, res) => {
  try {
    const { id } = req.params
    const { email, name, role, is_active } = req.body

    const updates: any = {}
    if (email !== undefined) updates.email = email.trim().toLowerCase()
    if (name !== undefined) updates.name = name.trim()
    if (role !== undefined) updates.role = role
    if (is_active !== undefined) updates.is_active = is_active

    let updateQuery = supabaseAdmin
      .from('weekly_report_recipients')
      .update(updates)
      .eq('id', id)
    if (req.tenant?.id) updateQuery = updateQuery.eq('tenant_id', req.tenant.id)
    const { data, error } = await updateQuery.select().single()

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          error: 'Destinataire non trouvé',
        })
      }
      throw error
    }

    res.json({
      success: true,
      recipient: data,
    })
  } catch (err: any) {
    console.error('Erreur mise à jour destinataire:', err)
    res.status(500).json({
      error: 'Erreur lors de la mise à jour du destinataire',
      details: err.message,
    })
  }
})

// DELETE /api/admin/weekly-report/recipients/:id
router.delete('/weekly-report/recipients/:id', async (req, res) => {
  try {
    const { id } = req.params

    let deleteQuery = supabaseAdmin
      .from('weekly_report_recipients')
      .update({ is_active: false })
      .eq('id', id)
    if (req.tenant?.id) deleteQuery = deleteQuery.eq('tenant_id', req.tenant.id)
    const { data, error } = await deleteQuery.select().single()

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          error: 'Destinataire non trouvé',
        })
      }
      throw error
    }

    res.json({
      success: true,
      message: 'Destinataire désactivé',
      recipient: data,
    })
  } catch (err: any) {
    console.error('Erreur suppression destinataire:', err)
    res.status(500).json({
      error: 'Erreur lors de la suppression du destinataire',
      details: err.message,
    })
  }
})

export default router
