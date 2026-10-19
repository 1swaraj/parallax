import { unsubscribeEmail } from '@/lib/server/notifications-email';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  await unsubscribeEmail(new URL(request.url).searchParams.get('token') ?? '');
  return new Response('Unsubscribed. You will receive no further digests.', {
    headers: { 'cache-control': 'no-store' },
  });
}
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!/^[a-f0-9]{64}$/.test(token)) return new Response('Invalid link', { status: 400 });
  return new Response(
    `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Unsubscribe</title><body><h1>Stop email digests</h1><form method="post" action="/api/email/unsubscribe?token=${token}"><button>Unsubscribe</button></form></body></html>`,
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    }
  );
}
