/**
 * Mirror mode (PONDER_MIRROR=true, README): the indexer reads the read-only mirror of Lens Chain, whose importers emit
 * events of their own, rather than the launch deployment. The config lists one deployment's contracts, and only their
 * handlers are registered: index.ts's for the launch deployment, mirror.ts's for the mirror.
 */
export const MIRROR = process.env.PONDER_MIRROR === 'true';
