import { verifyEmail } from '@/lib/server/notifications-email';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const valid = await verifyEmail(new URL(request.url).searchParams.get('token') ?? '');
  return new Response(
    valid
      ? 'Email confirmed. You can close this page.'
      : 'This verification link expired or was already used. Request another in Settings.',
    {
      status: valid ? 200 : 400,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    }
  );
}
