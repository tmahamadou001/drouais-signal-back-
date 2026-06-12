const COLORS = {
  primary: '#1A56A0',
  background: '#F9FAFB',
  white: '#FFFFFF',
  text: '#1F2937',
  textLight: '#6B7280',
  border: '#E5E7EB',
}

export interface InviteEmailParams {
  recipientEmail: string
  firstName?: string | null
  role: string
  tenantName: string
  cityName?: string | null
  invitedByEmail?: string | null
  /** Présent pour les nouveaux comptes. Absent si l'utilisateur existait déjà. */
  actionLink?: string | null
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrateur',
  agent: 'Agent',
  observer: 'Observateur',
}

export function buildInviteEmail(params: InviteEmailParams): { html: string; text: string } {
  const roleLabel = ROLE_LABELS[params.role] ?? params.role
  const greeting = params.firstName ? `Bonjour ${params.firstName},` : 'Bonjour,'
  const cityLabel = params.cityName ?? params.tenantName

  const isNewAccount = !!params.actionLink

  const ctaBlock = isNewAccount ? `
              <!-- CTA -->
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
                <tr>
                  <td align="center" style="background-color:${COLORS.primary};border-radius:8px;padding:14px 28px;">
                    <a href="${params.actionLink}"
                      style="color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;display:block;">
                      Créer mon mot de passe
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 8px;font-size:12px;color:${COLORS.textLight};text-align:center;">
                Ce lien est valable 24 heures. Si vous n'attendiez pas cette invitation, ignorez cet email.
              </p>

              <hr style="border:none;border-top:1px solid ${COLORS.border};margin:24px 0;" />

              <p style="margin:0;font-size:12px;color:${COLORS.textLight};">
                Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br />
                <a href="${params.actionLink}" style="color:${COLORS.primary};word-break:break-all;">${params.actionLink}</a>
              </p>` : `
              <p style="margin:0 0 8px;font-size:14px;color:${COLORS.textLight};">
                Vous pouvez vous connecter dès maintenant avec votre mot de passe habituel.
              </p>

              <p style="margin:0;font-size:12px;color:${COLORS.textLight};">
                Si vous n'attendiez pas ce message ou si vous pensez qu'il s'agit d'une erreur,
                contactez votre administrateur.
              </p>`

  const bodyText = isNewAccount
    ? `Vous avez été invité(e) à rejoindre OnSignale — ${cityLabel} en tant que ${roleLabel}.\n\nCliquez sur le lien ci-dessous pour créer votre mot de passe et accéder à votre compte :\n\n${params.actionLink}\n\nCe lien est valable 24 heures.\n\nSi vous n'attendiez pas cette invitation, ignorez cet email.`
    : `Vous avez été ajouté(e) à la plateforme OnSignale — ${cityLabel} en tant que ${roleLabel}.\n\nVotre compte existant a été associé à cet espace. Connectez-vous avec votre mot de passe habituel.`

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Invitation OnSignale</title>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.background};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLORS.background};padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <div style="display:inline-flex;align-items:center;gap:8px;">
                <div style="width:32px;height:32px;background-color:${COLORS.primary};border-radius:6px;display:inline-block;"></div>
                <span style="font-size:18px;font-weight:700;color:${COLORS.text};">OnSignale</span>
              </div>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:${COLORS.white};border-radius:12px;border:1px solid ${COLORS.border};padding:32px;">

              <p style="margin:0 0 16px;font-size:15px;color:${COLORS.text};">${greeting}</p>

              <p style="margin:0 0 16px;font-size:15px;color:${COLORS.text};">
                ${isNewAccount
                  ? `Vous avez été invité(e) à rejoindre la plateforme <strong>OnSignale — ${cityLabel}</strong> en tant que <strong>${roleLabel}</strong>.`
                  : `Votre compte a été ajouté à la plateforme <strong>OnSignale — ${cityLabel}</strong> en tant que <strong>${roleLabel}</strong>.`
                }
              </p>

              <p style="margin:0 0 24px;font-size:14px;color:${COLORS.textLight};">
                OnSignale est une plateforme de signalement urbain citoyen. Votre compte vous permettra
                de gérer et traiter les signalements soumis par les habitants.
              </p>

              ${ctaBlock}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:24px;">
              <p style="margin:0;font-size:12px;color:${COLORS.textLight};">
                © ${new Date().getFullYear()} OnSignale — Signalement urbain citoyen
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  const text = `${greeting}

${bodyText}

— L'équipe OnSignale`

  return { html, text }
}

// ─── Email de réinitialisation de mot de passe ────────────

export interface ResetEmailParams {
  recipientEmail: string
  firstName?: string | null
  cityName?: string | null
  actionLink: string
}

export function buildResetEmail(params: ResetEmailParams): { html: string; text: string } {
  const greeting = params.firstName ? `Bonjour ${params.firstName},` : 'Bonjour,'
  const cityLabel = params.cityName ?? 'OnSignale'

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Réinitialisation de mot de passe</title>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.background};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLORS.background};padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <div style="display:inline-flex;align-items:center;gap:8px;">
                <div style="width:32px;height:32px;background-color:${COLORS.primary};border-radius:6px;display:inline-block;"></div>
                <span style="font-size:18px;font-weight:700;color:${COLORS.text};">OnSignale</span>
              </div>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:${COLORS.white};border-radius:12px;border:1px solid ${COLORS.border};padding:32px;">

              <p style="margin:0 0 16px;font-size:15px;color:${COLORS.text};">${greeting}</p>

              <p style="margin:0 0 16px;font-size:15px;color:${COLORS.text};">
                Vous avez demandé à réinitialiser votre mot de passe pour votre compte
                <strong>OnSignale — ${cityLabel}</strong>.
              </p>

              <p style="margin:0 0 24px;font-size:14px;color:${COLORS.textLight};">
                Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe.
                Ce lien est valable <strong>1 heure</strong>.
              </p>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
                <tr>
                  <td align="center" style="background-color:${COLORS.primary};border-radius:8px;padding:14px 28px;">
                    <a href="${params.actionLink}"
                      style="color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;display:block;">
                      Réinitialiser mon mot de passe
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 8px;font-size:12px;color:${COLORS.textLight};text-align:center;">
                Si vous n'avez pas fait cette demande, ignorez cet email — votre mot de passe ne sera pas modifié.
              </p>

              <hr style="border:none;border-top:1px solid ${COLORS.border};margin:24px 0;" />

              <p style="margin:0;font-size:12px;color:${COLORS.textLight};">
                Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br />
                <a href="${params.actionLink}" style="color:${COLORS.primary};word-break:break-all;">${params.actionLink}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:24px;">
              <p style="margin:0;font-size:12px;color:${COLORS.textLight};">
                © ${new Date().getFullYear()} OnSignale — Signalement urbain citoyen
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  const text = `${greeting}

Vous avez demandé à réinitialiser votre mot de passe pour votre compte OnSignale — ${cityLabel}.

Cliquez sur le lien ci-dessous pour choisir un nouveau mot de passe (valable 1 heure) :

${params.actionLink}

Si vous n'avez pas fait cette demande, ignorez cet email.

— L'équipe OnSignale`

  return { html, text }
}
