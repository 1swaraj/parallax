import { fileURLToPath } from 'node:url';

// The indexer's unit tests run with @lens-monad/protocol's vitest (package.json), so this config imports nothing
// from it. The mirror's handlers import their tables from Ponder's virtual module, which is the schema file.
export default {
  resolve: {
    alias: { 'ponder:schema': fileURLToPath(new URL('./ponder.schema.ts', import.meta.url)) },
  },
};
