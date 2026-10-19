import { notFound } from 'next/navigation';
import { setupStatus } from '@/lib/server/setup';
import { findAdmin } from '@/lib/server/admin';
import { getInstanceConfig } from '@/lib/server/instance-config';
import { CONFIG_ENV, InstanceConfig } from '@/lib/instance-schema';
import { SetupWizard } from '@/components/setup-wizard';
export const dynamic = 'force-dynamic';
export default async function SetupPage() {
  const status = await setupStatus();
  if (status.completed) notFound();
  if (status.claimed && (await findAdmin())?.role !== 'owner') notFound();
  const overrides = Object.entries(CONFIG_ENV)
    .filter(([, keys]) => keys.some((key) => !!process.env[key]))
    .map(([key]) => key);
  return (
    <SetupWizard
      config={status.claimed ? await getInstanceConfig() : InstanceConfig.parse({})}
      overrides={overrides}
      claimed={status.claimed}
    />
  );
}
