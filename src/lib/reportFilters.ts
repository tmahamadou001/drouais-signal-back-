import { resolveCategories } from '../services/categoryService.js'

/**
 * Les filtres de la liste des signalements, côté serveur.
 *
 * Ils étaient appliqués dans le navigateur, sur la page de quinze lignes déjà
 * reçue. L'onglet « En attente » ne montrait donc pas les signalements en
 * attente de la commune, mais ceux qui se trouvaient dans la page courante —
 * et le compte affiché à côté ne correspondait à aucun des deux. À trois cents
 * signalements, ce n'est plus une approximation, c'est un écran faux.
 *
 * Tout passe par ici, pour que la requête de comptage et celle des données
 * filtrent exactement pareil : deux listes de conditions écrites deux fois
 * finissent toujours par diverger, et le total en pied de table est la première
 * victime.
 */

export type ReportSort = 'recent' | 'oldest' | 'votes'

export interface ReportListFilters {
  /** `all` ou un statut. */
  status: string
  /** `all` ou un slug canonique. */
  category: string
  /** Recherche sur le titre et l'adresse. Vide = pas de recherche. */
  search: string
  /** Fenêtre en jours. `0` = pas de borne. */
  sinceDays: number
  sort: ReportSort
  /** Seulement ce qui dépasse le délai de sa catégorie. */
  overdue: boolean
}

const SORTS: ReportSort[] = ['recent', 'oldest', 'votes']

export function readReportFilters(query: Record<string, unknown>): ReportListFilters {
  const sort = String(query.sort ?? 'recent') as ReportSort
  const sinceDays = parseInt(String(query.since ?? ''), 10)

  return {
    status: String(query.status ?? 'all'),
    category: String(query.category ?? 'all'),
    search: sanitizeSearch(String(query.search ?? '')),
    sinceDays: Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : 0,
    sort: SORTS.includes(sort) ? sort : 'recent',
    overdue: query.overdue === 'true' || query.overdue === true,
  }
}

/**
 * Le terme de recherche, débarrassé de ce qui casserait le filtre.
 *
 * Le tiret est conservé : il est dans toutes les références, et l'agent tape ce
 * qu'on lui dicte.
 *
 * PostgREST sépare les conditions d'un `or=` par des virgules et des
 * parenthèses : un titre contenant « rue des Lilas, angle » découperait la
 * requête en deux conditions invalides. `*` et `%` sont les jokers de `ilike` —
 * les laisser passer laisserait un utilisateur écrire ses propres motifs.
 */
export function sanitizeSearch(raw: string): string {
  return raw.trim().replace(/[,()*%\\"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
}

/**
 * Le moment avant lequel un signalement de cette catégorie est en retard.
 *
 * Même règle que `GET /api/admin/stats` et que le badge « En retard » du
 * tableau : le délai vient de la catégorie, jamais d'un seuil unique.
 */
const DEFAULT_SLA_HOURS = 168

export async function overdueFilter(tenantId: string | null | undefined, now = new Date()): Promise<string> {
  const categories = await resolveCategories(tenantId)

  const clauses = categories.map((category) => {
    const sla = category.sla_hours || DEFAULT_SLA_HOURS
    const limit = new Date(now.getTime() - sla * 3600_000).toISOString()
    return `and(category.eq.${category.slug},created_at.lt.${limit})`
  })

  return clauses.join(',')
}

/** Le sous-ensemble de l'interface PostgREST dont ces filtres ont besoin. */
interface Filterable {
  eq: (column: string, value: unknown) => Filterable
  neq: (column: string, value: unknown) => Filterable
  gte: (column: string, value: unknown) => Filterable
  or: (filter: string) => Filterable
}

/**
 * Applique les filtres à une requête — de comptage ou de données.
 *
 * Synchrone, et c'est important : un constructeur PostgREST est *thenable*.
 * L'attendre le déclenche. Une version `async` de cette fonction exécutait donc
 * la requête au milieu de sa propre construction, avant le tri et la pagination.
 * Les clauses « en retard » sont donc calculées avant, par `overdueFilter`.
 *
 * Deux appels successifs à `.or()` produisent deux conditions combinées par ET,
 * ce qui est bien ce qu'on veut : « (titre OU adresse) ET (en retard pour sa
 * catégorie) ».
 */
export function applyReportFilters<Q extends Filterable>(
  query: Q,
  filters: ReportListFilters,
  tenantId: string | null | undefined,
  overdueClauses = '',
  now = new Date()
): Q {
  let next: Filterable = query

  if (tenantId) next = next.eq('tenant_id', tenantId)
  if (filters.status !== 'all') next = next.eq('status', filters.status)
  if (filters.category !== 'all') next = next.eq('category', filters.category)

  if (filters.sinceDays > 0) {
    next = next.gte('created_at', new Date(now.getTime() - filters.sinceDays * 86_400_000).toISOString())
  }

  if (filters.search) {
    // La référence est cherchée en même temps que le titre et l'adresse, et
    // sans que l'agent ait à choisir : il tape ce que l'habitant lui dicte.
    // `*418*` retrouve `LAL-2026-00418` aussi bien que la référence entière.
    next = next.or(
      `title.ilike.*${filters.search}*` +
      `,address_approx.ilike.*${filters.search}*` +
      `,reference.ilike.*${filters.search}*`
    )
  }

  if (filters.overdue) {
    // Un signalement résolu n'est jamais en retard, quel que soit son âge.
    next = next.neq('status', 'resolu')
    if (overdueClauses) next = next.or(overdueClauses)
  }

  return next as Q
}

/** L'ordre demandé. Le tri secondaire est toujours la date, pour être stable. */
export function sortColumns(sort: ReportSort): { column: string; ascending: boolean }[] {
  if (sort === 'oldest') return [{ column: 'created_at', ascending: true }]
  if (sort === 'votes') return [{ column: 'vote_count', ascending: false }, { column: 'created_at', ascending: false }]
  return [{ column: 'created_at', ascending: false }]
}
