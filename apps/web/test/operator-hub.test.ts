import { describe, expect, it } from 'vitest';
import { setupChecklist, type ChecklistInput } from '../src/lib/admin-checklist';
import { sectionsFor } from '../src/lib/admin-sections';
import { settingUpPage } from '../src/lib/server/setting-up-page';

const ready: ChecklistInput = {
  config: {
    appName: 'Parallax',
    logoUrl: '',
    iconUrl: '',
    indexerUrl: 'https://indexer.example',
    emailFrom: '',
    moderation: { signupMode: 'open', sponsorship: 'everyone' },
  },
  health: {
    paused: false,
    relayers: [{ allowlisted: true, low: false }],
    indexer: { lag: 2 },
    gas: { budgetPerHour: '500000000' },
  },
  resendKeySet: false,
  teamSize: 1,
};
const status = (input: ChecklistInput, id: string) =>
  setupChecklist(input).find((item) => item.id === id)!;

describe('admin sections', () => {
  it('shows each role only the pages it can open', () => {
    expect(sectionsFor('owner').map((s) => s.slug)).toContain('team');
    expect(sectionsFor('admin').map((s) => s.slug)).not.toContain('team');
    expect(sectionsFor('moderator').map((s) => s.slug)).toEqual(['moderation', 'moderation-log']);
  });
});

describe('setup checklist', () => {
  it('marks a working instance done and leaves choices optional', () => {
    expect(status(ready, 'network').status).toBe('done');
    expect(status(ready, 'sponsorship').status).toBe('done');
    expect(status(ready, 'branding').status).toBe('optional');
    expect(status(ready, 'email').status).toBe('optional');
    expect(status(ready, 'team').status).toBe('optional');
    expect(setupChecklist(ready).filter((item) => item.status === 'todo')).toEqual([]);
  });
  it('flags a missing or silent indexer', () => {
    expect(
      status({ ...ready, config: { ...ready.config, indexerUrl: '' } }, 'network').status
    ).toBe('todo');
    expect(
      status({ ...ready, health: { ...ready.health, indexer: { lag: null } } }, 'network')
    ).toMatchObject({
      status: 'todo',
      detail: expect.stringContaining("isn't responding"),
    });
  });
  it('walks sponsorship through keys, allowlisting, budget and balance; pausing is a choice', () => {
    const health = (patch: Partial<ChecklistInput['health']>) => ({
      ...ready,
      health: { ...ready.health, ...patch },
    });
    expect(status(health({ paused: true, relayers: [] }), 'sponsorship').status).toBe('optional');
    expect(status(health({ relayers: [] }), 'sponsorship').detail).toContain('relayer key');
    expect(
      status(health({ relayers: [{ allowlisted: false, low: false }] }), 'sponsorship').detail
    ).toContain('allowlisted');
    // An unreachable RPC can't tell: say so instead of blaming the allowlist.
    expect(
      status(health({ relayers: [{ allowlisted: null, low: false }] }), 'sponsorship').detail
    ).toContain("Couldn't check");
    expect(status(health({ gas: { budgetPerHour: null } }), 'sponsorship').detail).toContain(
      'gas budget'
    );
    expect(
      status(health({ relayers: [{ allowlisted: true, low: true }] }), 'sponsorship').detail
    ).toContain('low on MON');
  });
  it('counts branding, email, moderation and team once configured', () => {
    const configured: ChecklistInput = {
      ...ready,
      config: {
        ...ready.config,
        appName: 'Community',
        emailFrom: 'hi@community.example',
        moderation: { signupMode: 'invite', sponsorship: 'members' },
      },
      resendKeySet: true,
      teamSize: 3,
    };
    for (const id of ['branding', 'email', 'moderation', 'team'])
      expect(status(configured, id).status).toBe('done');
  });
});

describe('setting-up page', () => {
  const config = {
    appName: 'Parallax',
    tagline: 'Your followers come with you.',
    accentColor: '#6e54ff',
    accentColorDark: '#9f8fff',
  };
  it('links the operator to setup, the guide and status', () => {
    const html = settingUpPage(config);
    expect(html).toContain('Parallax is being set up');
    expect(html).toContain('href="/setup"');
    expect(html).toContain('#running-your-own-instance');
    expect(html).toContain('href="/api/health"');
  });
  it('escapes instance settings and refuses non-hex colors', () => {
    const html = settingUpPage({
      ...config,
      appName: '<script>alert(1)</script>',
      tagline: '"quoted" & <b>',
      accentColor: 'red;}body{display:none',
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;quoted&quot; &amp; &lt;b&gt;');
    expect(html).not.toContain('display:none');
  });
});
