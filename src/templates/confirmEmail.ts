import { wordmarkImg, EMAIL_COLORS as COLORS } from './brand.js'

/**
 * La confirmation d'inscription d'un habitant.
 *
 * Cet e-mail était le seul de la plateforme à ne pas venir de nous : Supabase
 * l'envoyait, avec son expéditeur, son gabarit et un lien vers
 * `<projet>.supabase.co`. Un habitant qui crée son compte recevait donc, pour
 * son tout premier contact avec le service, un message qui ne lui ressemblait
 * pas et une adresse qu'il ne pouvait pas reconnaître — le meilleur moyen de
 * finir en indésirables, ou de n'être jamais cliqué.
 *
 * Deux variantes, et la seconde compte autant que la première :
 *
 *  - **un compte vient d'être créé** : le lien de confirmation ;
 *  - **l'adresse en avait déjà un** : on le dit *à cette adresse*, et à elle
 *    seule. L'API, elle, répond la même chose dans les deux cas — ne pas
 *    révéler qui a un compte est la règle de toutes les routes
 *    d'authentification. Mais quelqu'un qui a simplement oublié son inscription
 *    resterait sinon devant un « vérifiez vos e-mails » qui n'arrive jamais.
 *    L'écrire ici ne fuite rien : seul le titulaire de la boîte le lit.
 */

export interface ConfirmEmailParams {
  recipientEmail: string
  firstName?: string | null
  /** Le lien de confirmation. Absent quand l'adresse a déjà un compte. */
  actionLink?: string | null
  /** Où retrouver la connexion quand il n'y a rien à confirmer. */
  loginUrl: string
}

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.canvas};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLORS.canvas};padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
          <tr>
            <td align="center" style="padding-bottom:24px;">
              ${wordmarkImg(26)}
            </td>
          </tr>
          <tr>
            <td style="background-color:${COLORS.white};border-radius:12px;border:1px solid ${COLORS.line};padding:32px;">
${body}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px;">
              <p style="margin:0;font-size:12px;color:${COLORS.muted};">
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
}

export function buildConfirmEmail(params: ConfirmEmailParams): { html: string; text: string } {
  const greeting = params.firstName ? `Bonjour ${params.firstName},` : 'Bonjour,'

  if (!params.actionLink) {
    const body = `
              <p style="margin:0 0 16px;font-size:15px;color:${COLORS.ink};">${greeting}</p>

              <p style="margin:0 0 16px;font-size:15px;color:${COLORS.ink};">
                Une inscription vient d'être tentée avec cette adresse, mais
                <strong>vous avez déjà un compte OnSignale</strong>.
              </p>

              <p style="margin:0 0 24px;font-size:14px;color:${COLORS.muted};">
                Connectez-vous avec votre mot de passe habituel. Si vous l'avez oublié,
                utilisez « Mot de passe oublié » depuis l'écran de connexion.
              </p>

              <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
                <tr>
                  <td align="center" style="background-color:${COLORS.brand700};border-radius:8px;padding:14px 28px;">
                    <a href="${params.loginUrl}"
                      style="color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;display:block;">
                      Me connecter
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:12px;color:${COLORS.muted};text-align:center;">
                Si ce n'était pas vous, vous pouvez ignorer cet e-mail : rien n'a été modifié.
              </p>`

    return {
      html: shell('Vous avez déjà un compte OnSignale', body),
      text: [
        greeting,
        '',
        "Une inscription vient d'être tentée avec cette adresse, mais vous avez déjà un compte OnSignale.",
        '',
        `Connectez-vous ici : ${params.loginUrl}`,
        "Mot de passe oublié ? Utilisez « Mot de passe oublié » depuis l'écran de connexion.",
        '',
        "Si ce n'était pas vous, ignorez cet e-mail : rien n'a été modifié.",
      ].join('\n'),
    }
  }

  const body = `
              <p style="margin:0 0 16px;font-size:15px;color:${COLORS.ink};">${greeting}</p>

              <p style="margin:0 0 16px;font-size:15px;color:${COLORS.ink};">
                Bienvenue sur <strong>OnSignale</strong>. Il reste une étape : confirmer
                votre adresse e-mail.
              </p>

              <p style="margin:0 0 24px;font-size:14px;color:${COLORS.muted};">
                Ce lien est valable <strong>24 heures</strong>.
              </p>

              <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
                <tr>
                  <td align="center" style="background-color:${COLORS.brand700};border-radius:8px;padding:14px 28px;">
                    <a href="${params.actionLink}"
                      style="color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;display:block;">
                      Confirmer mon adresse
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 8px;font-size:12px;color:${COLORS.muted};text-align:center;">
                Si vous n'êtes pas à l'origine de cette inscription, ignorez cet e-mail —
                aucun compte ne sera activé.
              </p>

              <hr style="border:none;border-top:1px solid ${COLORS.line};margin:24px 0;" />

              <p style="margin:0;font-size:12px;color:${COLORS.muted};">
                Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br />
                <a href="${params.actionLink}" style="color:${COLORS.brand700};word-break:break-all;">${params.actionLink}</a>
              </p>`

  return {
    html: shell('Confirmez votre adresse e-mail', body),
    text: [
      greeting,
      '',
      'Bienvenue sur OnSignale. Il reste une étape : confirmer votre adresse e-mail.',
      '',
      `Confirmer : ${params.actionLink}`,
      'Ce lien est valable 24 heures.',
      '',
      "Si vous n'êtes pas à l'origine de cette inscription, ignorez cet e-mail.",
    ].join('\n'),
  }
}
