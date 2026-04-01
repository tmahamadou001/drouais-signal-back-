import { Resend } from 'resend'
import { createClient } from '@supabase/supabase-js'
import { buildStatusEmail } from '../templates/statusNotification'

const resend = new Resend(process.env.RESEND_API_KEY)

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

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
  let recipientName: string = 'Citoyen'

  if (params.userId) {
    try {
      const { data: userData, error } =
        await supabaseAdmin.auth.admin.getUserById(params.userId)

      if (!error && userData.user?.email) {
        recipientEmail = userData.user.email
        recipientName =
          userData.user.user_metadata?.name ||
          userData.user.email.split('@')[0]
      }
    } catch (err) {
      console.error('[Notification] Erreur récupération user:', err)
    }
  }

  if (!recipientEmail) {
    console.log(
      `[Notification] Pas d'email pour le signalement ${params.reportId} — notification ignorée` 
    )
    return
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
  })

  const subjects = {
    pris_en_charge: `Votre signalement "${params.reportTitle.substring(0, 40)}" est pris en charge`,
    resolu: `Votre signalement "${params.reportTitle.substring(0, 40)}" a été résolu`,
    en_attente: `Mise à jour de votre signalement`,
  }

  const textVersions = {
    pris_en_charge: `Bonjour,\n\nBonne nouvelle ! Votre signalement "${params.reportTitle}" a été pris en charge par les services municipaux.\n\nIls vont intervenir prochainement pour résoudre ce problème.\n\nVous pouvez suivre l'évolution de votre signalement sur OnSignale.\n\nCordialement,\nL'équipe OnSignale`,
    resolu: `Bonjour,\n\nVotre signalement "${params.reportTitle}" a été résolu par les services municipaux.\n\nMerci pour votre contribution à l'amélioration de votre ville !\n\nVous pouvez consulter les détails de la résolution sur OnSignale.\n\nCordialement,\nL'équipe OnSignale`,
    en_attente: `Bonjour,\n\nVotre signalement "${params.reportTitle}" est en attente de traitement.\n\nNous vous tiendrons informé de son évolution.\n\nCordialement,\nL'équipe OnSignale`,
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
        { name: 'type', value: 'status_notification' },
        { name: 'status', value: params.newStatus },
      ],
    })

    if (error) {
      console.error('[Notification] Erreur Resend:', error)
    } else {
      console.log(
        `[Notification] Email envoyé à ${recipientEmail} — ` +
        `signalement ${params.reportId} → ${params.newStatus}` 
      )
    }
  } catch (err) {
    console.error('[Notification] Exception Resend:', err)
  }
}
