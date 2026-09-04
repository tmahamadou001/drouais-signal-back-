import type { Request, Response, NextFunction } from 'express'
import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { pushAgentComment } from '../../services/pushService.js'
import { sendCommentNotification } from './comments.email.js'
import { AppError, notFound, forbidden } from '../../middleware/errorHandler.js'
import { getAuthUserEmail } from '../../lib/authHelpers.js'

// ─── Lister les commentaires d'un signalement ────────────────────
export async function getComments(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.tenant) throw notFound('Tenant')

    const { reportId } = req.params

    const { data: report } = await supabaseAdmin
      .from('reports')
      .select('id, user_id, status')
      .eq('id', reportId)
      .eq('tenant_id', req.tenant.id)
      .single()

    if (!report) throw notFound('Signalement')

    const userRole = req.userRole
    const isCitizen = userRole === 'citizen' || (!userRole && req.userId)

    if (isCitizen && report.user_id !== req.userId) {
      throw forbidden('Accès non autorisé.')
    }

    const { data: comments, error } = await supabaseAdmin
      .from('report_comments')
      .select('*')
      .eq('report_id', reportId)
      .eq('tenant_id', req.tenant.id)
      .order('created_at', { ascending: true })

    if (error) throw error

    // Enrichir les commentaires avec les infos des agents — une seule requête batch
    const agentIds = [...new Set(
      (comments ?? [])
        .filter(c => c.author_type === 'agent')
        .map(c => c.author_id)
    )]

    const agentMap = new Map<string, { first_name: string | null; last_name: string | null }>()

    if (agentIds.length > 0) {
      const { data: agents } = await supabaseAdmin
        .from('tenant_users')
        .select('user_id, first_name, last_name, job_title')
        .in('user_id', agentIds)
        .eq('tenant_id', req.tenant!.id)

      for (const agent of agents ?? []) {
        agentMap.set(agent.user_id, agent)
      }
    }

    const enrichedComments = (comments ?? []).map(comment => {
      if (comment.author_type === 'agent') {
        const agentInfo = agentMap.get(comment.author_id)
        return {
          ...comment,
          author: agentInfo ? {
            user_metadata: {
              first_name: agentInfo.first_name,
              last_name: agentInfo.last_name,
            }
          } : null
        }
      }
      return comment
    })

    if (isCitizen && req.userId) {
      await supabaseAdmin
        .from('report_comments')
        .update({ read_by_citizen: true })
        .eq('report_id', reportId)
        .eq('author_type', 'agent')
        .eq('read_by_citizen', false)
    } else if (!isCitizen) {
      await supabaseAdmin
        .from('report_comments')
        .update({ read_by_agent: true })
        .eq('report_id', reportId)
        .eq('author_type', 'citizen')
        .eq('read_by_agent', false)
    }

    const agentMessages = enrichedComments
      .filter(c => c.parent_id === null)
      .map(c => ({
        ...c,
        replies: enrichedComments.filter(r => r.parent_id === c.id),
      }))

    res.json(agentMessages)
  } catch (err) {
    next(err)
  }
}

// ─── Agent poste un message ───────────────────────────────────────
export async function createAgentComment(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.tenant || !req.userId) throw notFound('Tenant')

    const { reportId } = req.params
    const { content, photoUrl, isResolutionPhoto } = req.body

    const { data: report, error: reportError } = await supabaseAdmin
      .from('reports')
      .select('id, status, title, user_id')
      .eq('id', reportId)
      .eq('tenant_id', req.tenant.id)
      .single()

    if (reportError || !report) throw notFound('Signalement')

    const citizenEmail = report.user_id
      ? await getAuthUserEmail(report.user_id)
      : null

    const { data: agentProfile } = await supabaseAdmin
      .from('tenant_users')
      .select('first_name, last_name, job_title')
      .eq('user_id', req.userId!)
      .eq('tenant_id', req.tenant.id)
      .single()

    const agentName = agentProfile
      ? [agentProfile.first_name, agentProfile.last_name].filter(Boolean).join(' ') || 'Admin'
      : 'Admin'

    const { data: comment, error } = await supabaseAdmin
      .from('report_comments')
      .insert({
        report_id: reportId,
        tenant_id: req.tenant.id,
        author_type: 'agent',
        author_id: req.userId!,
        content: content.trim(),
        photo_url: photoUrl ?? null,
        is_resolution_photo: isResolutionPhoto ?? false,
        parent_id: null,
        report_status_at_time: report.status,
        read_by_citizen: false,
        read_by_agent: true,
      })
      .select()
      .single()

    if (error || !comment) throw error ?? new AppError(500, 'internal_error', 'Erreur création commentaire.')

    // Independent of the e-mail: the citizen may have no address on file, and a
    // reply they never see is the failure this whole thread exists to avoid.
    if (report.user_id) {
      pushAgentComment({
        userId: report.user_id,
        tenantId: req.tenant.id,
        reportId,
        reportTitle: report.title,
        excerpt: content.trim(),
      }).catch(err => console.error('[Comments] Erreur push:', err))
    }

    if (citizenEmail) {
      await sendCommentNotification({
        to: citizenEmail,
        reportTitle: report.title,
        agentName,
        agentJobTitle: agentProfile?.job_title,
        message: content,
        tenantName: req.tenant.name,
        tenantSlug: req.tenant.slug,
        reportId,
        hasPhoto: !!photoUrl,
      }).catch(err => {
        console.error('Email notification error:', err)
      })
    }

    res.status(201).json(comment)
  } catch (err) {
    next(err)
  }
}

// ─── Citoyen répond à un message d'agent ─────────────────────────
export async function createCitizenComment(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.tenant || !req.userId) throw notFound('Tenant')

    const { reportId } = req.params
    const { content, parentId } = req.body

    const { data: report } = await supabaseAdmin
      .from('reports')
      .select('id, status, title, user_id')
      .eq('id', reportId)
      .eq('tenant_id', req.tenant.id)
      .eq('user_id', req.userId!)
      .single()

    if (!report) throw forbidden('Ce signalement ne vous appartient pas.')

    const { data: parent } = await supabaseAdmin
      .from('report_comments')
      .select('id, author_type, parent_id')
      .eq('id', parentId)
      .eq('report_id', reportId)
      .single()

    if (!parent) throw notFound('Message')

    if (parent.author_type !== 'agent') {
      throw new AppError(422, 'unprocessable', 'Vous ne pouvez répondre qu\'aux messages des agents.')
    }

    if (parent.parent_id !== null) {
      throw new AppError(422, 'unprocessable', 'Réponse imbriquée non autorisée.')
    }

    const { data: existingReply } = await supabaseAdmin
      .from('report_comments')
      .select('id')
      .eq('parent_id', parentId)
      .eq('author_id', req.userId!)
      .eq('author_type', 'citizen')
      .single()

    if (existingReply) {
      throw new AppError(422, 'unprocessable', 'Vous avez déjà répondu à ce message.')
    }

    const { data: comment, error } = await supabaseAdmin
      .from('report_comments')
      .insert({
        report_id: reportId,
        tenant_id: req.tenant.id,
        author_type: 'citizen',
        author_id: req.userId!,
        content: content.trim(),
        photo_url: null,
        is_resolution_photo: false,
        parent_id: parentId,
        report_status_at_time: report.status,
        read_by_citizen: true,
        read_by_agent: false,
      })
      .select()
      .single()

    if (error || !comment) throw error ?? new AppError(500, 'internal_error', 'Erreur création réponse.')

    res.status(201).json(comment)
  } catch (err) {
    next(err)
  }
}

// ─── Compteur non lus pour le dashboard ──────────────────────────
export async function getUnreadCount(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.tenant) throw notFound('Tenant')

    const { data, error } = await supabaseAdmin
      .from('report_comments')
      .select('report_id')
      .eq('tenant_id', req.tenant.id)
      .eq('author_type', 'citizen')
      .eq('read_by_agent', false)

    if (error) throw error

    const counts: Record<string, number> = {}
    ;(data ?? []).forEach(c => {
      counts[c.report_id] = (counts[c.report_id] ?? 0) + 1
    })

    res.json({ total: data?.length ?? 0, byReport: counts })
  } catch (err) {
    next(err)
  }
}

/**
 * Unread agent replies, for the signed-in citizen.
 *
 * `getUnreadCount` above answers the same question for an agent and is gated on
 * `requireTenantAdmin`, so a citizen app cannot use it — and should not: it
 * counts across the whole commune. This one is scoped to the caller's own
 * reports, which is the only thing a citizen may know about.
 *
 * Returns a per-report map as well as a total, so a list can badge individual
 * rows without a request each.
 */
export async function getMyUnreadCount(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!req.tenant) throw notFound('Tenant')

    const { data: myReports } = await supabaseAdmin
      .from('reports')
      .select('id')
      .eq('user_id', req.userId!)
      .eq('tenant_id', req.tenant.id)

    const reportIds = (myReports ?? []).map((report) => report.id)

    if (reportIds.length === 0) {
      res.json({ total: 0, byReport: {} })
      return
    }

    const { data, error } = await supabaseAdmin
      .from('report_comments')
      .select('report_id')
      .in('report_id', reportIds)
      .eq('tenant_id', req.tenant.id)
      .eq('author_type', 'agent')
      .eq('read_by_citizen', false)

    if (error) throw error

    const byReport: Record<string, number> = {}
    for (const row of data ?? []) {
      byReport[row.report_id] = (byReport[row.report_id] ?? 0) + 1
    }

    res.json({ total: data?.length ?? 0, byReport })
  } catch (err) {
    next(err)
  }
}
