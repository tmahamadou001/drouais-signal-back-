export interface Tenant {
  id: string
  slug: string
  name: string
  status: 'trial' | 'active' | 'suspended' | 'demo'
  plan: 'starter' | 'agglo' | 'enterprise'
  contact_name?: string
  contact_email?: string
  contact_phone?: string
  trial_ends_at?: string
  activated_at?: string
  created_at: string
  updated_at: string
}

export interface TenantConfig {
  id: string
  tenant_id: string
  city_name: string
  city_population?: number
  department_code?: string
  region?: string
  primary_color: string
  logo_url?: string
  welcome_message?: string
  map_lat: number
  map_lng: number
  map_zoom: number
  feature_anonymous_reports: boolean
  feature_votes: boolean
  feature_ai_analysis: boolean
  feature_weekly_report: boolean
  feature_heatmap: boolean
  weekly_report_day: number
  weekly_report_hour: number
  weekly_report_emails: string[]
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
