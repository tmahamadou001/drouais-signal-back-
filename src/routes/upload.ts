import { Router, Request, Response } from 'express'
import { upload } from '../middleware/upload.js'
import { verifyToken } from '../middleware/auth.js'
import { requireTenantAdmin } from '../middleware/roleGuard.js'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import crypto from 'crypto'

const router: Router = Router()

// ─── POST /api/upload/resolution-photo — Upload photo de résolution (agents uniquement) ───
router.post(
  '/resolution-photo',
  verifyToken,
  requireTenantAdmin,
  upload.single('photo'),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Photo required' })
      }

      if (!req.tenant) {
        return res.status(400).json({ error: 'Tenant required' })
      }

      const { reportId } = req.body
      if (!reportId) {
        return res.status(400).json({ error: 'reportId required' })
      }

      // Verify report exists and belongs to tenant
      const { data: report, error: reportError } = await supabaseAdmin
        .from('reports')
        .select('id, tenant_id')
        .eq('id', reportId)
        .eq('tenant_id', req.tenant.id)
        .single()

      if (reportError || !report) {
        return res.status(404).json({ error: 'Signalement introuvable' })
      }

      // Upload photo to Supabase Storage
      const ext = req.file.mimetype.split('/')[1] || 'jpg'
      const fileName = `${crypto.randomUUID()}.${ext}`
      const filePath = `resolutions/${req.tenant.id}/${reportId}/${fileName}`

      const { error: uploadError } = await supabaseAdmin.storage
        .from('photos')
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        })

      if (uploadError) {
        console.error('Upload error:', uploadError)
        throw uploadError
      }

      // Generate signed URL (1 year validity)
      const { data: urlData, error: urlError } = await supabaseAdmin.storage
        .from('photos')
        .createSignedUrl(filePath, 31536000)

      if (urlError) {
        console.error('URL generation error:', urlError)
        throw urlError
      }

      res.json({ 
        url: urlData.signedUrl,
        filePath 
      })
    } catch (err: any) {
      console.error('Error uploading resolution photo:', err)
      res.status(500).json({ 
        error: err.message || 'Error uploading resolution photo' 
      })
    }
  }
)

export default router
