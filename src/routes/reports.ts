import { Router, Request, Response } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken, requireAdmin } from '../middleware/auth.js'
import { upload } from '../middleware/upload.js'
import crypto from 'crypto'

const router = Router()

// ─── GET /api/reports — Public list of all reports with pagination ───
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 20
    const offset = (page - 1) * limit

    // Get total count
    const { count, error: countError } = await supabaseAdmin
      .from('reports')
      .select('*', { count: 'exact', head: true })

    if (countError) throw countError

    // Get paginated data
    const { data, error } = await supabaseAdmin
      .from('reports')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

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
    const { data, error } = await supabaseAdmin
      .from('reports')
      .select('*')
      .eq('user_id', req.userId!)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json(data)
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erreur serveur.' })
  }
})

// ─── GET /api/reports/:id — Single report with history ───
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params

    const [reportResult, historyResult] = await Promise.all([
      supabaseAdmin.from('reports').select('*').eq('id', id).single(),
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

// ─── POST /api/reports — Create a new report ───
router.post('/', verifyToken, upload.single('photo'), async (req: Request, res: Response) => {
  try {
    const { title, category, description, lat, lng, address_approx, ai_assisted } = req.body

    // Validation
    if (!title || !category || !lat || !lng) {
      return res.status(400).json({ error: 'Champs obligatoires manquants (title, category, lat, lng).' })
    }

    const validCategories = ['voirie', 'eclairage', 'dechets', 'autre']
    if (!validCategories.includes(category)) {
      return res.status(400).json({ error: 'Catégorie invalide.' })
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

      const { data: urlData } = supabaseAdmin.storage
        .from('photos')
        .getPublicUrl(filePath)

      photo_url = urlData.publicUrl
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
        user_id: req.userId!,
        ai_assisted: ai_assisted === 'true' || ai_assisted === true,
      })
      .select('id')
      .single()

    if (error) throw error

    // Insert initial status history entry
    await supabaseAdmin.from('status_history').insert({
      report_id: data.id,
      old_status: 'en_attente',
      new_status: 'en_attente',
      changed_at: new Date().toISOString(),
    })

    res.status(201).json({ id: data.id })
  } catch (err: any) {
    console.error('Erreur création signalement:', err)
    res.status(500).json({ error: err.message || 'Erreur lors de la création du signalement.' })
  }
})

// ─── PATCH /api/reports/:id/status — Admin: update report status ───
router.patch('/:id/status', verifyToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const { status, comment } = req.body

    const validStatuses = ['en_attente', 'pris_en_charge', 'resolu']
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Statut invalide.' })
    }

    // Get current report
    const { data: currentReport, error: fetchError } = await supabaseAdmin
      .from('reports')
      .select('status, user_id')
      .eq('id', id)
      .single()

    if (fetchError || !currentReport) {
      return res.status(404).json({ error: 'Signalement introuvable.' })
    }

    const oldStatus = currentReport.status

    // Update report
    const { error: updateError } = await supabaseAdmin
      .from('reports')
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (updateError) throw updateError

    // Insert status history
    await supabaseAdmin.from('status_history').insert({
      report_id: id,
      old_status: oldStatus,
      new_status: status,
      agent_id: req.userId,
      changed_at: new Date().toISOString(),
      comment: comment || null,
    })

    // Send email notification via Resend
    try {
      const { data: reportUser } = await supabaseAdmin.auth.admin.getUserById(
        currentReport.user_id
      )

      if (reportUser?.user?.email && process.env.RESEND_API_KEY) {
        const statusLabels: Record<string, string> = {
          en_attente: 'En attente',
          pris_en_charge: 'Pris en charge',
          resolu: 'Résolu',
        }

        const { Resend } = await import('resend')
        const resend = new Resend(process.env.RESEND_API_KEY)

        await resend.emails.send({
          from: process.env.EMAIL_FROM || 'DrouaisSignal <notifications@drouaissignal.fr>',
          to: reportUser.user.email,
          subject: `Votre signalement a été mis à jour — ${statusLabels[status]}`,
          html: `
            <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
              <h2 style="color: #1A56A0; margin-bottom: 16px;">DrouaisSignal</h2>
              <p>Bonjour,</p>
              <p>Le statut de votre signalement a été mis à jour :</p>
              <p style="
                display: inline-block;
                padding: 8px 16px;
                border-radius: 8px;
                font-weight: 600;
                background: ${status === 'resolu' ? '#E6F7F1' : '#FEF5E7'};
                color: ${status === 'resolu' ? '#1D9E75' : '#EF9F27'};
              ">
                ${statusLabels[oldStatus]} → ${statusLabels[status]}
              </p>
              ${comment ? `<p style="margin-top: 12px; color: #525252;">Commentaire : ${comment}</p>` : ''}
              <p style="margin-top: 24px;">
                <a href="${process.env.CLIENT_URL}/signalement/${id}" style="
                  display: inline-block; padding: 10px 20px;
                  background: #1A56A0; color: white; text-decoration: none;
                  border-radius: 8px; font-weight: 600;
                ">Voir mon signalement</a>
              </p>
              <p style="margin-top: 24px; font-size: 12px; color: #A3A3A3;">
                Ville de Dreux — Service de signalement urbain
              </p>
            </div>
          `,
        })
      }
    } catch (emailErr) {
      // Don't fail the request if email fails
      console.error('Erreur envoi email:', emailErr)
    }

    res.json({ success: true })
  } catch (err: any) {
    console.error('Erreur mise à jour statut:', err)
    res.status(500).json({ error: err.message || 'Erreur serveur.' })
  }
})

export default router
