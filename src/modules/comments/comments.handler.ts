import type { Request, Response } from 'express'
import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { sendCommentNotification } from './comments.email.js'

// ─── Lister les commentaires d'un signalement ────────────────────
export async function getComments(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.tenant) {
    res.status(404).json({ error: 'Tenant introuvable' })
    return
  }

  const { reportId } = req.params

  // Vérifier que le signalement appartient au tenant
  const { data: report } = await supabaseAdmin
    .from('reports')
    .select('id, user_id, status')
    .eq('id', reportId)
    .eq('tenant_id', req.tenant.id)
    .single()

  if (!report) {
    res.status(404).json({ error: 'Signalement introuvable' })
    return
  }

  // Vérifier les droits d'accès du citoyen
  const userRole = req.userRole
  const isCitizen =
    userRole === 'citizen' ||
    (!userRole && req.userId)

  if (isCitizen && report.user_id !== req.userId) {
    res.status(403).json({
      error: 'Accès non autorisé',
    })
    return
  }

  // Récupérer les commentaires (messages agents + leurs réponses citoyens)
  const { data: comments, error } =
    await supabaseAdmin
      .from('report_comments')
      .select('*')
      .eq('report_id', reportId)
      .eq('tenant_id', req.tenant.id)
      .order('created_at', { ascending: true })

  if (error) {
    console.error('Error fetching comments:', error)
    res.status(500).json({ error: 'Erreur serveur' })
    return
  }

  // Enrichir les commentaires avec les infos des agents
  const enrichedComments = await Promise.all(
    (comments ?? []).map(async (comment) => {
      if (comment.author_type === 'agent') {
        // Récupérer les infos de l'agent depuis tenant_users
        const { data: agentInfo } = await supabaseAdmin
          .from('tenant_users')
          .select('first_name, last_name, job_title')
          .eq('user_id', comment.author_id)
          .eq('tenant_id', req.tenant!.id)
          .single()
        
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
  )

  // Marquer comme lu selon le type d'utilisateur
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

  // Structurer : messages agents + réponses imbriquées
  const agentMessages = enrichedComments
    .filter(c => c.parent_id === null)
    .map(c => ({
      ...c,
      replies: enrichedComments
        .filter(r => r.parent_id === c.id),
    }))

  res.json(agentMessages)
}

// ─── Agent poste un message ───────────────────────────────────────
export async function createAgentComment(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.tenant || !req.userId) {
    res.status(404).json({ error: 'Tenant introuvable' })
    return
  }

  const { reportId } = req.params
  const { content, photoUrl, isResolutionPhoto } =
    req.body

  // Récupérer le signalement
  const { data: report, error: reportError } = await supabaseAdmin
    .from('reports')
    .select('id, status, title, user_id')
    .eq('id', reportId)
    .eq('tenant_id', req.tenant.id)
    .single()

  if (reportError || !report) {
    console.error('Error fetching report:', reportError)
    res.status(404).json({ error: 'Signalement introuvable' })
    return
  }

  // Récupérer l'email du citoyen depuis auth.users
  let citizenEmail: string | null = null
  if (report.user_id) {
    const { data: userData } = await supabaseAdmin.auth.admin.getUserById(report.user_id)
    citizenEmail = userData?.user?.email ?? null
  }

  // Récupérer le nom de l'agent
  const { data: agentProfile } =
    await supabaseAdmin
      .from('tenant_users')
      .select('first_name, last_name, job_title')
      .eq('user_id', req.userId!)
      .eq('tenant_id', req.tenant.id)
      .single()

  const agentName = agentProfile
    ? [agentProfile.first_name, agentProfile.last_name]
        .filter(Boolean).join(' ') ||
        'Agent municipal'
    : 'Agent municipal'

  // Créer le commentaire
  const { data: comment, error } =
    await supabaseAdmin
      .from('report_comments')
      .insert({
        report_id: reportId,
        tenant_id: req.tenant.id,
        author_type: 'agent',
        author_id: req.userId!,
        content: content.trim(),
        photo_url: photoUrl ?? null,
        is_resolution_photo:
          isResolutionPhoto ?? false,
        parent_id: null,
        report_status_at_time: report.status,
        read_by_citizen: false,
        read_by_agent: true,
      })
      .select()
      .single()

  if (error || !comment) {
    console.error('Error creating comment:', error)
    res.status(500).json({ error: 'Erreur serveur' })
    return
  }

  // Notifier le citoyen par email si il existe et a un email
  if (citizenEmail) {
    await sendCommentNotification({
      to: citizenEmail,
      reportTitle: report.title,
      agentName,
      agentJobTitle: agentProfile?.job_title,
      message: content,
      tenantName: req.tenant.name,
      reportId,
      hasPhoto: !!photoUrl,
    }).catch(err => {
      // Ne pas bloquer si l'email échoue
      console.error('Email notification error:', err)
    })
  }

  res.status(201).json(comment)
}

// ─── Citoyen répond à un message d'agent ─────────────────────────
export async function createCitizenComment(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.tenant || !req.userId) {
    res.status(404).json({ error: 'Tenant introuvable' })
    return
  }

  const { reportId } = req.params
  const { content, parentId } = req.body

  // Vérifier que le signalement appartient au citoyen connecté
  const { data: report } = await supabaseAdmin
    .from('reports')
    .select('id, status, title, user_id')
    .eq('id', reportId)
    .eq('tenant_id', req.tenant.id)
    .eq('user_id', req.userId!)
    .single()

  if (!report) {
    res.status(403).json({
      error: 'Ce signalement ne vous appartient pas',
    })
    return
  }

  // Vérifier que le parent existe et est un message d'agent
  const { data: parent } = await supabaseAdmin
    .from('report_comments')
    .select('id, author_type, parent_id')
    .eq('id', parentId)
    .eq('report_id', reportId)
    .single()

  if (!parent) {
    res.status(404).json({
      error: 'Message introuvable',
    })
    return
  }

  if (parent.author_type !== 'agent') {
    res.status(422).json({
      error: 'Vous ne pouvez répondre qu\'aux messages des agents',
    })
    return
  }

  if (parent.parent_id !== null) {
    res.status(422).json({
      error: 'Réponse imbriquée non autorisée',
    })
    return
  }

  // Vérifier que le citoyen n'a pas déjà répondu à ce message
  const { data: existingReply } =
    await supabaseAdmin
      .from('report_comments')
      .select('id')
      .eq('parent_id', parentId)
      .eq('author_id', req.userId!)
      .eq('author_type', 'citizen')
      .single()

  if (existingReply) {
    res.status(422).json({
      error: 'Vous avez déjà répondu à ce message',
    })
    return
  }

  // Créer la réponse
  const { data: comment, error } =
    await supabaseAdmin
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

  if (error || !comment) {
    console.error('Error creating citizen reply:', error)
    res.status(500).json({ error: 'Erreur serveur' })
    return
  }

  res.status(201).json(comment)
}

// ─── Compteur non lus pour le dashboard ──────────────────────────
// Retourne le nb de réponses citoyens non lues
// par signalement pour l'agent connecté
export async function getUnreadCount(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.tenant) {
    res.status(404).json({ error: 'Tenant introuvable' })
    return
  }

  const { data, error } = await supabaseAdmin
    .from('report_comments')
    .select('report_id')
    .eq('tenant_id', req.tenant.id)
    .eq('author_type', 'citizen')
    .eq('read_by_agent', false)

  if (error) {
    console.error('Error fetching unread count:', error)
    res.status(500).json({ error: 'Erreur serveur' })
    return
  }

  // Grouper par report_id
  const counts: Record<string, number> = {}
  ;(data ?? []).forEach(c => {
    counts[c.report_id] =
      (counts[c.report_id] ?? 0) + 1
  })

  res.json({
    total: data?.length ?? 0,
    byReport: counts,
  })
}
