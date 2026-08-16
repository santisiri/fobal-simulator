// SES login-code delivery — the production implementation of the lobby's
// deliverCode seam. The FROM identity (fobal.ai) must be verified in SES;
// until the account leaves the SES sandbox, recipients must be verified too.
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

export interface SesDelivererOptions {
  /** verified sender, e.g. lobby@fobal.ai */
  from: string;
  /** injectable for tests */
  client?: SESv2Client;
}

export function createSesDeliverer(options: SesDelivererOptions): (email: string, code: string) => Promise<void> {
  const client = options.client ?? new SESv2Client({});
  return async (email, code) => {
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
  };
}
