import type { TenantStatus } from '../lib/tenantMode.js'

export interface Tenant {
  id: string
  slug: string
  name: string
  /**
   * Le régime de la commune. Ce que chaque valeur autorise est décidé en un
   * seul endroit — `lib/tenantMode.ts` — et jamais par comparaison directe :
   * `status !== 'prospect'` était vrai pour `suspended`, qui ne publie rien.
   *
   * `prospect` : coquille muette (migration 025). `community` : publiée sans
   * mairie (migration 040). Le reste : partenaire.
   */
  status: TenantStatus
  plan: 'starter' | 'agglo' | 'enterprise'
  contact_name?: string
  contact_email?: string
  contact_phone?: string
  trial_ends_at?: string
  activated_at?: string
  /** Ouverture au public en mode citoyen. Null si jamais ouverte. */
  published_at?: string | null
  created_at: string
  updated_at: string
}

export interface TenantConfig {
  id: string
  tenant_id: string
  city_name: string
  primary_color: string
  /**
   * Le cadrage des cartes du back-office, hérité de la mairie. `null` pour une
   * commune prospect, que personne n'a paramétrée.
   */
  map_lat: number | null
  map_lng: number | null
  map_zoom: number | null
  feature_votes: boolean
  feature_ai_analysis: boolean
  feature_weekly_report: boolean
  feature_heatmap: boolean
  /** Quand part le rapport hebdomadaire : jour (1 = lundi) et heure locale. */
  weekly_report_day: number
  weekly_report_hour: number
}

export interface TenantCategory {
  id: string
  tenant_id: string
  slug: string
  label: string
  icon: string
  color: string
  description?: string
  is_active: boolean
  sort_order: number
  sla_hours: number
  service_name?: string | null
  service_emails?: string[]
}

export interface TenantUser {
  id: string
  tenant_id: string
  user_id: string
  role: 'admin' | 'agent' | 'observer'
  is_active: boolean
  first_name?: string
  last_name?: string
  job_title?: string
  joined_at: string
}

export type UserRole =
  | 'super_admin'
  | 'admin'
  | 'agent'
  | 'observer'
  | 'citizen'
