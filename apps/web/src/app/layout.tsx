import type { Metadata, Viewport } from 'next';
import { Inter, Roboto_Mono } from 'next/font/google';
import { Shell } from '@/components/shell';
import { THEME_INIT_SCRIPT } from '@/components/theme';
import { brandCopy } from '@/lib/brand';
import { getInstanceConfig } from '@/lib/server/instance-config';
import { getSecret } from '@/lib/server/secrets';
import { publicConfig } from '@/lib/instance-schema';
import './globals.css';
import { Providers } from './providers';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const robotoMono = Roboto_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-roboto-mono',
  display: 'swap',
});

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  const config = await getInstanceConfig();
  return {
    metadataBase: config.appUrl ? new URL(config.appUrl) : undefined,
    title: { default: `${config.appName}: ${config.tagline}`, template: `%s · ${config.appName}` },
    description: brandCopy(config).APP_DESCRIPTION,
    applicationName: config.appName,
    openGraph: { siteName: config.appName, type: 'website' },
    twitter: { card: 'summary' },
    icons: { icon: config.iconUrl || '/icon' },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfaf9' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const config = await getInstanceConfig();
  const runtime = publicConfig(
    config,
    (await getSecret('walletConnectProjectId')) ?? '',
    !!process.env.DATABASE_URL &&
      !!process.env.INSTANCE_SECRET &&
      config.userEmailEnabled &&
      !!config.appUrl &&
      !!config.emailFrom &&
      !!(await getSecret('resendApiKey'))
  );
  const style = {
    '--instance-accent': config.accentColor,
    '--instance-accent-dark': config.accentColorDark,
  } as React.CSSProperties;

  return (
    <html
      style={style}
      data-default-theme={config.defaultTheme}
      lang="en"
      className={`${inter.variable} ${robotoMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <Providers config={runtime}>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
