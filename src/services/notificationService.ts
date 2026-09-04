import { Resend } from 'resend'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { buildStatusEmail } from '../templates/statusNotification.js'
import { buildServiceNotificationEmail } from '../templates/serviceNotification.js'
import { getAuthUserEmail } from '../lib/authHelpers.js'
import { auditReportServiceNotified } from './auditService.js'
import { pushStatusChange } from './pushService.js'

const resend = new Resend(process.env.RESEND_API_KEY)

interface StatusChangeParams {
  reportId: string
  reportTitle: string
  newStatus: 'en_attente' | 'pris_en_charge' | 'resolu'
  previousStatus: string
  category: string
  addressApprox: string | null
  photoUrl: string | null
  createdAt: string
  userId: string | null
  tenantId?: string | null
  isAnonymous?: boolean
  anonymousToken?: string | null
}

export async function sendStatusChangeNotification(
  params: StatusChangeParams
): Promise<void> {

  if (params.newStatus === params.previousStatus) {
    console.log(`[Notification] Statut inchangé pour ${params.reportId} — notification ignorée`)
    return
  }

  if (params.newStatus === 'en_attente') {
    console.log(`[Notification] Retour en_attente pour ${params.reportId} — notification ignorée`)
    return
  }

  let recipientEmail: string | null = null

  if (params.userId) {
    recipientEmail = await getAuthUserEmail(params.userId)
  }

  if (!params.userId && params.isAnonymous) {
    // Pour les signalements anonymes, l'email est éventuellement stocké dans reports.anonymous_email
    const { data } = await supabaseAdmin
      .from('reports')
      .select('anonymous_email')
      .eq('id', params.reportId)
      .single()
    recipientEmail = data?.anonymous_email ?? null
  }

  // Push first, and independently of the e-mail: a citizen with the app and no
  // address on file should still hear about their own report.
  if (params.userId && params.tenantId) {
    pushStatusChange({
      userId: params.userId,
      tenantId: params.tenantId,
      reportId: params.reportId,
      reportTitle: params.reportTitle,
      newStatus: params.newStatus,
    }).catch(err => console.error('[Notification] Erreur push:', err))
  }

  if (!recipientEmail) {
    console.log(`[Notification] Pas d'email pour le signalement ${params.reportId} — notification ignorée`)
    return
  }

  let cityName: string | undefined
  if (params.tenantId) {
    const { data } = await supabaseAdmin
      .from('tenant_configs')
      .select('city_name')
      .eq('tenant_id', params.tenantId)
      .single()
    cityName = data?.city_name ?? undefined
  }

  const html = buildStatusEmail({
    reportTitle: params.reportTitle,
    reportId: params.reportId,
    newStatus: params.newStatus,
    category: params.category,
    addressApprox: params.addressApprox,
    photoUrl: params.photoUrl,
    createdAt: params.createdAt,
    frontendUrl: process.env.FRONTEND_URL || 'https://onsignale.fr',
    cityName,
    isAnonymous: params.isAnonymous,
    anonymousToken: params.anonymousToken,
  })

  const subjects: Record<StatusChangeParams['newStatus'], string> = {
    pris_en_charge: `Votre signalement "${params.reportTitle.substring(0, 40)}" est pris en charge`,
    resolu:         `Votre signalement "${params.reportTitle.substring(0, 40)}" a été résolu`,
    en_attente:     `Mise à jour de votre signalement`,
  }

  const textVersions: Record<StatusChangeParams['newStatus'], string> = {
    pris_en_charge: `Bonjour,\n\nBonne nouvelle ! Votre signalement "${params.reportTitle}" a été pris en charge par les services municipaux.\n\nIls vont intervenir prochainement pour résoudre ce problème.\n\nVous pouvez suivre l'évolution de votre signalement sur OnSignale.\n\nCordialement,\nL'équipe OnSignale`,
    resolu:         `Bonjour,\n\nVotre signalement "${params.reportTitle}" a été résolu par les services municipaux.\n\nMerci pour votre contribution à l'amélioration de votre ville !\n\nVous pouvez consulter les détails de la résolution sur OnSignale.\n\nCordialement,\nL'équipe OnSignale`,
    en_attente:     `Bonjour,\n\nVotre signalement "${params.reportTitle}" est en attente de traitement.\n\nNous vous tiendrons informé de son évolution.\n\nCordialement,\nL'équipe OnSignale`,
  }

  try {
    const { error } = await resend.emails.send({
      from: 'OnSignale <notifications@onsignale.fr>',
      to: recipientEmail,
      subject: subjects[params.newStatus],
      html,
      text: textVersions[params.newStatus],
      headers: {
        'X-Entity-Ref-ID': params.reportId,
        'List-Unsubscribe': `<${process.env.FRONTEND_URL || 'https://onsignale.fr'}/parametres/notifications>`,
        'X-Priority': '3',
      },
      tags: [
        { name: 'type',   value: 'status_notification' },
        { name: 'status', value: params.newStatus },
      ],
    })

    if (error) {
      console.error('[Notification] Erreur Resend:', error)
    } else {
      console.log(`[Notification] Email envoyé → ${params.reportId} (${params.newStatus})`)
    }
  } catch (err) {
    console.error('[Notification] Exception Resend:', err)
  }
}

// ─── Notification service municipal à la création d'un signalement ───────────

interface ServiceNotificationParams {
  reportId: string
  reportTitle: string
  category: string
  description?: string | null
  addressApprox?: string | null
  photoUrl?: string | null
  createdAt: string
  isAnonymous: boolean
  tenantId: string
  tenantSlug: string
}

export async function sendServiceNotification(params: ServiceNotificationParams): Promise<void> {
  // Récupère la catégorie avec ses emails de service
  const { data: cat } = await supabaseAdmin
    .from('tenant_categories')
    .select('slug, label, icon, service_name, service_emails')
    .eq('tenant_id', params.tenantId)
    .eq('slug', params.category)
    .single()

  if (!cat?.service_emails?.length) return

  // Récupère la config tenant (city_name, name)
  const { data: config } = await supabaseAdmin
    .from('tenant_configs')
    .select('city_name')
    .eq('tenant_id', params.tenantId)
    .single()

  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('name')
    .eq('id', params.tenantId)
    .single()

  const { html, text } = buildServiceNotificationEmail({
    recipientEmails: cat.service_emails,
    serviceName: cat.service_name ?? cat.label,
    tenantName: tenant?.name ?? 'OnSignale',
    tenantSlug: params.tenantSlug,
    cityName: config?.city_name ?? tenant?.name ?? 'la ville',
    reportId: params.reportId,
    reportTitle: params.reportTitle,
    category: cat.label,
    categoryIcon: cat.icon ?? '📌',
    description: params.description,
    addressApprox: params.addressApprox,
    photoUrl: params.photoUrl,
    createdAt: params.createdAt,
    isAnonymous: params.isAnonymous,
  })

  try {
    const { error } = await resend.emails.send({
      from: 'OnSignale <notifications@onsignale.fr>',
      to: cat.service_emails,
      subject: `[${cat.icon ?? '📌'} ${cat.label}] Nouveau signalement — ${params.reportTitle.substring(0, 60)}`,
      html,
      text,
      tags: [
        { name: 'type',     value: 'service_notification' },
        { name: 'category', value: params.category },
      ],
    })

    if (error) {
      console.error('[ServiceNotif] Erreur Resend:', error)
      return
    }

    console.log(`[ServiceNotif] Email envoyé → ${cat.service_emails.join(', ')} (${params.category})`)

    auditReportServiceNotified({
      reportId:      params.reportId,
      reportTitle:   params.reportTitle,
      category:      params.category,
      serviceName:   cat.service_name ?? cat.label,
      serviceEmails: cat.service_emails,
      tenantId:      params.tenantId,
      tenantSlug:    params.tenantSlug,
    }).catch(err => console.error('[ServiceNotif] Erreur audit:', err))

    // Email transmis avec succès → passage automatique en "pris_en_charge"
    const { error: rpcError } = await supabaseAdmin.rpc('update_report_status_atomic', {
      p_report_id:  params.reportId,
      p_new_status: 'pris_en_charge',
      p_agent_id:   null, // changement système, pas un agent humain
      p_tenant_id:  params.tenantId,
      p_comment:    'Transmis automatiquement au service concerné',
    })

    if (rpcError) {
      console.error('[ServiceNotif] Erreur mise à jour statut:', rpcError)
      return
    }

    console.log(`[ServiceNotif] Statut → pris_en_charge (${params.reportId})`)

    // Notifier le créateur du signalement du changement de statut
    const { data: report } = await supabaseAdmin
      .from('reports')
      .select('user_id, is_anonymous, anonymous_token, created_at, address_approx, photo_url')
      .eq('id', params.reportId)
      .single()

    if (report) {
      sendStatusChangeNotification({
        reportId:      params.reportId,
        reportTitle:   params.reportTitle,
        newStatus:     'pris_en_charge',
        previousStatus: 'en_attente',
        category:      params.category,
        addressApprox: report.address_approx ?? null,
        photoUrl:      report.photo_url ?? null,
        createdAt:     report.created_at,
        userId:        report.user_id ?? null,
        tenantId:      params.tenantId,
        isAnonymous:   report.is_anonymous ?? params.isAnonymous,
        anonymousToken: report.anonymous_token ?? null,
      }).catch(err => console.error('[ServiceNotif] Erreur notification créateur:', err))
    }
  } catch (err) {
    console.error('[ServiceNotif] Exception Resend:', err)
  }
}
