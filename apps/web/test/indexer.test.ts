import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('refreshes with a new public cache key only after the write is indexed, without moving backwards', async () => {
  const fetcher = vi.fn(async () => Response.json({ monad: { block: { number: 200 } } }));
  vi.stubGlobal('fetch', fetcher);
  const { indexerGet, waitForIndexer } = await import('../src/lib/indexer');
  const queries = new QueryClient();
  const invalidated = vi.spyOn(queries, 'invalidateQueries');
  await indexerGet('/timeline?viewer=alice');
  expect(fetcher).toHaveBeenLastCalledWith('/indexer/timeline?viewer=alice', undefined);
  await waitForIndexer(queries, 123n);
  expect(fetcher).toHaveBeenLastCalledWith('/indexer/status', { cache: 'no-store' });
  expect(invalidated).toHaveBeenCalledWith({ queryKey: ['indexer'] });
  await indexerGet('/timeline?viewer=alice');
  expect(fetcher).toHaveBeenLastCalledWith('/indexer/timeline?viewer=alice&_after=123', undefined);
  await waitForIndexer(queries, 100n);
  await indexerGet('/trends');
  expect(fetcher).toHaveBeenLastCalledWith('/indexer/trends?_after=123', undefined);
});
