import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { AppError } from '../middleware/errorHandler.js'
import { distanceMeters } from '../lib/geoDistance.js'
import { isCommunityMode } from '../lib/tenantMode.js'
import { pushResidentResolution } from './pushService.js'

/**
 * Qui ferme un signalement là où il n'y a pas de mairie.
 *
 * Dans une commune partenaire, un agent décide et c'est terminal. Dans une
 * commune citoyenne (migration 040), personne ne décide — alors ce sont les
 * habitants qui constatent, avec la seule preuve qu'on sache vérifier : leur
 * position. C'est la règle des confirmations sur place de la migration 029,
 * reprise telle quelle, pour la même raison : sans elle, « c'est réparé » est
 * un bouton qu'on presse depuis son canapé, et il referme le problème de
 * quelqu'un d'autre.
 *
 * Trois garde-fous, et chacun répond à une façon précise de se tromper :
 *
 *  - **la distance** — on ne constate que ce qu'on voit ;
 *  - **le nombre** — un passant seul ne ferme pas le signalement d'un autre.
 *    Il se trompe de bonne foi plus souvent qu'on ne croit : le trou rebouché
 *    était celui d'à côté. L'auteur, lui, ferme le sien seul : c'est le sien ;
 *  - **la contestation** — « toujours là » rouvre, selon la même arithmétique.
 *    C'est ce qui rend ce statut réversible là où celui d'un agent ne l'est
 *    pas, et c'est pourquoi `reports.resolution_source` existe.
 */

/** Même rayon que la confirmation sur place : c'est le même geste, au même endroit. */
export const RESOLUTION_RADIUS_M = 150

/**
 * Combien d'habitants il faut, quand ce n'est pas l'auteur.
 *
 * Deux, et pas trois : au-delà, un signalement réparé dans une rue peu passante
 * ne se refermerait jamais, et l'app afficherait indéfiniment un problème qui
 * n'existe plus — ce qui est la façon la plus sûre de perdre la confiance qu'on
 * cherche à construire.
 */
export const REQUIRED_CONCURRING_CLAIMS = 2

export type ClaimKind = 'repaired' | 'still_there'

export interface ResolutionState {
  status: string
  resolution_source: string | null
  repaired_count: number
  still_there_count: number
  /** Le constat de l'appelant, s'il en a déposé un. */
  mine: ClaimKind | null
}

interface ReportRow {
  id: string
  tenant_id: string
  status: string
  resolution_source: string | null
  user_id: string | null
  lat: number
  lng: number
  title: string
  category: string
  address_approx: string | null
  photo_url: string | null
  created_at: string
  is_anonymous: boolean
  anonymous_token: string | null
}

/** Les constats d'un signalement, comptés par nature. */
async function tally(reportId: string, userId: string | null): Promise<{
  repaired: string[]
  stillThere: string[]
  mine: ClaimKind | null
}> {
  const { data, error } = await supabaseAdmin
    .from('resolution_claims')
    .select('user_id, kind')
    .eq('report_id', reportId)

  if (error) throw error

  const rows = (data ?? []) as { user_id: string; kind: ClaimKind }[]

  return {
    repaired: rows.filter((row) => row.kind === 'repaired').map((row) => row.user_id),
    stillThere: rows.filter((row) => row.kind === 'still_there').map((row) => row.user_id),
    mine: rows.find((row) => row.user_id === userId)?.kind ?? null,
  }
}

/**
 * Le constat suffit-il à faire basculer le statut ?
 *
 * Exporté pour être testé seul : c'est la règle de décision, et elle ne doit
 * pas avoir besoin d'une base de données pour être vérifiée.
 */
export function decideFlip(params: {
  claimantId: string
  authorId: string | null
  concurring: string[]
}): boolean {
  // L'auteur ferme ou rouvre le sien, seul. Un signalement sans compte n'a pas
  // d'auteur identifiable : il retombe sur la règle commune, ce qui est le bon
  // défaut — on ne peut pas reconnaître quelqu'un qu'on n'a jamais inscrit.
  if (params.authorId && params.claimantId === params.authorId) return true

  const distinct = new Set(params.concurring)
  return distinct.size >= REQUIRED_CONCURRING_CLAIMS
}

/**
 * Enregistre un constat et, s'il fait basculer, change le statut.
 *
 * Le changement de statut passe par un `UPDATE` conditionné au statut attendu
 * plutôt que par la RPC atomique des agents : celle-ci écrit `agent_id`, et un
 * habitant n'est pas un agent — le journal du traitement l'aurait nommé comme
 * tel dans le back-office le jour où la commune signe.
 */
export async function claimResolution(params: {
  reportId: string
  userId: string
  lat: number
  lng: number
  kind: ClaimKind
  photoUrl: string | null
  tenantId?: string | null
}): Promise<ResolutionState> {
  let query = supabaseAdmin
    .from('reports')
    .select(
      'id, tenant_id, status, resolution_source, user_id, lat, lng, title, category, address_approx, photo_url, created_at, is_anonymous, anonymous_token'
    )
    .eq('id', params.reportId)

  if (params.tenantId) query = query.eq('tenant_id', params.tenantId)

  const { data, error } = await query.single()
  if (error || !data) throw new AppError(404, 'not_found', 'Signalement introuvable.')

  const report = data as ReportRow

  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('status')
    .eq('id', report.tenant_id)
    .single()

  /**
   * Le geste n'existe que là où il n'y a personne pour décider.
   *
   * Dans une commune partenaire, laisser des habitants clore un signalement
   * retirerait à la mairie la décision qu'elle a achetée — et un agent verrait
   * sa file se vider sans l'avoir voulu.
   */
  if (!isCommunityMode(tenant?.status ?? '')) {
    throw new AppError(
      403,
      'not_community',
      'Dans cette commune, seuls les services municipaux changent le statut d’un signalement.'
    )
  }

  if (params.kind === 'repaired' && report.status === 'resolu') {
    throw new AppError(409, 'already_resolved', 'Ce signalement est déjà marqué comme réparé.')
  }

  /**
   * On ne conteste que ce que des habitants ont fermé.
   *
   * Si la commune a signé entre-temps et qu'un agent a clos le signalement,
   * `resolution_source` vaut `agent` : le constat n'a plus lieu d'être, et
   * l'habitant passe par la conversation avec la mairie, qui existe pour ça.
   */
  if (params.kind === 'still_there' && report.resolution_source !== 'residents') {
    throw new AppError(
      409,
      'not_resident_resolved',
      'Ce signalement n’a pas été fermé par des habitants : il n’y a rien à contester ici.'
    )
  }

  const distance = distanceMeters(params.lat, params.lng, report.lat, report.lng)

  if (distance > RESOLUTION_RADIUS_M) {
    throw new AppError(
      422,
      'too_far',
      'Vous êtes trop loin de ce signalement pour constater sur place.'
    )
  }

  // Un habitant qui change d'avis remplace son constat ; il n'en empile pas un
  // second, qui compterait deux fois dans l'arithmétique ci-dessous.
  const { error: claimError } = await supabaseAdmin.from('resolution_claims').upsert(
    {
      report_id: params.reportId,
      user_id: params.userId,
      kind: params.kind,
      lat: params.lat,
      lng: params.lng,
      distance_m: distance,
      photo_url: params.photoUrl,
    },
    { onConflict: 'report_id,user_id' }
  )

  if (claimError) throw claimError

  const counts = await tally(params.reportId, params.userId)
  const concurring = params.kind === 'repaired' ? counts.repaired : counts.stillThere

  const flips = decideFlip({
    claimantId: params.userId,
    authorId: report.user_id,
    concurring,
  })

  let status = report.status
  let source = report.resolution_source

  if (flips) {
    const next = params.kind === 'repaired'
      ? { status: 'resolu', resolution_source: 'residents' }
      : { status: 'en_attente', resolution_source: null }

    // Conditionné au statut lu : deux constats simultanés ne doivent pas écrire
    // deux fois la même bascule, ni un retour en arrière par-dessus une avancée.
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('reports')
      .update({ ...next, updated_at: new Date().toISOString() })
      .eq('id', params.reportId)
      .eq('status', report.status)
      .select('id')

    if (updateError) throw updateError

    if ((updated ?? []).length > 0) {
      status = next.status
      source = next.resolution_source

      /**
       * L'auteur apprend ce que des voisins ont décidé de son signalement.
       *
       * Seulement quand ce n'est pas lui — il vient de le faire — et seulement
       * s'il a un compte : un dépôt sans compte n'a pas d'appareil à prévenir,
       * et c'est le prix assumé du signalement sans inscription.
       *
       * Sans attendre l'envoi : une notification qui échoue ne doit pas faire
       * échouer un constat déjà enregistré.
       */
      if (report.user_id && report.user_id !== params.userId) {
        void pushResidentResolution({
          userId: report.user_id,
          reportId: params.reportId,
          reportTitle: report.title,
          reopened: params.kind === 'still_there',
        }).catch((err) => console.error('[Constat] Notification :', err))
      }

      await supabaseAdmin.from('status_history').insert({
        report_id: params.reportId,
        tenant_id: report.tenant_id,
        old_status: report.status,
        new_status: next.status,
        // Pas d'`agent_id` : personne de la mairie n'a rien décidé, et le
        // journal du back-office retombe alors sur l'auteur générique plutôt
        // que de nommer un habitant comme agent.
        agent_id: null,
        comment:
          params.kind === 'repaired'
            ? 'Habitants — constaté réparé sur place'
            : 'Habitants — signalé toujours présent',
        changed_at: new Date().toISOString(),
      })
    }
  }

  return {
    status,
    resolution_source: source,
    repaired_count: new Set(counts.repaired).size,
    still_there_count: new Set(counts.stillThere).size,
    mine: counts.mine,
  }
}

/** L'état des constats, pour afficher le bouton dans le bon sens. */
export async function readResolution(params: {
  reportId: string
  userId: string | null
  tenantId?: string | null
}): Promise<ResolutionState> {
  let query = supabaseAdmin
    .from('reports')
    .select('id, status, resolution_source')
    .eq('id', params.reportId)

  if (params.tenantId) query = query.eq('tenant_id', params.tenantId)

  const { data, error } = await query.single()
  if (error || !data) throw new AppError(404, 'not_found', 'Signalement introuvable.')

  const counts = await tally(params.reportId, params.userId)

  return {
    status: data.status,
    resolution_source: data.resolution_source,
    repaired_count: new Set(counts.repaired).size,
    still_there_count: new Set(counts.stillThere).size,
    mine: counts.mine,
  }
}
