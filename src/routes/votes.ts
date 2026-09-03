import { Router, Request, Response, NextFunction } from 'express'
import type { Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'
import { voteLimiter, voteReadLimiter } from '../middleware/rateLimits.js'
import { AppError, notFound, badRequest } from '../middleware/errorHandler.js'

const router: ExpressRouter = Router()

router.post('/:id/vote', verifyToken, voteLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reportId = req.params.id
    const userId = req.userId!

    let reportQuery = supabaseAdmin
      .from('reports')
      .select('id, status, vote_count')
      .eq('id', reportId)
    if (req.tenant?.id) reportQuery = reportQuery.eq('tenant_id', req.tenant.id)

    const { data: report, error: reportError } = await reportQuery.single()

    if (reportError || !report) throw notFound('Signalement')

    if (report.status === 'resolu') {
      throw badRequest('Impossible de voter pour un signalement résolu.')
    }

    const { error: insertError } = await supabaseAdmin
      .from('votes')
      .insert({ report_id: reportId, user_id: userId, tenant_id: req.tenant?.id ?? null })

    if (insertError) {
      if (insertError.code === '23505') {
        throw new AppError(409, 'already_voted', 'Vous avez déjà voté pour ce signalement.')
      }
      throw insertError
    }

    return res.json({ vote_count: report.vote_count + 1 })
  } catch (err) {
    next(err)
  }
})

router.delete('/:id/vote', verifyToken, voteLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reportId = req.params.id
    const userId = req.userId

    if (!userId) {
      throw new AppError(401, 'unauthorized', 'Vous devez être connecté pour retirer votre vote.')
    }

    const { data: currentReport, error: fetchError } = await supabaseAdmin
      .from('reports')
      .select('vote_count')
      .eq('id', reportId)
      .single()

    if (fetchError || !currentReport) throw notFound('Signalement')

    const { error: deleteError } = await supabaseAdmin
      .from('votes')
      .delete()
      .eq('report_id', reportId)
      .eq('user_id', userId)

    if (deleteError) throw deleteError

    // Le trigger update_vote_count() maintient report.vote_count automatiquement
    return res.json({
      vote_count: Math.max((currentReport.vote_count ?? 1) - 1, 0),
    })
  } catch (err) {
    next(err)
  }
})

router.get('/:id/my-vote', verifyToken, voteReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reportId = req.params.id

    const { data } = await supabaseAdmin
      .from('votes')
      .select('id')
      .eq('report_id', reportId)
      .eq('user_id', req.userId!)
      .maybeSingle()

    return res.json({ has_voted: !!data })
  } catch (err) {
    next(err)
  }
})

export default router
