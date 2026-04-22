// Claude AI integration for photo analysis
// Hybrid model: Haiku by default, escalates to Sonnet if confidence < 70%

import Anthropic from '@anthropic-ai/sdk'

export interface TenantCategoryForPrompt {
  slug: string
  label: string
  description?: string | null
}

export interface ClaudeAnalysisResult {
  category: string
  title: string
  confidence: 'fort' | 'moyen' | 'faible'
  description: string
  error?: string
  modelUsed?: string
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const SONNET_MODEL = 'claude-sonnet-4-6'

function buildClaudePrompt(categories: TenantCategoryForPrompt[]): {
  slugList: string
  rules: string
  fallbackSlug: string
} {
  const fallbackSlug = categories[categories.length - 1]?.slug ?? 'autre'
  const slugList = categories.map((c) => `"${c.slug}"`).join(' | ')
  const rules = categories
    .map((c) => `- ${c.slug} : ${c.description ?? c.label}`)
    .join('\n')

  return { slugList, rules, fallbackSlug }
}

function confidenceToPercentage(confidence: 'fort' | 'moyen' | 'faible'): number {
  switch (confidence) {
    case 'fort':
      return 90
    case 'moyen':
      return 60
    case 'faible':
      return 30
    default:
      return 50
  }
}

async function analyzeWithModel(
  model: string,
  base64Image: string,
  mediaType: string,
  categories: TenantCategoryForPrompt[]
): Promise<ClaudeAnalysisResult> {
  const { slugList, rules, fallbackSlug } = buildClaudePrompt(categories)

  const fallback: ClaudeAnalysisResult = {
    category: fallbackSlug,
    title: 'Signalement divers',
    confidence: 'faible',
    description: 'Impossible d\'identifier le problème sur la photo',
    error: 'analysis_failed',
    modelUsed: model,
  }

  try {
    const message = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      temperature: 0.5,
      system: `Tu es un assistant qui analyse des photos de problèmes urbains signalés par des citoyens français.
Tu dois répondre UNIQUEMENT en JSON valide, sans aucun texte avant ou après.`,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType as any,
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: `Analyse cette photo et retourne ce JSON :
{
  "category": ${slugList},
  "title": "titre court en français, max 60 caractères",
  "confidence": "fort" | "moyen" | "faible",
  "description": "une phrase descriptive en français, max 120 caractères"
}

Règles de catégorisation :
${rules}

Si l'image n'est pas un problème urbain (photo floue, hors-sujet, inappropriée), retourne :
{
  "category": "${fallbackSlug}",
  "title": "Signalement divers",
  "confidence": "faible",
  "description": "Impossible d'identifier le problème sur la photo"
}`,
            },
          ],
        },
      ],
    })

    const textContent = message.content.find((block) => block.type === 'text')
    if (!textContent || textContent.type !== 'text') {
      throw new Error('Pas de réponse texte de Claude')
    }

    let jsonText = textContent.text.trim()
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    }

    const result = JSON.parse(jsonText)

    console.log('result', result)

    // Valider la structure
    if (
      !result.category ||
      !result.title ||
      !result.confidence ||
      !result.description
    ) {
      throw new Error('JSON invalide')
    }

    // Valider les valeurs
    const validCategories = categories.map((c) => c.slug)
    const validConfidences = ['fort', 'moyen', 'faible']

    if (!validCategories.includes(result.category)) {
      result.category = fallbackSlug
    }
    if (!validConfidences.includes(result.confidence)) {
      result.confidence = 'moyen'
    }
    if (!result.title || result.title.length > 60) {
      result.title = result.title?.substring(0, 60) || 'Signalement urbain'
    }
    if (!result.description || result.description.length > 120) {
      result.description = result.description?.substring(0, 120) || ''
    }

    return {
      ...result,
      modelUsed: model,
    }
  } catch (err) {
    console.error(`Erreur analyse ${model}:`, err)
    return fallback
  }
}

export async function analyzePhotoWithClaude(
  base64Image: string,
  mediaType: string,
  categories: TenantCategoryForPrompt[]
): Promise<ClaudeAnalysisResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY non configurée')
    const fallbackSlug = categories[categories.length - 1]?.slug ?? 'autre'
    return {
      category: fallbackSlug,
      title: 'Signalement divers',
      confidence: 'faible',
      description: 'Service d\'analyse non disponible',
      error: 'service_unavailable',
    }
  }

  // 1️⃣ Première analyse avec Haiku (rapide et économique)
  console.log(`🤖 [Claude] Analyse avec ${HAIKU_MODEL}`)
  const haikuResult = await analyzeWithModel(
    HAIKU_MODEL,
    base64Image,
    mediaType,
    categories
  )

  const confidencePercent = confidenceToPercentage(haikuResult.confidence)

  // 2️⃣ Si confiance < 70%, escalade vers Sonnet (plus précis)
  if (confidencePercent < 70) {
    console.log(
      `⚠️  [Claude] Confiance faible (${confidencePercent}%) → escalade vers ${SONNET_MODEL}`
    )
    const sonnetResult = await analyzeWithModel(
      SONNET_MODEL,
      base64Image,
      mediaType,
      categories
    )
    console.log(`✅ [Claude] Analyse finale avec ${SONNET_MODEL}`)
    return sonnetResult
  }

  console.log(`✅ [Claude] Analyse validée avec ${HAIKU_MODEL} (confiance: ${confidencePercent}%)`)
  return haikuResult
}

