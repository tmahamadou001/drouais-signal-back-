import { Router, Request, Response, NextFunction } from 'express'
import { upload } from '../middleware/upload.js'
import { verifyToken } from '../middleware/auth.js'
import { requireTenantAdmin } from '../middleware/roleGuard.js'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import crypto from 'crypto'
import { badRequest, notFound } from '../middleware/errorHandler.js'

const router: Router = Router()

// ─── POST /api/upload/resolution-photo — Upload photo de résolution (agents uniquement) ───
router.post(
  '/resolution-photo',
  verifyToken,
  requireTenantAdmin,
  upload.single('photo'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file)    throw badRequest('Photo requise.')
      if (!req.tenant)  throw badRequest('Tenant requis.')

      const { reportId } = req.body
      if (!reportId) throw badRequest('reportId requis.')

      const { data: report, error: reportError } = await supabaseAdmin
        .from('reports')
        .select('id, tenant_id')
        .eq('id', reportId)
        .eq('tenant_id', req.tenant.id)
        .single()

      if (reportError || !report) throw notFound('Signalement')

      const ext = req.file.mimetype.split('/')[1] || 'jpg'
      const fileName = `${crypto.randomUUID()}.${ext}`
      const filePath = `resolutions/${req.tenant.id}/${reportId}/${fileName}`

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

      res.json({ url: urlData.signedUrl, filePath })
    } catch (err) {
      next(err)
    }
  }
)

export default router
