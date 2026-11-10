import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { Resend } from 'resend'
import { plainSubject } from '../templates/brand.js'
import { buildCommuneLaunchEmail } from '../templates/communeLaunch.js'
import { auditCommuneLaunched } from './auditService.js'

/**
 * Ce qui se passe le jour où une commune prospect signe.
 *
 * Deux gestes, et ils étaient tous les deux manquants : la migration 025 avait
 * prévu la place — `reports.is_published`, `commune_waitlist.notified_at` — mais
 * rien ne l'occupait. Une commune serait donc passée en `active` sans voir
 * arriver un seul signalement, et les habitants inscrits n'auraient jamais été
 * prévenus, alors que l'écran le leur promet en toutes lettres.
 *
 * Les deux sont volontairement **séparés** du changement de statut lui-même.
 * `is_published` n'est pas une vue sur `tenants.status` mais une colonne, pour
 * que la bascule ne publie pas en silence ; et l'envoi d'e-mails ne doit pas
 * pouvoir faire échouer l'activation.
 */

// Même instanciation que partout ailleurs : il n'y a pas de client partagé
// dans ce dépôt, chaque module crée le sien.
const resend = new Resend(process.env.RESEND_API_KEY)

/** L'accueil public, où mène le bouton de l'e-mail. */
const WEB_URL = process.env.CLIENT_URL?.startsWith('https://')
  ? process.env.CLIENT_URL
  : 'https://onsignale.fr'

/**
 * Publie l'historique reçu pendant que la commune était prospect.
 *
 * Ces signalements existent, ils ont un auteur, ils ont été déposés de bonne
 * foi — ils étaient simplement invisibles de tous sauf d'eux. Les publier est
 * ce qui donne à la commune qui signe quelque chose à traiter dès le premier
 * jour, et c'est l'argument qui l'a convaincue.
 */
export async function publishTenantHistory(tenantId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('reports')
    .update({ is_published: true })
    .eq('tenant_id', tenantId)
    .eq('is_published', false)
    .select('id')

  if (error) {
    console.error('[Lancement] Publication de l’historique impossible :', error.message)
    return 0
  }

  return data?.length ?? 0
}

/**
 * Prévient les habitants inscrits sur la liste d'attente de cette commune.
 *
 * `notified_at` est posé **par adresse réellement envoyée**, pas en bloc :
 * si Resend refuse une adresse, elle reste à prévenir plutôt que d'être
 * comptée comme traitée. Et une seconde bascule ne réveille personne, puisque
 * la requête ne prend que les lignes non notifiées.
 *
 * Les erreurs ne remontent pas : l'activation d'une commune ne doit pas échouer
 * parce qu'un serveur de messagerie répond mal.
 */
export async function notifyCommuneWaitlist(params: {
  tenantId: string
  tenantName: string
}): Promise<{ sent: number; failed: number }> {
  const { data: territories } = await supabaseAdmin
    .from('tenant_territories')
    .select('insee_code')
    .eq('tenant_id', params.tenantId)

  const inseeCodes = (territories ?? []).map((t) => t.insee_code)
  if (inseeCodes.length === 0) return { sent: 0, failed: 0 }

  const { data: waiting, error } = await supabaseAdmin
    .from('commune_waitlist')
    .select('id, email, commune_name')
    .in('insee_code', inseeCodes)
    .is('notified_at', null)

  if (error) {
    console.error('[Lancement] Liste d’attente illisible :', error.message)
    return { sent: 0, failed: 0 }
  }

  if (!waiting || waiting.length === 0) return { sent: 0, failed: 0 }

  let sent = 0
  let failed = 0

  for (const entry of waiting) {
    // Le nom laissé à l'inscription prime : c'est celui que la personne
    // connaît, et il peut différer du nom commercial du tenant.
    const communeName = entry.commune_name ?? params.tenantName
    const { html, text } = buildCommuneLaunchEmail({ communeName, webUrl: WEB_URL })

    try {
      const { error: sendError } = await resend.emails.send({
        from: 'OnSignale <notifications@onsignale.fr>',
        to: entry.email,
        subject: plainSubject(`${communeName} a rejoint OnSignale`),
        html,
        text,
      })

      if (sendError) throw new Error(sendError.message)

      await supabaseAdmin
        .from('commune_waitlist')
        .update({ notified_at: new Date().toISOString() })
        .eq('id', entry.id)

      sent += 1
    } catch (err) {
      failed += 1
      console.error(
        '[Lancement] Envoi impossible :',
        err instanceof Error ? err.message : err
      )
    }
  }

  return { sent, failed }
}

/**
 * Le lancement d'une commune, en un geste.
 *
 * Appelé sans être attendu par la route de bascule : l'activation est déjà
 * enregistrée quand ceci démarre, et ni la publication ni les e-mails ne
 * doivent pouvoir la faire échouer. Tout ce qui se passe ici se lit ensuite
 * dans l'audit — y compris quand rien n'a pu partir.
 */
export async function launchCommune(params: {
  tenantId: string
  tenantSlug: string
  tenantName: string
  activatedBy: string
  ipAddress?: string
  userAgent?: string
}): Promise<void> {
  try {
    const published = await publishTenantHistory(params.tenantId)
    const { sent, failed } = await notifyCommuneWaitlist({
      tenantId: params.tenantId,
      tenantName: params.tenantName,
    })

    await auditCommuneLaunched({
      tenantId: params.tenantId,
      tenantSlug: params.tenantSlug,
      publishedReports: published,
      waitlistNotified: sent,
      waitlistFailed: failed,
      activatedBy: params.activatedBy,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    })
  } catch (err) {
    console.error('[Lancement] Échec :', err instanceof Error ? err.message : err)
  }
}
