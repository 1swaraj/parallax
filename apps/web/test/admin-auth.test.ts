import { afterEach, describe, expect, it, vi } from 'vitest';
import { roleAllowed } from '../src/lib/server/admin';

const { session, lookup } = vi.hoisted(() => ({
  session: vi.fn().mockResolvedValue({}),
  lookup: vi.fn(),
}));
vi.mock('../src/lib/server/session', () => ({ getSession: session }));
vi.mock('../src/lib/server/db', async (original) => ({
  ...(await original<typeof import('../src/lib/server/db')>()),
  database: () => null,
}));

const routes = [
  ['config', ['GET', 'PUT']],
  ['secrets', ['GET', 'POST']],
  ['team', ['GET', 'PUT', 'DELETE']],
  ['audit', ['GET']],
  ['overview', ['GET']],
  ['email', ['POST']],
  ['network', ['POST']],
  ['preferences', ['PUT']],
] as const;
afterEach(() => {
  vi.unstubAllEnvs();
  session.mockResolvedValue({});
});

describe('administrator authorization', () => {
  it('restricts configuration to admins and owners, and team writes to the owner', () => {
    expect(roleAllowed(undefined, 'read')).toBe(false);
    for (const scope of ['read', 'moderation'] as const)
      expect(roleAllowed('moderator', scope)).toBe(true);
    expect(roleAllowed('moderator', 'config')).toBe(false);
    expect(roleAllowed('admin', 'config')).toBe(true);
    expect(roleAllowed('admin', 'team')).toBe(false);
    expect(roleAllowed('owner', 'team')).toBe(true);
  });
  for (const [route, methods] of routes)
    for (const method of methods) {
      it(`${method} /api/admin/${route} returns 404 to a signed-out visitor`, async () => {
        const module = await import(`../src/app/api/admin/${route}/route.ts`);
        const response = await module[method](
          new Request(`http://localhost/api/admin/${route}`, {
            method,
            headers: {
              origin: 'http://localhost',
              host: 'localhost',
              'content-type': 'application/json',
            },
            ...(method !== 'GET' ? { body: '{}' } : {}),
          })
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Not found' });
      });
      it(`${method} /api/admin/${route} returns 404 to a signed-in non-admin`, async () => {
        session.mockResolvedValue({ owner: '0x0000000000000000000000000000000000000001' });
        const module = await import(`../src/app/api/admin/${route}/route.ts`);
        expect(
          (await module[method](new Request(`http://localhost/api/admin/${route}`, { method })))
            .status
        ).toBe(404);
      });
    }
});
