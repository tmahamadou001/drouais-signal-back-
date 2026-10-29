import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import type { Tenant } from '../types/tenant.js'

/**
 * Les communes qui ne sont pas encore clientes.
 *
 * Un signalement venu d'une commune non couverte doit atterrir quelque part :
 * `reports.tenant_id` est NOT NULL, et c'est la clé de partition de tout le
 * système. On crée donc un tenant `prospect` — une coquille qui porte la
 * donnée, sans agent, sans accès, et dont rien n'est publié.
 *
 * Ce n'est pas un compte au rabais, c'est un dossier commercial : le jour où la
 * mairie signe, son historique est déjà là et il suffit de le publier.
 */

/** Un slug lisible et stable à partir du nom de commune et de son code INSEE. */
function slugFor(communeName: string, inseeCode: string): string {
  const base = communeName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)

  // Le code INSEE en suffixe : deux communes françaises peuvent porter le même
  // nom (il y a plusieurs Saint-Denis), et le slug est unique en base.
  return base ? `${base}-${inseeCode}` : `commune-${inseeCode}`
}

/**
 * Le tenant prospect de cette commune, créé s'il n'existe pas.
 *
 * Idempotent par le territoire : c'est `tenant_territories.insee_code` qui est
 * clé primaire, donc deux signalements simultanés depuis la même commune ne
 * peuvent pas produire deux tenants. Le second perd la course et récupère le
 * premier.
 */
export async function ensureProspectTenant(
  inseeCode: string,
  communeName: string
): Promise<Tenant | null> {
  const slug = slugFor(communeName, inseeCode)

  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from('tenants')
    .insert({
      slug,
      name: communeName || `Commune ${inseeCode}`,
      status: 'prospect',
      plan: 'starter',
    })
    .select('*')
    .single()

  if (tenantError || !tenant) {
    console.error('[Prospect] Création impossible:', tenantError?.message)
    return null
  }

  const { error: territoryError } = await supabaseAdmin
    .from('tenant_territories')
    .insert({ insee_code: inseeCode, tenant_id: tenant.id, commune_name: communeName })

  if (territoryError) {
    // Quelqu'un a gagné la course : le territoire est déjà pris. On supprime la
    // coquille qu'on vient de créer et on rend celle qui existe — sans quoi on
    // laisserait un tenant orphelin, invisible, à chaque signalement simultané.
    await supabaseAdmin.from('tenants').delete().eq('id', tenant.id)

    const { data: existing } = await supabaseAdmin
      .from('tenant_territories')
      .select('tenants(*)')
      .eq('insee_code', inseeCode)
      .maybeSingle()

    const related = (existing as { tenants?: Tenant | Tenant[] } | null)?.tenants
    return (Array.isArray(related) ? related[0] : related) ?? null
  }

  console.log(`[Prospect] ${communeName} (${inseeCode}) enregistrée — slug ${slug}`)
  return tenant as Tenant
}

/** Inscrit un habitant à la liste d'attente de sa commune. */
export async function joinWaitlist(params: {
  inseeCode: string
  communeName: string
  email: string
}): Promise<void> {
  const { error } = await supabaseAdmin.from('commune_waitlist').upsert(
    {
      insee_code: params.inseeCode,
      commune_name: params.communeName,
      email: params.email.trim().toLowerCase(),
    },
    // S'inscrire deux fois ne compte qu'une fois : le chiffre présenté à la
    // mairie doit être le nombre d'habitants, pas le nombre de clics.
    { onConflict: 'insee_code,email', ignoreDuplicates: true }
  )

  if (error) throw error
}
