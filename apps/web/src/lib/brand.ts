/** Default branding. Runtime clients use useBrand(); server callers pass instance config to brandCopy(). */
export const APP_NAME = 'Parallax';
export const APP_TAGLINE = 'Your followers come with you.';

export function brandCopy(config: { appName: string; tagline: string }) {
  return {
    APP_NAME: config.appName,
    APP_TAGLINE: config.tagline,
    APP_PITCH: `On ${config.appName}, your followers and posts are on Lens (Monad). Any Lens app can read them, and no one can take them away from you.`,
    APP_DESCRIPTION: `${config.appName} is a social app on Lens Protocol, running on Monad. Your account, username, followers and posts live onchain, so they come with you to any Lens app.`,
  };
}
