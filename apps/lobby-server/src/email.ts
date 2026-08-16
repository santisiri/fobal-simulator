// Transactional email — the lobby's one outbound-mail seam.
//
// EmailProvider is deliberately small: two message kinds, one send method
// each. Implementations: SES (the established provider — deployed on both
// envs, task-role IAM, lobby@fobal.ai identity) and Resend (one API key,
// works for arbitrary recipients while the SES production-access case is
// pending, and brings signed delivery webhooks). Selected by
// FOBAL_EMAIL_BACKEND; game logic never sees a vendor type.
//
// CREDENTIALS ARE SERVER-SIDE ONLY. The Resend key and webhook secret live
// in env/Secrets Manager; nothing in this module is ever imported by
// browser code.
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

export interface MatchInvitationEmail {
  to: string;
  /** display identity: handle or wallet-derived name */
  inviterName: string;
  inviterTeam: string;
  /** optional note typed by the inviter (already sanitized + length-capped) */
  message?: string;
  /** the secure invitation link */
  inviteUrl: string;
  expiresAt: string;               // ISO
}

export interface EmailProvider {
  /** magic-code sign-in (the original deliverCode seam) */
  sendLoginCode(email: string, code: string): Promise<void>;
  /** "you have been challenged to a football match" */
  sendMatchInvitation(invite: MatchInvitationEmail): Promise<{ messageId?: string }>;
}

// ---------------------------------------------------------------------------
// the invitation template — a football challenge, not a crypto artifact.
// Email clients are not browsers: table layout, inline styles, no fonts
// beyond safe stacks, dark-mode-tolerant solid colors.
// ---------------------------------------------------------------------------

const escHtml = (s: string): string => s.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function renderInvitationEmail(invite: MatchInvitationEmail): { subject: string; html: string; text: string } {
  const inviter = escHtml(invite.inviterName);
  const team = escHtml(invite.inviterTeam);
  const note = invite.message ? escHtml(invite.message) : '';
  const expires = new Date(invite.expiresAt).toUTCString().replace(/:\d\d GMT$/, ' UTC');
  const subject = `${invite.inviterName} challenged you to a football match`;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background-color:#0a0f1e;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0f1e;">
<tr><td align="center" style="padding:36px 16px;">
  <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
    <tr><td style="font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:18px;letter-spacing:2px;color:#f8fafc;padding-bottom:22px;">
      FOBAL<span style="color:#22c55e;">.ai</span>
    </td></tr>
    <tr><td style="background-color:#0d1428;border:1px solid #26314f;border-radius:12px;padding:30px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:3px;color:#22c55e;padding-bottom:14px;">MATCH CHALLENGE</td></tr>
        <tr><td style="font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:26px;line-height:1.2;color:#f8fafc;padding-bottom:10px;">
          ${inviter} challenged you to a football match
        </td></tr>
        <tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#b7c0d8;padding-bottom:6px;">
          Their club, <b style="color:#f8fafc;">${team}</b>, is waiting for an opponent.
          You coach live — call the shots with your voice, in any language.
        </td></tr>
        ${note ? `<tr><td style="padding:12px 0 4px;"><table role="presentation" width="100%"><tr>
          <td style="border-left:3px solid #22c55e;padding:6px 12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-style:italic;color:#b7c0d8;">&ldquo;${note}&rdquo;</td>
        </tr></table></td></tr>` : ''}
        <tr><td align="center" style="padding:24px 0 8px;">
          <a href="${invite.inviteUrl}" style="display:inline-block;background-color:#22c55e;color:#041a0c;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:16px;letter-spacing:1px;text-decoration:none;padding:15px 44px;border-radius:10px;">JOIN THE MATCH</a>
        </td></tr>
        <tr><td align="center" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#7c869e;padding-top:8px;">
          This invitation expires ${expires}.
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#7c869e;padding-top:18px;">
      Free to play in your browser &mdash; nothing to install.
      If you weren't expecting this, you can safely ignore it; the link only opens a game invitation.
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  const text =
    `${invite.inviterName} challenged you to a football match\n\n` +
    `Their club, ${invite.inviterTeam}, is waiting for an opponent. ` +
    `You coach live — call the shots with your voice, in any language.\n\n` +
    (invite.message ? `"${invite.message}"\n\n` : '') +
    `Join the match: ${invite.inviteUrl}\n\n` +
    `This invitation expires ${expires}.\n` +
    `Free to play in your browser — nothing to install. ` +
    `If you weren't expecting this, you can safely ignore it.\n`;

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// SES — the established provider (task-role IAM, no key material at all)
// ---------------------------------------------------------------------------

export interface SesProviderOptions {
  /** verified sender, e.g. lobby@fobal.ai / matches@fobal.ai */
  from: string;
  /** injectable for tests */
  client?: SESv2Client;
}

export function createSesProvider(options: SesProviderOptions): EmailProvider {
  const client = options.client ?? new SESv2Client({});
  return {
    async sendLoginCode(email, code) {
      await client.send(new SendEmailCommand({
        FromEmailAddress: options.from,
        Destination: { ToAddresses: [email] },
        Content: {
          Simple: {
            Subject: { Data: `${code} is your FOBAL sign-in code` },
            Body: {
              Text: { Data:
                `Your FOBAL sign-in code is: ${code}\n\n` +
                'It expires in 15 minutes and works once.\n' +
                "If you didn't request it, you can ignore this email.\n" },
            },
          },
        },
      }));
    },
    async sendMatchInvitation(invite) {
      const { subject, html, text } = renderInvitationEmail(invite);
      const out = await client.send(new SendEmailCommand({
        FromEmailAddress: options.from,
        Destination: { ToAddresses: [invite.to] },
        Content: {
          Simple: {
            Subject: { Data: subject },
            Body: { Html: { Data: html }, Text: { Data: text } },
          },
        },
      }));
      return { messageId: out.MessageId };
    },
  };
}

/** Back-compat: the original deliverCode factory, now a thin view over the
 *  provider. Existing call sites and tests keep working unchanged. */
export interface SesDelivererOptions extends SesProviderOptions {}
export function createSesDeliverer(options: SesDelivererOptions): (email: string, code: string) => Promise<void> {
  const provider = createSesProvider(options);
  return (email, code) => provider.sendLoginCode(email, code);
}

// ---------------------------------------------------------------------------
// Resend — one API key, arbitrary recipients, signed delivery webhooks
// ---------------------------------------------------------------------------

export interface ResendProviderOptions {
  /** sender on a domain verified in the Resend dashboard */
  from: string;
  /** SERVER-SIDE secret (FOBAL_RESEND_API_KEY / Secrets Manager) */
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export function createResendProvider(options: ResendProviderOptions): EmailProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  async function send(payload: Record<string, unknown>): Promise<{ messageId?: string }> {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: options.from, ...payload }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({})) as { id?: string; message?: string };
    if (!res.ok) throw new Error(`resend answered ${res.status}: ${body.message ?? 'send failed'}`);
    return { messageId: body.id };
  }
  return {
    async sendLoginCode(email, code) {
      await send({
        to: [email],
        subject: `${code} is your FOBAL sign-in code`,
        text:
          `Your FOBAL sign-in code is: ${code}\n\n` +
          'It expires in 15 minutes and works once.\n' +
          "If you didn't request it, you can ignore this email.\n",
      });
    },
    async sendMatchInvitation(invite) {
      const { subject, html, text } = renderInvitationEmail(invite);
      return send({ to: [invite.to], subject, html, text });
    },
  };
}
