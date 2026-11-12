import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { AppError } from '../middleware/errorHandler.js'
import { removePhoto } from '../lib/photoStorage.js'
import { isCommunityMode } from '../lib/tenantMode.js'

/**
 * La modération des communes sans mairie.
 *
 * Partout ailleurs, modérer appartient à la commune : ses agents suppriment ce
 * qui n'a pas lieu d'être, et c'est leur territoire. Une commune ouverte au
 * public (migration 040) n'a **personne** — et c'est la contrepartie exacte de
 * la décision de publier sans elle : si nous publions, nous répondons de ce qui
 * est publié. En droit, c'est l'obligation de retrait du contenu manifestement
 * illicite ; en pratique, c'est une plaque d'immatriculation sur une photo, une
 * devanture reconnaissable, un visage.
 *
 * Trois gestes, du plus léger au plus lourd, et c'est délibérément cet ordre :
 *
 *  - **retirer la photo** — le cas de loin le plus fréquent. Le signalement
 *    reste, son texte reste, l'habitant garde son suivi ; ce qui gênait a
 *    disparu. Supprimer tout un signalement pour une plaque visible serait
 *    détruire une information publique utile pour un détail réparable ;
 *  - **dépublier** — le signalement sort des listes, de la carte et de la
 *    recherche, et reste lisible de son auteur. Réversible, et c'est le point :
 *    une modération qui ne se défait pas ne se fait pas sereinement ;
 *  - **supprimer**, qui existe déjà pour les communes partenaires et reste le
 *    dernier mot, hors de ce module.
 *
 * Chaque geste est tracé avec son motif. Un retrait sans motif est
 * incontestable, donc inaudit — et c'est précisément ce qu'un journal d'audit
 * existe pour empêcher.
 */

export interface ModerationItem {
  id: string
  reference: string | null
  title: string
  description: string | null
  category: string
  status: string
  photo_url: string | null
  address_approx: string | null
  created_at: string
  is_published: boolean
  tenant: { id: string; slug: string; name: string }
}

/**
 * Ce qui est publié dans les communes sans mairie, le plus récent d'abord.
 *
 * L'ordre n'est pas décoratif : la modération se fait à l'arrivée, et ce qu'on
 * veut voir en ouvrant l'écran, c'est ce qui vient de devenir public.
 *
 * Les signalements **dépubliés** y figurent aussi, marqués comme tels : les
 * cacher ferait du retrait une disparition, sans aucun moyen de revenir dessus
 * ni de vérifier ce qu'on a retiré.
 */
export async function listModerationQueue(params: {
  limit: number
  page: number
}): Promise<{ data: ModerationItem[]; total: number }> {
  const { data: tenants, error: tenantError } = await supabaseAdmin
    .from('tenants')
    .select('id, slug, name, status')
    .eq('status', 'community')

  if (tenantError) throw tenantError

  const communes = tenants ?? []
  if (communes.length === 0) return { data: [], total: 0 }

  const byId = new Map(communes.map((one) => [one.id, one]))
  const ids = communes.map((one) => one.id)
  const from = (params.page - 1) * params.limit

  const { data, error, count } = await supabaseAdmin
    .from('reports')
    .select(
      'id, reference, title, description, category, status, photo_url, address_approx, created_at, is_published, tenant_id',
      { count: 'exact' }
    )
    .in('tenant_id', ids)
    .order('created_at', { ascending: false })
    .range(from, from + params.limit - 1)

  if (error) throw error

  const items = (data ?? []).map((report) => {
    const { tenant_id, ...rest } = report as Record<string, unknown> & { tenant_id: string }
    const commune = byId.get(tenant_id)

    return {
      ...rest,
      tenant: {
        id: tenant_id,
        slug: commune?.slug ?? '',
        name: commune?.name ?? '',
      },
    } as ModerationItem
  })

  return { data: items, total: count ?? 0 }
}

/** Le signalement et sa commune, ou une erreur si le geste n'a pas lieu d'être ici. */
async function moderatable(reportId: string) {
  const { data, error } = await supabaseAdmin
    .from('reports')
    .select('id, title, photo_url, is_published, tenant_id, tenants(status, slug)')
    .eq('id', reportId)
    .single()

  if (error || !data) throw new AppError(404, 'not_found', 'Signalement introuvable.')

  const related = (data as { tenants?: { status: string; slug: string } | { status: string; slug: string }[] }).tenants
  const tenant = Array.isArray(related) ? related[0] : related

  /**
   * Hors des communes citoyennes, la modération appartient à la mairie.
   *
   * Un super-administrateur garde ses pouvoirs par les routes de la commune —
   * suppression, changement de statut. Mais passer par **ce** module reviendrait
   * à dépublier le signalement d'une commune partenaire sans que personne chez
   * elle ne le sache, et son agent chercherait une ligne disparue de sa file.
   */
  if (!isCommunityMode(tenant?.status ?? '')) {
    throw new AppError(
      409,
      'not_community',
      'Cette commune a une équipe municipale : la modération lui appartient.'
    )
  }

  return { report: data, tenantSlug: tenant?.slug ?? '' }
}

/** Retire le signalement de la vue publique. Son auteur continue de le voir. */
export async function retractReport(reportId: string): Promise<{ title: string; tenantId: string; tenantSlug: string }> {
  const { report, tenantSlug } = await moderatable(reportId)

  /**
   * `retracted_at` dit *pourquoi* le signalement n'est pas publié.
   *
   * `is_published` portait deux significations incompatibles : « jamais
   * publié, la commune est silencieuse » et « retiré par un modérateur ».
   * `publishTenantHistory` republiait donc tout ce qui était à faux — et
   * rouvrir une commune (community → prospect → community) remettait en ligne
   * la photo de plaque d'immatriculation qu'on venait d'en retirer, l'audit
   * disant seulement « commune ouverte ».
   */
  const { error } = await supabaseAdmin
    .from('reports')
    .update({
      is_published: false,
      retracted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', reportId)

  if (error) throw error

  return { title: report.title as string, tenantId: report.tenant_id as string, tenantSlug }
}

/** Le remet en vue. Le geste de modération se défait, sinon il ne se fait pas. */
export async function restoreReport(reportId: string): Promise<{ title: string; tenantId: string; tenantSlug: string }> {
  const { report, tenantSlug } = await moderatable(reportId)

  const { error } = await supabaseAdmin
    .from('reports')
    .update({
      is_published: true,
      // La marque de modération s'efface avec elle : republier, c'est revenir
      // sur le retrait, pas le contourner.
      retracted_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', reportId)

  if (error) throw error

  return { title: report.title as string, tenantId: report.tenant_id as string, tenantSlug }
}

/**
 * Efface la photo, et garde le signalement.
 *
 * Le fichier est retiré du stockage **et** l'URL de la base : ne faire que le
 * second laisserait l'image accessible à qui a gardé le lien signé, pour un an.
 */
export async function removeReportPhoto(reportId: string): Promise<{ title: string; tenantId: string; tenantSlug: string }> {
  const { report, tenantSlug } = await moderatable(reportId)

  if (!report.photo_url) {
    throw new AppError(409, 'no_photo', 'Ce signalement n’a pas de photo.')
  }

  await removePhoto(report.photo_url as string)

  const { error } = await supabaseAdmin
    .from('reports')
    .update({ photo_url: null, updated_at: new Date().toISOString() })
    .eq('id', reportId)

  if (error) throw error

  return { title: report.title as string, tenantId: report.tenant_id as string, tenantSlug }
}
