import { Router, Request, Response, NextFunction } from 'express'
import type { Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'
import { AppError, notFound, badRequest } from '../middleware/errorHandler.js'

const router: ExpressRouter = Router()

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim()
  }
  return req.socket.remoteAddress || 'unknown'
}

router.post('/:id/vote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reportId = req.params.id
    const userId = req.userId || null
    const anonymousIp = userId ? null : getClientIp(req)

    if (!userId && !anonymousIp) {
      throw badRequest('Impossible d\'identifier l\'utilisateur.')
    }

    const { data: report, error: reportError } = await supabaseAdmin
      .from('reports')
      .select('id, status, vote_count')
      .eq('id', reportId)
      .single()

    if (reportError || !report) throw notFound('Signalement')

    if (report.status === 'resolu') {
      throw badRequest('Impossible de voter pour un signalement résolu.')
    }

    interface VoteInsert {
      report_id: string
      user_id: string | null
      anonymous_ip: string | null
      tenant_id: string | null
    }
    const voteData: VoteInsert = {
      report_id: reportId,
      user_id: userId,
      anonymous_ip: anonymousIp,
      tenant_id: req.tenant?.id ?? null,
    }

    const { error: insertError } = await supabaseAdmin
      .from('votes')
      .insert(voteData)

    if (insertError) {
      if (insertError.code === '23505') {
        throw new AppError(409, 'already_voted', 'Vous avez déjà voté pour ce signalement.')
      }
      throw insertError
    }

    // Le trigger update_vote_count() maintient report.vote_count automatiquement
    return res.json({ vote_count: report.vote_count + 1 })
  } catch (err) {
    next(err)
  }
})

router.delete('/:id/vote', verifyToken, async (req: Request, res: Response, next: NextFunction) => {
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

router.get('/:id/my-vote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reportId = req.params.id
    const userId = req.userId || null
    const anonymousIp = userId ? null : getClientIp(req)

    let hasVoted = false

    if (userId) {
      const { data } = await supabaseAdmin
        .from('votes')
        .select('id')
        .eq('report_id', reportId)
        .eq('user_id', userId)
        .maybeSingle()

      hasVoted = !!data
    } else if (anonymousIp) {
      const { data } = await supabaseAdmin
        .from('votes')
        .select('id')
        .eq('report_id', reportId)
        .eq('anonymous_ip', anonymousIp)
        .maybeSingle()

      hasVoted = !!data
    }

    return res.json({ has_voted: hasVoted })
  } catch (err) {
    next(err)
  }
})

export default router
