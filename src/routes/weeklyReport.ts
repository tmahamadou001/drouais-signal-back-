import { Router, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken, requireAdmin } from '../middleware/auth.js'
import {
  generateAndSendWeeklyReport,
  generateReportPreview,
} from '../lib/weeklyReportGenerator.js'

const router: ExpressRouter = Router()

// Toutes les routes nécessitent l'authentification admin
router.use(verifyToken, requireAdmin)

// GET /api/admin/weekly-report/preview
// Génère le rapport sans l'envoyer, retourne stats + html
router.get('/weekly-report/preview', async (req, res) => {
  try {
    const { stats, html } = await generateReportPreview()
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
// Génère et envoie immédiatement (pour test)
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
// Récupère tous les destinataires
router.get('/weekly-report/recipients', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('weekly_report_recipients')
      .select('*')
      .order('created_at', { ascending: false })

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
// Ajoute un nouveau destinataire
router.post('/weekly-report/recipients', async (req, res) => {
  try {
    const { email, name, role } = req.body

    // Validation
    if (!email || !name) {
      return res.status(400).json({
        error: 'Email et nom requis',
      })
    }

    // Validation email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Format d\'email invalide',
      })
    }

    const { data, error } = await supabaseAdmin
      .from('weekly_report_recipients')
      .insert({
        email: email.trim().toLowerCase(),
        name: name.trim(),
        role: role || 'elu',
        is_active: true,
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
// Met à jour un destinataire (notamment is_active)
router.patch('/weekly-report/recipients/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { email, name, role, is_active } = req.body

    const updates: any = {}
    if (email !== undefined) updates.email = email.trim().toLowerCase()
    if (name !== undefined) updates.name = name.trim()
    if (role !== undefined) updates.role = role
    if (is_active !== undefined) updates.is_active = is_active

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: 'Aucune modification fournie',
      })
    }

    const { data, error } = await supabaseAdmin
      .from('weekly_report_recipients')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

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
// Soft delete : is_active = false
router.delete('/weekly-report/recipients/:id', async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabaseAdmin
      .from('weekly_report_recipients')
      .update({ is_active: false })
      .eq('id', id)
      .select()
      .single()

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
