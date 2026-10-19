import { Resend } from 'resend';
import type { CreateEmailOptions } from 'resend';
import { getInstanceConfig } from './instance-config';
import { getSecret } from './secrets';

export async function resendClient(): Promise<Resend | null> {
  const key = await getSecret('resendApiKey');
  return key ? new Resend(key) : null;
}
/** Plain text templates keep operator branding and user content out of HTML markup. */
export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
  unsubscribe?: string;
  idempotencyKey?: string;
}) {
  const [config, client] = await Promise.all([getInstanceConfig(), resendClient()]);
  if (!client || !config.emailFrom) throw new Error('Email is not configured');
  const message: CreateEmailOptions = {
    from: config.emailFrom,
    to: input.to,
    subject: `${config.appName}: ${input.subject}`,
    text: `${config.appName}\n${config.tagline}\n\n${input.text}${input.unsubscribe ? `\n\nUnsubscribe: ${input.unsubscribe}` : ''}`,
    ...(input.unsubscribe
      ? {
          headers: {
            'List-Unsubscribe': `<${input.unsubscribe}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }
      : {}),
  };
  const { data, error } = await client.emails.send(message, {
    signal: AbortSignal.timeout(10_000),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });
  if (error) throw new Error(`Email provider rejected the request (${error.name})`);
  return data;
}
export async function checkEmailDomain() {
  const [config, client] = await Promise.all([getInstanceConfig(), resendClient()]);
  if (!client || !config.emailDomain) throw new Error('Set a Resend key and verified domain first');
  const list = await client.domains.list(undefined, { signal: AbortSignal.timeout(10_000) });
  if (list.error) throw new Error('Could not read Resend domains');
  const domain = list.data?.data.find(
    (domain) => domain.name.toLowerCase() === config.emailDomain.toLowerCase()
  );
  if (!domain) return { domain: config.emailDomain, status: 'not found', records: [] };
  const result = await client.domains.get(domain.id, { signal: AbortSignal.timeout(10_000) });
  if (result.error) throw new Error('Could not check Resend domain');
  return { domain: domain.name, status: result.data?.status, records: result.data?.records ?? [] };
}
