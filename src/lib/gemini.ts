// Gemini AI integration for photo analysis
// Alternative provider to Claude

const GEMINI_PROMPT = `Tu es un assistant qui analyse des photos de problèmes urbains signalés par des citoyens français.
Retourne UNIQUEMENT un objet JSON valide, sans texte avant ou après, sans balises markdown.

Analyse cette photo et retourne ce JSON :
{
  "category": "voirie" | "eclairage" | "dechets" | "autre",
  "title": "titre court en français, max 60 caractères",
  "confidence": "fort" | "moyen" | "faible",
  "description": "une phrase descriptive en français, max 120 caractères"
}

Règles de catégorisation :
- voirie : nid-de-poule, trottoir cassé, route abîmée, signalisation routière
- eclairage : lampadaire cassé ou éteint, câble apparent, zone mal éclairée
- dechets : dépôt sauvage, poubelle renversée, encombrants, graffiti, tags
- autre : tout ce qui ne rentre pas dans les catégories ci-dessus

Si l'image n'est pas un problème urbain, retourne :
{"category":"autre","title":"Signalement divers","confidence":"faible","description":"Impossible d'identifier le problème"}`

interface GeminiAnalysisResult {
  category: 'voirie' | 'eclairage' | 'dechets' | 'autre'
  title: string
  confidence: 'fort' | 'moyen' | 'faible'
  description: string
  error?: string
}

export async function analyzePhotoWithGemini(
  base64Image: string,
  mimeType: string
): Promise<GeminiAnalysisResult> {
  const fallback: GeminiAnalysisResult = {
    category: 'autre',
    title: '',
    confidence: 'faible',
    description: '',
    error: 'analysis_failed',
  }

  try {
    if (!process.env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY non configurée')
      return { ...fallback, error: 'service_unavailable' }
    }
    // `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Image,
                  },
                },
                {
                  text: GEMINI_PROMPT,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 500,
            responseMimeType: "application/json", 
          },
        }),
      }
    )

    if (!response.ok) {
      console.error('Gemini API error:', response.status, await response.text())
      return fallback
    }

    const data: any = await response.json()

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''

    // Nettoyage agressif
    let cleaned = rawText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/gi, '')
      .trim()

    // Si le JSON est tronqué, tenter de le compléter
    if (cleaned && !cleaned.endsWith('}')) {
      const lastComma = cleaned.lastIndexOf(',')
      const lastColon = cleaned.lastIndexOf(':')
      if (lastComma > lastColon) {
        cleaned = cleaned.substring(0, lastComma) + '}'
      } else {
        cleaned = cleaned + '"}'
      }
    }

    let result
    try {
      result = JSON.parse(cleaned)
    } catch (e) {
      console.error('JSON parse failed, raw:', rawText.substring(0, 100))
      return fallback
    }
    // const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''

    // // Nettoyer la réponse — Gemini ajoute parfois des backticks
    // const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim()

    // const result = JSON.parse(cleaned)

    // Valider les champs obligatoires
    const validCategories = ['voirie', 'eclairage', 'dechets', 'autre']
    const validConfidences = ['fort', 'moyen', 'faible']

    if (!validCategories.includes(result.category)) {
      result.category = 'autre'
    }
    if (!validConfidences.includes(result.confidence)) {
      result.confidence = 'moyen'
    }
    if (!result.title || result.title.length > 60) {
      result.title = 'Signalement urbain'
    }

    return result
  } catch (err) {
    console.error('Gemini analysis error:', err)
    return fallback
  }
}
