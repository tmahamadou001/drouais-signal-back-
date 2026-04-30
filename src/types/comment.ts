export interface ReportComment {
  id: string
  reportId: string
  tenantId: string
  authorType: 'agent' | 'citizen'
  authorId: string
  content: string
  photoUrl: string | null
  isResolutionPhoto: boolean
  parentId: string | null
  reportStatusAtTime: string | null
  readByCitizen: boolean
  readByAgent: boolean
  createdAt: string
  // Jointures
  authorName?: string
  authorEmail?: string
  replies?: ReportComment[]
}

export interface CreateAgentCommentDto {
  content: string
  photoUrl?: string
  isResolutionPhoto?: boolean
}

export interface CreateCitizenCommentDto {
  content: string
  parentId: string
}
