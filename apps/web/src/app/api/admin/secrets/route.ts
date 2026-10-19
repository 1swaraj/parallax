import { NextResponse } from 'next/server';
import { z } from 'zod';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { requireAdmin, adminDatabase } from '@/lib/server/admin';
import { assertSameOrigin, handle, HttpError } from '@/lib/server/guard';
import { getInstanceConfig } from '@/lib/server/instance-config';
import { SECRET_ENV, getStoredSecret, writeSecret, secretStatus } from '@/lib/server/secrets';
import { parseRelayerKeys } from '@/lib/server/env';
import { relayers } from '@/lib/server/relayers';

export const dynamic = 'force-dynamic';
export async function GET() {
  return handle(async () => {
    await requireAdmin('config');
    return NextResponse.json(
      {
        secrets: await secretStatus(),
        relayers: (await relayers().catch(() => [])).map((a) => a.address),
      },
      { headers: { 'cache-control': 'no-store' } }
    );
  });
}
export async function POST(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin('config');
    assertSameOrigin(request);
    const body = z
      .object({
        name: z.enum(
          Object.keys(SECRET_ENV) as [keyof typeof SECRET_ENV, ...(keyof typeof SECRET_ENV)[]]
        ),
        value: z.string().trim().min(1).max(16384).optional(),
        generate: z.boolean().optional(),
      })
      .parse(await request.json());
    const sql = adminDatabase();
    let value = body.value;
    if (body.generate && body.name === 'relayerPrivateKeys') {
      // Serialize generation and append so two administrators cannot discard each other's keys.
      const key = generatePrivateKey();
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended('lens_web:relayer-keys', 0))`;
        const current = await getStoredSecret('relayerPrivateKeys', tx);
        const combined = current ? `${current},${key}` : key;
        parseRelayerKeys(combined);
        await writeSecret(tx, body.name, combined, admin.address);
      });
      const config = await getInstanceConfig();
      const address = privateKeyToAddress(key);
      return NextResponse.json(
        {
          address,
          funding: `Fund this address with at least ${config.relayerMinBalanceMon} MON`,
          command: `cast send ${config.sponsorRouter} 'setRelayer(address,bool)' ${address} true --rpc-url <rpc-url> --account <owner-keystore>`,
          overridden: !!process.env.RELAYER_PRIVATE_KEYS || !!process.env.RELAYER_PRIVATE_KEY,
        },
        { headers: { 'cache-control': 'no-store' } }
      );
    }
    if (!value) throw new HttpError(400, 'A secret value is required');
    if (body.name === 'relayerPrivateKeys') parseRelayerKeys(value);
    await sql.begin(async (tx) => {
      if (body.name === 'relayerPrivateKeys')
        await tx`SELECT pg_advisory_xact_lock(hashtextextended('lens_web:relayer-keys', 0))`;
      await writeSecret(tx, body.name, value!, admin.address);
    });
    return NextResponse.json({ saved: true }, { headers: { 'cache-control': 'no-store' } });
  });
}
