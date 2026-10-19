import { describe, expect, it } from 'vitest';
import {
  accessDecision,
  accountRate,
  allowedIdentity,
  contentDecision,
  emptyModeration,
  FilterInput,
  matchesFilter,
  ModerationPolicy,
  sponsorshipDecision,
} from '../src/lib/moderation-policy';
import {
  hiddenPost,
  homeAllowed,
  moderatePost,
  moderateThread,
  filteredPage,
  visibleNotification,
} from '../src/lib/server/moderation-reads';
import { account, accountView, other, owner, postView, status } from './moderation-fixtures';

describe('access policy', () => {
  it.each(['open', 'invite', 'allowlist', 'token'])(
    'accepts the %s policy branch',
    (signupMode) => {
      expect(ModerationPolicy.parse({ signupMode, token: { address: other } }).signupMode).toBe(
        signupMode
      );
    }
  );
  it.each(['allow', 'approval', 'allowlist'] as const)(
    'enforces external %s',
    (externalAccounts) => {
      const state = emptyModeration(),
        policy = ModerationPolicy.parse({ externalAccounts });
      expect(accessDecision(policy, state, owner, account) === null).toBe(
        externalAccounts === 'allow'
      );
      state.accounts.set(account, status({ member: true }));
      expect(accessDecision(policy, state, owner, account)).toBeNull();
      state.accounts.set(account, status({ approved: true }));
      expect(accessDecision(policy, state, owner, account) === null).toBe(
        externalAccounts !== 'allowlist'
      );
      state.allowlist.add(owner);
      expect(accessDecision(policy, state, owner, account)).toBeNull();
    }
  );
  it('matches addresses case insensitively and suspends a member, approved account or wallet', () => {
    const state = emptyModeration(),
      policy = ModerationPolicy.parse({});
    state.allowlist.add(account);
    expect(allowedIdentity(state, owner, account.toUpperCase())).toBe(true);
    state.accounts.set(account, status({ suspended: true, approved: true, member: true }));
    expect(accessDecision(policy, state, owner, account)).toMatch(/suspended/);
    state.accounts.clear();
    state.accounts.set(owner, status({ suspended: true }));
    expect(accessDecision(policy, state, owner)).toMatch(/suspended/);
  });
});
describe('sponsorship policy', () => {
  it.each([
    ['everyone', {}, true],
    ['everyone', { sponsorRevoked: true }, false],
    ['members', {}, false],
    ['members', { member: true }, true],
    ['approved', { member: true }, false],
    ['approved', { approved: true }, true],
    ['nobody', { member: true, approved: true }, false],
  ] as const)('%s with %j sponsors=%s', (sponsorship, patch, accepted) => {
    expect(
      sponsorshipDecision(ModerationPolicy.parse({ sponsorship }), status(patch)) === null
    ).toBe(accepted);
  });
  it('treats unknown accounts as new, denies or rate limits cooldown, and expires it', () => {
    const policy = ModerationPolicy.parse({ cooldownHours: 2 });
    expect(sponsorshipDecision(policy)).toMatch(/cooldown/);
    const now = Date.now(),
      fresh = status({ createdAt: now, approved: true });
    expect(sponsorshipDecision(policy, fresh, now)).toMatch(/cooldown/);
    expect(accountRate(policy, fresh, now)).toBe(5);
    expect(sponsorshipDecision({ ...policy, cooldownAction: 'limit' }, fresh, now)).toBeNull();
    expect(sponsorshipDecision(policy, fresh, now + 7200_000)).toBeNull();
    expect(accountRate(policy, fresh, now + 7200_000)).toBe(60);
    expect(accountRate(policy, status())).toBe(30);
  });
});
describe('filters and reads', () => {
  it.each(['block', 'hide', 'label'] as const)(
    'applies %s for words, domains and regex',
    (action) => {
      for (const [kind, pattern, text] of [
        ['word', 'spam', 'SPAM here'],
        ['link', 'bad.example', 'https://sub.bad.example/x'],
        ['regex', 's+pam', 'ssspam'],
      ] as const) {
        const filter = { id: '1', kind, pattern, action, reason: 'warning' };
        const result = contentDecision([filter], text);
        expect(result.blocked).toBe(action === 'block');
        expect(result.hidden).toBe(action !== 'label');
        expect(result.label).toBe(action === 'label' ? 'warning' : null);
      }
    }
  );
  it('does not match unrelated domains, rejects invalid syntax, and uses RE2 for hostile patterns', () => {
    const filter = {
      id: '1',
      kind: 'link' as const,
      pattern: 'bad.example',
      action: 'hide' as const,
      reason: 'spam',
    };
    expect(matchesFilter(filter, 'https://notbad.example https://bad.example.evil.test')).toBe(
      false
    );
    expect(FilterInput.safeParse({ ...filter, pattern: 'https://bad.example' }).success).toBe(
      false
    );
    expect(FilterInput.safeParse({ ...filter, kind: 'regex', pattern: '(?=a)' }).success).toBe(
      false
    );
    expect(FilterInput.safeParse({ ...filter, kind: 'regex', pattern: '[' }).success).toBe(false);
    expect(
      matchesFilter({ ...filter, kind: 'regex', pattern: '(a+)+$' }, 'a'.repeat(25000) + '!')
    ).toBe(false);
  });
  it.each(['network', 'members', 'curated'] as const)('enforces %s home scope', (homeFeed) => {
    const policy = ModerationPolicy.parse({ homeFeed }),
      state = emptyModeration(),
      post = postView();
    expect(homeAllowed(post, policy, state)).toBe(homeFeed === 'network');
    state.accounts.set(account, status({ member: true }));
    expect(homeAllowed(post, policy, state)).toBe(homeFeed !== 'curated');
    expect(homeAllowed(post, { ...policy, curatedAccounts: [account] }, state)).toBe(true);
  });
  it.each(['post', 'account', 'suspension', 'filter'])(
    'redacts a hidden %s in threads and nested references',
    (source) => {
      const state = emptyModeration(),
        post = postView();
      if (source === 'post') state.posts.set('1', { action: 'hide', reason: 'spam' });
      if (source === 'account') state.accounts.set(account, status({ hidden: true }));
      if (source === 'suspension') state.accounts.set(account, status({ suspended: true }));
      if (source === 'filter')
        state.filters.push({
          id: '1',
          kind: 'word',
          pattern: 'hello',
          action: 'hide',
          reason: 'spam',
        });
      expect(hiddenPost(post, state)).toBe(true);
      const thread = moderateThread({ post, ancestors: [post], replies: [post] }, state);
      expect(thread.post).toMatchObject({
        deleted: true,
        content: null,
        contentUri: '',
        moderation: { hidden: true },
      });
      expect(thread.ancestors[0]!.content).toBeNull();
      expect(thread.replies).toHaveLength(0);
      const nested = postView('2', other, 'safe');
      nested.quoted = post;
      expect(moderatePost(nested, state).quoted!.content).toBeNull();
      nested.reposted = post;
      expect(hiddenPost(nested, state)).toBe(true);
      expect(
        visibleNotification(
          { id: '1:0', type: 'reply', actor: accountView(other), post, createdAt: '1' },
          state
        )
      ).toBe(false);
    }
  );
  it('returns content warnings for account, post and word labels', () => {
    const state = emptyModeration(),
      post = postView();
    state.filters.push({
      id: '1',
      kind: 'word',
      pattern: 'hello',
      action: 'label',
      reason: 'word warning',
    });
    expect(moderatePost(post, state).moderation!.warning).toBe('word warning');
    state.accounts.set(account, status({ label: 'account warning' }));
    expect(moderatePost(post, state).moderation!.warning).toBe('account warning');
    state.posts.set('1', { action: 'label', reason: 'post warning' });
    expect(moderatePost(post, state).moderation!.warning).toBe('post warning');
  });
  it('over-fetches without skipping or repeating visible items across pages', async () => {
    const all = Array.from({ length: 40 }, (_, i) => i + 1);
    const load = async (cursor: string | null, limit: number) => {
      const start = Number(cursor ?? 0),
        items = all.slice(start, start + limit);
      return { items, next: start + limit < all.length ? String(start + limit) : null };
    };
    let cursor: string | null = null;
    const seen: number[] = [];
    do {
      const page: { items: number[]; next: string | null } = await filteredPage(
        load,
        (n) => (n % 3 ? n : null),
        4,
        cursor
      );
      seen.push(...page.items);
      cursor = page.next;
    } while (cursor);
    expect(seen).toEqual(all.filter((n) => n % 3));
  });
  it('preserves a continuation on fully hidden bounded pages and rejects repeated cursors', async () => {
    const page = await filteredPage(
      async (cursor) => ({ items: [0], next: String(Number(cursor ?? 0) + 1) }),
      () => null,
      2,
      null,
      3
    );
    expect(page).toEqual({ items: [], next: '3' });
    await expect(
      filteredPage(
        async () => ({ items: [], next: '1' }),
        () => null,
        2,
        '1'
      )
    ).rejects.toThrow(/repeated/);
  });
});
