import { supabaseAdmin } from '../lib/supabaseAdmin.js'

/**
 * La vue qu'a une commune de la taxonomie nationale.
 *
 * Depuis la migration 026, `categories` définit *ce qui existe* et
 * `tenant_categories` ne porte plus que ce qui relève de l'organisation
 * municipale : le libellé affiché, le service destinataire, le délai,
 * l'activation. Les deux tables doivent donc être lues ensemble, et toujours
 * de la même manière — sans quoi l'IA, la validation d'un signalement et le
 * routage d'un e-mail travailleraient sur trois listes différentes.
 *
 * Deux invariants tiennent tout le reste :
 *
 *  - le `slug` rendu est **toujours** le slug canonique. C'est lui qui est
 *    stocké dans `reports.category`, lui que l'IA produit, et lui que les
 *    clients comparent. Le slug local d'origine (`eclairage` chez Dreux) ne
 *    sort plus jamais de la base ;
 *  - une catégorie que la commune n'a pas configurée **reste proposée**.
 *    L'absence de ligne n'est pas un refus, c'est une absence de décision —
 *    et c'est le cas nominal d'un tenant prospect, que personne ne configure.
 */

export interface ResolvedCategory {
  /** Slug canonique. Identifiant réel de la catégorie partout dans le système. */
  slug: string
  /** Libellé de la commune s'il existe, libellé national sinon. */
  label: string
  /** Lu tel quel dans le prompt de l'IA : c'est lui qui décide du classement. */
  description: string
  icon: string
  color: string | null
  is_active: boolean
  sort_order: number
  sla_hours: number
  service_name: string | null
  service_emails: string[]
  /** `true` tant que la commune n'a rien décidé pour cette catégorie. */
  is_default: boolean
}

interface CanonicalRow {
  slug: string
  label_default: string
  description: string
  icon: string
  sort_order: number
}

interface OverrideRow {
  category_slug: string | null
  label: string | null
  icon: string | null
  color: string | null
  is_active: boolean | null
  sort_order: number | null
  sla_hours: number | null
  service_name: string | null
  service_emails: string[] | null
}

/**
 * La liste canonique, fusionnée avec ce que la commune en a fait.
 *
 * Sans `tenantId` — un prospect, ou un appel hors contexte tenant — la liste
 * nationale s'applique telle quelle.
 */
export async function resolveCategories(tenantId?: string | null): Promise<ResolvedCategory[]> {
  const { data: canonical } = await supabaseAdmin
    .from('categories')
    .select('slug, label_default, description, icon, sort_order')
    .order('sort_order')

  const rows = (canonical ?? []) as CanonicalRow[]
  if (rows.length === 0) return []

  let overrides = new Map<string, OverrideRow>()

  if (tenantId) {
    const { data } = await supabaseAdmin
      .from('tenant_categories')
      .select('category_slug, label, icon, color, is_active, sort_order, sla_hours, service_name, service_emails')
      .eq('tenant_id', tenantId)

    overrides = new Map(
      ((data ?? []) as OverrideRow[])
        .filter((row): row is OverrideRow & { category_slug: string } => row.category_slug !== null)
        .map((row) => [row.category_slug, row])
    )
  }

  return rows.map((row) => {
    const override = overrides.get(row.slug)

    return {
      slug: row.slug,
      label: override?.label || row.label_default,
      description: row.description,
      icon: override?.icon || row.icon,
      color: override?.color ?? null,
      is_active: override?.is_active !== false,
      // Le rang de la commune fait foi quand elle en a fixé un : c'est l'ordre
      // dans lequel ses agents lisent leur back-office.
      sort_order: override?.sort_order ?? row.sort_order,
      sla_hours: override?.sla_hours ?? 168,
      service_name: override?.service_name ?? null,
      service_emails: override?.service_emails ?? [],
      is_default: !override,
    }
  }).sort((a, b) => a.sort_order - b.sort_order)
}

/** Ce que la commune traite effectivement — ce qu'on propose au citoyen. */
export async function resolveActiveCategories(tenantId?: string | null): Promise<ResolvedCategory[]> {
  return (await resolveCategories(tenantId)).filter((category) => category.is_active)
}

/**
 * Une catégorie précise, pour cette commune.
 *
 * `null` quand le slug n'appartient pas à la taxonomie nationale — c'est-à-dire
 * quand un client envoie un slug local d'avant la 026, ou inventé.
 */
export async function resolveCategory(
  tenantId: string | null | undefined,
  slug: string
): Promise<ResolvedCategory | null> {
  return (await resolveCategories(tenantId)).find((category) => category.slug === slug) ?? null
}
