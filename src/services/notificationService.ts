import { Resend } from 'resend'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { buildStatusEmail } from '../templates/statusNotification.js'
import { getAuthUserEmail } from '../lib/authHelpers.js'

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
