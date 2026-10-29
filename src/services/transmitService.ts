import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { resolveCategory } from './categoryService.js'
import { sendServiceNotification } from './notificationService.js'
import { isFinal } from '../lib/statusFlow.js'

/**
 * Transmettre un signalement à un service extérieur.
 *
 * Le geste vivait dans la route, ce qui allait à peu près tant qu'il n'existait
 * qu'à l'unité. La transmission groupée en fait le même geste répété : le
 * mettre ici évite d'en écrire une deuxième version — et deux versions d'un
 * envoi d'e-mail finissent toujours par diverger sur le cas qui compte.
 */

/** Les colonnes dont l'e-mail de service a besoin, et rien de plus. */
const TRANSMIT_COLUMNS =
  'id, reference, title, category, status, description, address_approx, photo_url, created_at, is_anonymous'

export interface TransmitOutcome {
  id: string
  reference: string | null
  ok: boolean
  reason?: string
}

interface TransmitOptions {
  tenantId: string
  tenantSlug: string
  recipients?: string[]
  serviceName?: string
  /** Enregistrer les adresses sur la catégorie, pour les prochaines fois. */
  remember?: boolean
}

/**
 * Mémorise les adresses sur la catégorie du signalement.
 *
 * C'est ce qui transforme un geste ponctuel en réglage : la prochaine fois, la
 * transmission partira toute seule au dépôt. Écrit **avant** l'envoi — l'e-mail
 * peut échouer, la décision de l'agent reste.
 */
async function rememberRecipients(
  tenantId: string,
  categorySlug: string,
  recipients: string[],
  serviceName?: string
): Promise<void> {
  const category = await resolveCategory(tenantId, categorySlug)
  const merged = [...new Set([...(category?.service_emails ?? []), ...recipients])]

  await supabaseAdmin
    .from('tenant_categories')
    .update({
      service_emails: merged,
      ...(serviceName ? { service_name: serviceName } : {}),
    })
    .eq('tenant_id', tenantId)
    .eq('category_slug', categorySlug)
}

/**
 * Transmet un signalement, et dit ce qui s'est passé.
 *
 * Rend un résultat plutôt que de jeter : appelée en boucle par la transmission
 * groupée, une exception sur le troisième signalement priverait l'agent du
 * sort des deux premiers.
 */
export async function transmitReport(
  reportId: string,
  options: TransmitOptions
): Promise<TransmitOutcome> {
  const { data: report } = await supabaseAdmin
    .from('reports')
    .select(TRANSMIT_COLUMNS)
    .eq('id', reportId)
    .eq('tenant_id', options.tenantId)
    .single<{
      id: string
      reference: string | null
      title: string
      category: string
      status: string
      description: string | null
      address_approx: string | null
      photo_url: string | null
      created_at: string
      is_anonymous: boolean | null
    }>()

  if (!report) {
    return { id: reportId, reference: null, ok: false, reason: 'Signalement introuvable.' }
  }

  // Un signalement clos n'a plus rien à confier à personne.
  if (isFinal(report.status)) {
    return { id: reportId, reference: report.reference, ok: false, reason: 'Signalement déjà résolu.' }
  }

  if (options.remember && options.recipients?.length) {
    await rememberRecipients(options.tenantId, report.category, options.recipients, options.serviceName)
  }

  const sent = await sendServiceNotification({
    reportId: report.id,
    reportTitle: report.title,
    category: report.category,
    description: report.description,
    addressApprox: report.address_approx,
    photoUrl: report.photo_url,
    createdAt: report.created_at,
    isAnonymous: report.is_anonymous ?? false,
    tenantId: options.tenantId,
    tenantSlug: options.tenantSlug,
    recipients: options.recipients,
    serviceName: options.serviceName,
    currentStatus: report.status,
  })

  return sent
    ? { id: reportId, reference: report.reference, ok: true }
    : {
        id: reportId,
        reference: report.reference,
        ok: false,
        reason: 'Aucun destinataire, ou l’e-mail n’a pas pu partir.',
      }
}

/**
 * Transmet une sélection, en série.
 *
 * En série et non en parallèle : chaque transmission crée un lien d'action par
 * destinataire et envoie un e-mail, et cinquante d'un coup ne feraient que
 * heurter les limites de Resend — pour un geste que l'agent lance une fois et
 * regarde aboutir.
 */
export async function transmitReports(
  ids: string[],
  options: TransmitOptions
): Promise<TransmitOutcome[]> {
  const outcomes: TransmitOutcome[] = []
  for (const id of ids) {
    outcomes.push(await transmitReport(id, options))
  }
  return outcomes
}
