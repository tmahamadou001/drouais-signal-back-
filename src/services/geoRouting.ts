import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import type { Tenant } from '../types/tenant.js'

/**
 * Position → commune → tenant.
 *
 * Le pivot de la v2 : le tenant d'un signalement n'est plus annoncé par le
 * client, il est dérivé de ses coordonnées ici, côté serveur. C'est cette
 * dérivation qui décide de la propriété de la donnée et, demain, de la
 * facturation — elle ne peut donc jamais être déléguée au téléphone.
 *
 * Deux fournisseurs, dans cet ordre :
 *
 *  1. la Base Adresse Nationale, qui rend aussi l'adresse lisible dont l'agent
 *     a besoin pour se déplacer — un seul appel pour les deux besoins ;
 *  2. `geo.api.gouv.fr`, qui ne rend que la commune mais repose sur une
 *     infrastructure distincte.
 *
 * Les deux sont des services publics gratuits et sans engagement de
 * disponibilité. D'où le repli, et surtout le contrat de `resolve()` : elle ne
 * lève pas quand le géocodage échoue, elle répond `null`. L'appelant enregistre
 * alors le signalement non résolu plutôt que de le rejeter — perdre un
 * signalement parce qu'une API tierce tousse serait le pire des comportements.
 */

const BAN_REVERSE = 'https://api-adresse.data.gouv.fr/reverse/'
const GEO_COMMUNES = 'https://geo.api.gouv.fr/communes'
const TIMEOUT_MS = 4_000

/** Métropole et DOM. Au-delà, la position est aberrante, pas seulement hors couverture. */
const FRANCE_BOUNDS = {
  latMin: -21.4, // Réunion sud
  latMax: 51.2,  // Dunkerque
  lngMin: -63.2, // Antilles ouest
  lngMax: 55.9,  // Réunion est
}

/** Un point plausible sur le territoire français. */
export function isPlausiblePosition(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  // (0, 0) est au large du Ghana : c'est la valeur qu'on obtient d'un capteur
  // qui n'a pas de fix, pas celle d'un citoyen.
  if (lat === 0 && lng === 0) return false

  return (
    lat >= FRANCE_BOUNDS.latMin && lat <= FRANCE_BOUNDS.latMax &&
    lng >= FRANCE_BOUNDS.lngMin && lng <= FRANCE_BOUNDS.lngMax
  )
}

export interface ResolvedCommune {
  inseeCode: string
  communeName: string
  /** L'adresse lisible, quand la BAN a répondu. L'agent s'en sert pour se déplacer. */
  addressLabel: string | null
}

export interface ResolvedLocation extends ResolvedCommune {
  /** `null` quand aucun tenant ne couvre cette commune. */
  tenant: Tenant | null
}

/**
 * Cache des résolutions commune.
 *
 * Clé arrondie à la 4ᵉ décimale, soit ~11 m : deux signalements sur le même
 * trottoir tombent sur la même entrée. C'est le cas fréquent dans ce produit —
 * plusieurs personnes signalent le même encombrant.
 */
const communeCache = new Map<string, { value: ResolvedCommune | null; expiresAt: number }>()
const COMMUNE_TTL_MS = 24 * 60 * 60 * 1000 // Le découpage communal ne bouge pas dans la journée.
const COMMUNE_CACHE_MAX = 5_000

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`
}

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    return await response.json()
  } catch {
    // Réseau, DNS, délai dépassé : le fournisseur est indisponible, pas la
    // position invalide. Le repli s'en charge.
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Fournisseur 1 — la BAN, qui rend commune *et* adresse. */
async function reverseViaBan(lat: number, lng: number): Promise<ResolvedCommune | null> {
  const body = await fetchJson(`${BAN_REVERSE}?lon=${lng}&lat=${lat}&limit=1`) as {
    features?: { properties?: { citycode?: string; city?: string; label?: string } }[]
  } | null

  const properties = body?.features?.[0]?.properties
  if (!properties?.citycode) return null

  return {
    inseeCode: properties.citycode,
    communeName: properties.city ?? '',
    addressLabel: properties.label ?? null,
  }
}

/** Fournisseur 2 — `geo.api.gouv.fr`, commune seule, infrastructure distincte. */
async function reverseViaGeoApi(lat: number, lng: number): Promise<ResolvedCommune | null> {
  const body = await fetchJson(
    `${GEO_COMMUNES}?lat=${lat}&lon=${lng}&fields=nom,code&format=json`
  ) as { code?: string; nom?: string }[] | null

  const commune = body?.[0]
  if (!commune?.code) return null

  return {
    inseeCode: commune.code,
    communeName: commune.nom ?? '',
    addressLabel: null,
  }
}

/** La commune qui contient ce point, ou `null` si aucun fournisseur ne répond. */
export async function resolveCommune(lat: number, lng: number): Promise<ResolvedCommune | null> {
  if (!isPlausiblePosition(lat, lng)) return null

  const key = cacheKey(lat, lng)
  const cached = communeCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const commune = (await reverseViaBan(lat, lng)) ?? (await reverseViaGeoApi(lat, lng))

  // Un échec n'est pas mis en cache : le fournisseur peut revenir dans la
  // seconde, et mémoriser son indisponibilité pendant 24 h la propagerait bien
  // au-delà de la panne.
  if (commune) {
    if (communeCache.size >= COMMUNE_CACHE_MAX) communeCache.clear()
    communeCache.set(key, { value: commune, expiresAt: Date.now() + COMMUNE_TTL_MS })
  }

  return commune
}

/**
 * Paris, Lyon et Marseille : de l'arrondissement à la ville.
 *
 * La BAN ne rend pas le code de la commune pour ces trois villes, elle rend
 * celui de l'arrondissement — `75104` pour Paris 4ᵉ, `69382` pour Lyon 2ᵉ.
 * Constaté en interrogeant l'API, pas déduit de la documentation.
 *
 * Les deux découpages sont légitimes : une mairie d'arrondissement est une
 * entité réelle, et une ville peut vouloir couvrir tout son territoire d'un
 * bloc. Un tenant peut donc déclarer l'un ou l'autre, et la résolution essaie
 * l'arrondissement d'abord — le plus précis gagne.
 */
const PLM_RANGES: { min: number; max: number; commune: string }[] = [
  { min: 75101, max: 75120, commune: '75056' }, // Paris
  { min: 69381, max: 69389, commune: '69123' }, // Lyon
  { min: 13201, max: 13216, commune: '13055' }, // Marseille
]

/** La commune parente d'un arrondissement, ou `null` pour tout autre code. */
export function parentCommuneCode(inseeCode: string): string | null {
  const numeric = Number(inseeCode)
  if (!Number.isInteger(numeric)) return null

  return PLM_RANGES.find((r) => numeric >= r.min && numeric <= r.max)?.commune ?? null
}

async function lookupTerritory(inseeCode: string): Promise<Tenant | null> {
  const { data, error } = await supabaseAdmin
    .from('tenant_territories')
    .select('tenants(*)')
    .eq('insee_code', inseeCode)
    .maybeSingle()

  if (error || !data) return null

  // PostgREST rend la relation soit en objet, soit en tableau selon la façon
  // dont il infère la cardinalité ; les deux formes sont acceptées ici.
  const related = (data as { tenants?: Tenant | Tenant[] }).tenants
  const tenant = Array.isArray(related) ? related[0] : related

  return tenant ?? null
}

/** Le tenant qui couvre cette commune, ou `null` si elle n'est pas couverte. */
export async function tenantForInsee(inseeCode: string): Promise<Tenant | null> {
  const exact = await lookupTerritory(inseeCode)
  if (exact) return exact

  const parent = parentCommuneCode(inseeCode)
  return parent ? lookupTerritory(parent) : null
}

/**
 * La résolution complète, telle que l'appelle la création de signalement.
 *
 * Répond `null` uniquement quand la commune elle-même n'a pas pu être
 * déterminée. Une commune trouvée sans tenant n'est pas une erreur : c'est un
 * signalement en commune non couverte, que la phase 2 sait accueillir.
 */
export async function resolve(lat: number, lng: number): Promise<ResolvedLocation | null> {
  const commune = await resolveCommune(lat, lng)
  if (!commune) return null

  return { ...commune, tenant: await tenantForInsee(commune.inseeCode) }
}

/** Vidé par les tests, et par l'admin après un changement de territoire. */
export function clearGeoCache(): void {
  communeCache.clear()
}
