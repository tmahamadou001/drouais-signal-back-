import { Resend } from 'resend'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { buildStatusEmail } from '../templates/statusNotification.js'
import { buildServiceNotificationEmail, HANDOFF_PLACEHOLDER } from '../templates/serviceNotification.js'
import { getAuthUserEmail } from '../lib/authHelpers.js'
import { auditReportServiceNotified } from './auditService.js'
import { pushStatusChange } from './pushService.js'
import { resolveCategory } from './categoryService.js'
import { createHandoff, handoffUrl } from '../lib/serviceHandoff.js'
import { plainSubject } from '../templates/brand.js'
import { allowsEmail, unsubscribeUrl } from './notificationPreferences.js'

const resend = new Resend(process.env.RESEND_API_KEY)

interface StatusChangeParams {
  reportId: string
  reportTitle: string
  newStatus: 'en_attente' | 'transmis' | 'pris_en_charge' | 'resolu'
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

  // Vérifié après le push, et volontairement : les deux canaux sont réglables
  // séparément, et couper l'e-mail ne doit pas couper la notification dans
  // l'app. Un désabonnement global, lui, prime sur la grille — c'est la seule
  // préférence exprimable par un citoyen anonyme.
  if (!(await allowsEmail({ userId: params.userId, email: recipientEmail }, 'status'))) {
    console.log(`[Notification] E-mail refusé par le destinataire — ${params.reportId}`)
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

  // Le libellé de la commune s'il en a fixé un, le libellé national sinon.
  // Le template ne connaît plus la taxonomie : depuis la 026 elle vit en base.
  const category = await resolveCategory(params.tenantId, params.category)

  const html = buildStatusEmail({
    reportTitle: params.reportTitle,
    reportId: params.reportId,
    newStatus: params.newStatus,
    categoryLabel: category?.label ?? params.category,
    unsubscribeUrl: unsubscribeUrl(recipientEmail),
    addressApprox: params.addressApprox,
    photoUrl: params.photoUrl,
    createdAt: params.createdAt,
    frontendUrl: process.env.FRONTEND_URL || 'https://onsignale.fr',
    cityName,
    isAnonymous: params.isAnonymous,
    anonymousToken: params.anonymousToken,
  })

  const subjects: Record<StatusChangeParams['newStatus'], string> = {
    transmis:       `Votre signalement "${params.reportTitle.substring(0, 40)}" a été transmis au service`,
    pris_en_charge: `Votre signalement "${params.reportTitle.substring(0, 40)}" est pris en charge`,
    resolu:         `Votre signalement "${params.reportTitle.substring(0, 40)}" a été résolu`,
    en_attente:     `Mise à jour de votre signalement`,
  }

  const textVersions: Record<StatusChangeParams['newStatus'], string> = {
    // Transmis, pas pris en charge : l'e-mail est parti au service compétent,
    // personne n'a encore répondu. Promettre une intervention ici serait la
    // même erreur que celle que le quatrième statut vient corriger.
    transmis:       `Bonjour,\n\nVotre signalement "${params.reportTitle}" a été transmis au service compétent de la commune.\n\nVous serez prévenu dès qu'il est pris en charge.\n\nCordialement,\nL'équipe OnSignale`,
    pris_en_charge: `Bonjour,\n\nBonne nouvelle ! Votre signalement "${params.reportTitle}" a été pris en charge par les services municipaux.\n\nIls vont intervenir prochainement pour résoudre ce problème.\n\nVous pouvez suivre l'évolution de votre signalement sur OnSignale.\n\nCordialement,\nL'équipe OnSignale`,
    resolu:         `Bonjour,\n\nVotre signalement "${params.reportTitle}" a été résolu par les services municipaux.\n\nMerci pour votre contribution à l'amélioration de votre ville !\n\nVous pouvez consulter les détails de la résolution sur OnSignale.\n\nCordialement,\nL'équipe OnSignale`,
    en_attente:     `Bonjour,\n\nVotre signalement "${params.reportTitle}" est en attente de traitement.\n\nNous vous tiendrons informé de son évolution.\n\nCordialement,\nL'équipe OnSignale`,
  }

  try {
    const { error } = await resend.emails.send({
      from: 'OnSignale <notifications@onsignale.fr>',
      to: recipientEmail,
      subject: plainSubject(subjects[params.newStatus]),
      html,
      text: textVersions[params.newStatus],
      headers: {
        'X-Entity-Ref-ID': params.reportId,
        // Gmail et Yahoo affichent cet en-tête comme un bouton « Se
        // désabonner » et exigent qu'il fonctionne réellement — un lien mort
        // dégrade la délivrabilité de tout le domaine. Le POST est ce qui les
        // laisse désabonner sans ouvrir de navigateur.
        'List-Unsubscribe': `<${unsubscribeUrl(recipientEmail)}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
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

/**
 * Transmet un signalement à un service extérieur.
 *
 * `recipients` permet à un agent de transmettre à la main, vers une adresse que
 * la catégorie ne connaît pas encore : la transmission était un effet de bord
 * de la création, donc impossible à déclencher plus tard — quand le destinataire
 * est configuré après coup, quand l'agent juge que ça relève finalement de la
 * régie, ou quand le premier envoi a échoué.
 *
 * Rend `true` si au moins un e-mail est parti : l'appelant a besoin de le
 * savoir pour ne pas annoncer une transmission qui n'a pas eu lieu.
 */
export async function sendServiceNotification(
  params: ServiceNotificationParams & {
    recipients?: string[]
    serviceName?: string | null
    /**
     * Le statut au moment de l'envoi, quand l'appelant le connaît.
     *
     * Il décide si la transmission fait **avancer** le signalement ou
     * seulement relayer l'information. Absent = dépôt, donc `en_attente`.
     */
    currentStatus?: string
  }
): Promise<boolean> {
  // `reports.category` porte le slug **canonique** depuis la migration 026,
  // alors que `tenant_categories.slug` garde encore le slug local d'origine
  // (`eclairage` chez Dreux). Chercher par `slug` ne trouvait plus rien, et le
  // service municipal cessait d'être prévenu sans la moindre erreur.
  const cat = await resolveCategory(params.tenantId, params.category)
  if (!cat) return false

  const recipients = params.recipients?.length ? params.recipients : cat.service_emails
  const serviceName = params.serviceName ?? cat.service_name ?? cat.label

  if (!recipients?.length) return false

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

  /**
   * Un lien d'action par destinataire.
   *
   * Par destinataire et non par service : c'est ce qui permet de savoir, dans
   * les logs d'audit, dans quelle boîte se trouvait le lien qui a été cliqué.
   * Un jeton partagé rendrait chaque action anonyme.
   */
  const links = new Map<string, string>()
  for (const recipient of recipients) {
    const token = await createHandoff({
      reportId: params.reportId,
      tenantId: params.tenantId,
      recipient,
      serviceName,
      category: cat.slug,
    })
    if (token) links.set(recipient, handoffUrl(token))
  }

  const { html, text } = buildServiceNotificationEmail({
    recipientEmails: recipients,
    serviceName,
    tenantName: tenant?.name ?? 'OnSignale',
    tenantSlug: params.tenantSlug,
    cityName: config?.city_name ?? tenant?.name ?? 'la ville',
    reportId: params.reportId,
    reportTitle: params.reportTitle,
    category: cat.label,
    description: params.description,
    addressApprox: params.addressApprox,
    photoUrl: params.photoUrl,
    createdAt: params.createdAt,
    isAnonymous: params.isAnonymous,
  })

  try {
    /**
     * Un e-mail par destinataire, et non un envoi groupé.
     *
     * Chacun porte son propre lien d'action : un envoi unique en copie les
     * obligerait à partager le même jeton, et la trace d'audit ne dirait plus
     * qui a agi. C'est aussi ce qui évite de divulguer à chaque service les
     * adresses des autres.
     */
    const results = await Promise.all(
      recipients.map((recipient) =>
        resend.emails.send({
          from: 'OnSignale <notifications@onsignale.fr>',
          to: [recipient],
          // Pas d'icône : un emoji dans un objet se dessine différemment sur
          // chaque plateforme, et plusieurs filtres d'entreprise le comptent
          // comme un signe promotionnel — sur un message opérationnel adressé
          // à un service, c'est exactement ce qu'il ne faut pas.
          subject: plainSubject(`[${cat.label}] Nouveau signalement — ${params.reportTitle.substring(0, 60)}`),
          html: html.replace(HANDOFF_PLACEHOLDER, links.get(recipient) ?? ''),
          text: text.replace(HANDOFF_PLACEHOLDER, links.get(recipient) ?? ''),
          tags: [
            { name: 'type',     value: 'service_notification' },
            { name: 'category', value: params.category },
          ],
        })
      )
    )

    const delivered = results.filter((result) => !result.error)

    if (delivered.length === 0) {
      console.error('[ServiceNotif] Aucun envoi abouti :', results.map((r) => r.error))
      return false
    }

    console.log(`[ServiceNotif] Email envoyé → ${recipients.join(', ')} (${params.category})`)

    auditReportServiceNotified({
      reportId:      params.reportId,
      reportTitle:   params.reportTitle,
      category:      params.category,
      serviceName,
      serviceEmails: recipients,
      tenantId:      params.tenantId,
      tenantSlug:    params.tenantSlug,
    }).catch(err => console.error('[ServiceNotif] Erreur audit:', err))

    /**
     * L'e-mail est parti : le signalement est **transmis**, pas pris en charge.
     *
     * Il l'était, et c'était faux sur les deux plans. Pour l'habitant, « Pris
     * en charge » signifie que quelqu'un s'en occupe, alors que personne
     * n'avait encore rien lu. Pour la commune, le délai moyen de prise en
     * charge — celui qu'on montre aux élus — mesurait la latence de Resend.
     *
     * `pris_en_charge` appartient désormais au geste qui le mérite : un agent
     * dans le back-office, ou le service qui clique « je m'en occupe ».
     */
    /**
     * Et seulement depuis « En attente ».
     *
     * Transmettre un signalement dont un agent s'occupe déjà est légitime — il
     * découvre que ça relève de la régie, ou le premier envoi n'a rien donné —
     * mais ce n'est pas un recul du traitement. Écrire `transmis` par-dessus
     * `pris_en_charge` faisait perdre à l'habitant l'information qu'on lui
     * avait déjà donnée, et remettait le délai de prise en charge à zéro dans
     * les statistiques. L'e-mail part, le lien d'action existe, la trace est
     * dans l'audit : le statut, lui, ne bouge pas.
     */
    const status = params.currentStatus ?? 'en_attente'
    if (status !== 'en_attente') {
      console.log(`[ServiceNotif] Statut inchangé (${status}) — relais, pas transmission initiale`)
      return true
    }

    const { error: rpcError } = await supabaseAdmin.rpc('update_report_status_atomic', {
      p_report_id:  params.reportId,
      p_new_status: 'transmis',
      p_agent_id:   null, // changement système, pas un agent humain
      p_tenant_id:  params.tenantId,
      p_comment:    'Transmis automatiquement au service concerné',
    })

    if (rpcError) {
      // L'e-mail est parti : dire le contraire à l'appelant serait pire que de
      // laisser le statut en arrière.
      console.error('[ServiceNotif] Erreur mise à jour statut:', rpcError)
      return true
    }

    console.log(`[ServiceNotif] Statut → transmis (${params.reportId})`)

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
        newStatus:     'transmis',
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

    return true
  } catch (err) {
    console.error('[ServiceNotif] Exception Resend:', err)
    return false
  }
}
