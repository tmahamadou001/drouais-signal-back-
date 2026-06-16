import { supabaseAdmin } from '../lib/supabaseAdmin.js'


interface UserEnrichment {
  email: string | null
  role: string | null
}

export interface AuditLogParams {
  userId?: string
  userEmail?: string
  userRole?: string
  action: AuditAction
  entityType: AuditEntityType
  entityId?: string
  tenantId?: string
  tenantSlug?: string
  metadata?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
}

export type AuditAction =
  | 'user.created'
  | 'user.invited'
  | 'user.role_changed'
  | 'user.revoked'
  | 'report.created'
  | 'report.status_changed'
  | 'report.service_notified'
  | 'report.deleted'
  | 'report.bulk_deleted'
  | 'tenant.created'
  | 'tenant.status_changed'
  | 'tenant_config.updated'
  | 'tenant_categories.updated'

export type AuditEntityType =
  | 'user'
  | 'report'
  | 'tenant'
  | 'tenant_config'
  | 'tenant_categories'

async function enrichUserData(userId: string, tenantId?: string): Promise<UserEnrichment> {
  try {
    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId)

    if (!authUser?.user) return { email: null, role: null }

    const email = authUser.user.email ?? null
    let role: string | null = null

    const metadataRole = authUser.user.app_metadata?.role
    if (metadataRole === 'super_admin') {
      role = 'super_admin'
    } else if (tenantId) {
      const { data: tenantUser } = await supabaseAdmin
        .from('tenant_users')
        .select('role')
        .eq('user_id', userId)
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .single()
      role = tenantUser?.role ?? null
    } else {
      role = 'citizen'
    }

    return { email, role }
  } catch (err) {
    console.error('[AuditService] User enrichment failed:', err)
    return { email: null, role: null }
  }
}

export async function createAuditLog(params: AuditLogParams): Promise<void> {
  try {
    let userEmail = params.userEmail
    let userRole = params.userRole

    if (params.userId && (!userEmail || !userRole)) {
      const enrichment = await enrichUserData(params.userId, params.tenantId)
      userEmail = userEmail || enrichment.email || undefined
      userRole  = userRole  || enrichment.role  || undefined
    }

    const { error } = await supabaseAdmin
      .from('audit_logs')
      .insert({
        user_id:    params.userId    || null,
        user_email: userEmail        || null,
        user_role:  userRole         || null,
        action:     params.action,
        entity_type: params.entityType,
        entity_id:  params.entityId  || null,
        tenant_id:  params.tenantId  || null,
        tenant_slug: params.tenantSlug || null,
        metadata:   params.metadata  || {},
        ip_address: params.ipAddress || null,
        user_agent: params.userAgent || null,
      })

    if (error) {
      console.error('[AuditService] Erreur écriture log:', error.message)
    } else {
      console.log(`[AuditService] ${params.action} | ${userEmail ?? 'anonymous'} (${userRole ?? 'N/A'})`)
    }
  } catch (err) {
    console.error('[AuditService] Exception:', err)
  }
}

export async function auditUserCreated(params: {
  userId: string
  userEmail: string
  userRole?: string
  createdBy?: string
  createdByEmail?: string
  tenantId?: string
  tenantSlug?: string
  metadata?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
}) {
  await createAuditLog({
    userId: params.createdBy,
    userEmail: params.createdByEmail,
    action: params.createdBy ? 'user.invited' : 'user.created',
    entityType: 'user',
    entityId: params.userId,
    tenantId: params.tenantId,
    tenantSlug: params.tenantSlug,
    metadata: {
      created_user_email: params.userEmail,
      created_user_role: params.userRole,
      ...params.metadata,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  })
}

export async function auditReportStatusChanged(params: {
  reportId: string
  reportTitle?: string
  oldStatus: string
  newStatus: string
  changedBy: string
  changedByEmail?: string
  tenantId?: string
  tenantSlug?: string
  comment?: string
  ipAddress?: string
  userAgent?: string
}) {
  await createAuditLog({
    userId: params.changedBy,
    userEmail: params.changedByEmail,
    action: 'report.status_changed',
    entityType: 'report',
    entityId: params.reportId,
    tenantId: params.tenantId,
    tenantSlug: params.tenantSlug,
    metadata: {
      report_title: params.reportTitle,
      old_status: params.oldStatus,
      new_status: params.newStatus,
      comment: params.comment,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  })
}

export async function auditReportDeleted(params: {
  reportId: string
  reportTitle?: string
  deletedBy: string
  deletedByEmail?: string
  tenantId?: string
  tenantSlug?: string
  ipAddress?: string
  userAgent?: string
}) {
  await createAuditLog({
    userId: params.deletedBy,
    userEmail: params.deletedByEmail,
    action: 'report.deleted',
    entityType: 'report',
    entityId: params.reportId,
    tenantId: params.tenantId,
    tenantSlug: params.tenantSlug,
    metadata: { report_title: params.reportTitle },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  })
}

export async function auditReportBulkDeleted(params: {
  reportIds: string[]
  deletedBy: string
  deletedByEmail?: string
  tenantId?: string
  tenantSlug?: string
  ipAddress?: string
  userAgent?: string
}) {
  await createAuditLog({
    userId: params.deletedBy,
    userEmail: params.deletedByEmail,
    action: 'report.bulk_deleted',
    entityType: 'report',
    tenantId: params.tenantId,
    tenantSlug: params.tenantSlug,
    metadata: {
      report_ids: params.reportIds,
      count: params.reportIds.length,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  })
}

export async function auditTenantCreated(params: {
  tenantId: string
  tenantSlug: string
  tenantName: string
  createdBy: string
  createdByEmail?: string
  ipAddress?: string
  userAgent?: string
}) {
  await createAuditLog({
    userId: params.createdBy,
    userEmail: params.createdByEmail,
    action: 'tenant.created',
    entityType: 'tenant',
    entityId: params.tenantId,
    tenantId: params.tenantId,
    tenantSlug: params.tenantSlug,
    metadata: { tenant_name: params.tenantName },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  })
}

export async function auditTenantStatusChanged(params: {
  tenantId: string
  tenantSlug: string
  oldStatus: string
  newStatus: string
  changedBy: string
  changedByEmail?: string
  ipAddress?: string
  userAgent?: string
}) {
  await createAuditLog({
    userId: params.changedBy,
    userEmail: params.changedByEmail,
    action: 'tenant.status_changed',
    entityType: 'tenant',
    entityId: params.tenantId,
    tenantId: params.tenantId,
    tenantSlug: params.tenantSlug,
    metadata: {
      old_status: params.oldStatus,
      new_status: params.newStatus,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  })
}

export async function auditReportServiceNotified(params: {
  reportId: string
  reportTitle?: string
  category: string
  serviceName: string
  serviceEmails: string[]
  tenantId?: string
  tenantSlug?: string
}) {
  await createAuditLog({
    // Pas de userId : action déclenchée automatiquement par le système
    userEmail: 'system',
    userRole:  'system',
    action: 'report.service_notified',
    entityType: 'report',
    entityId: params.reportId,
    tenantId: params.tenantId,
    tenantSlug: params.tenantSlug,
    metadata: {
      report_title:   params.reportTitle,
      category:       params.category,
      service_name:   params.serviceName,
      service_emails: params.serviceEmails,
    },
  })
}
