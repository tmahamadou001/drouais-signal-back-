import { Router, Request, Response } from 'express'
import type { Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken } from '../middleware/auth.js'

const router: ExpressRouter = Router()

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim()
  }
  return req.socket.remoteAddress || 'unknown'
}

router.post('/:id/vote', async (req: Request, res: Response) => {
  try {
    const reportId = req.params.id
    const userId = (req as any).userId || null
    const anonymousIp = userId ? null : getClientIp(req)

    if (!userId && !anonymousIp) {
      return res.status(400).json({
        error: 'no_identifier',
        message: 'Impossible d\'identifier l\'utilisateur.',
      })
    }

    const { data: report, error: reportError } = await supabaseAdmin
      .from('reports')
      .select('id, status, vote_count')
      .eq('id', reportId)
      .single()

    if (reportError || !report) {
      return res.status(404).json({
        error: 'report_not_found',
        message: 'Signalement introuvable.',
      })
    }

    if (report.status === 'resolu') {
      return res.status(400).json({
        error: 'report_resolved',
        message: 'Impossible de voter pour un signalement résolu.',
      })
    }

    const voteData: any = {
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
        return res.status(409).json({
          error: 'already_voted',
          message: 'Vous avez déjà voté pour ce signalement.',
        })
      }
      console.error('Erreur insertion vote:', insertError)
      return res.status(500).json({
        error: 'database_error',
        message: 'Erreur lors de l\'enregistrement du vote.',
      })
    }

    const { data: updatedReport } = await supabaseAdmin
      .from('reports')
      .select('vote_count')
      .eq('id', reportId)
      .single()

    return res.json({
      vote_count: updatedReport?.vote_count || report.vote_count + 1,
    })
  } catch (err: any) {
    console.error('Erreur serveur vote:', err)
    return res.status(500).json({
      error: 'server_error',
      message: err.message || 'Erreur serveur.',
    })
  }
})

router.delete('/:id/vote', verifyToken, async (req: Request, res: Response) => {
  try {
    const reportId = req.params.id
    const userId = (req as any).userId

    if (!userId) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Vous devez être connecté pour retirer votre vote.',
      })
    }

    const { error: deleteError } = await supabaseAdmin
      .from('votes')
      .delete()
      .eq('report_id', reportId)
      .eq('user_id', userId)

    if (deleteError) {
      console.error('Erreur suppression vote:', deleteError)
      return res.status(500).json({
        error: 'database_error',
        message: 'Erreur lors de la suppression du vote.',
      })
    }

    const { data: updatedReport } = await supabaseAdmin
      .from('reports')
      .select('vote_count')
      .eq('id', reportId)
      .single()

    return res.json({
      vote_count: updatedReport?.vote_count || 0,
    })
  } catch (err: any) {
    console.error('Erreur serveur delete vote:', err)
    return res.status(500).json({
      error: 'server_error',
      message: err.message || 'Erreur serveur.',
    })
  }
})

router.get('/:id/my-vote', async (req: Request, res: Response) => {
  try {
    const reportId = req.params.id
    const userId = (req as any).userId || null
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
  } catch (err: any) {
    console.error('Erreur serveur my-vote:', err)
    return res.status(500).json({
      error: 'server_error',
      message: err.message || 'Erreur serveur.',
    })
  }
})

export default router
