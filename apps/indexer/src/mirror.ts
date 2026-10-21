import { ponder } from 'ponder:registry';
import { MIRROR } from './mode';
import {
  accountImported,
  accountMapped,
  blockImported,
  feedCountersImported,
  followImported,
  postImported,
  usernameImported,
} from './mirror-handlers';

// Mirror mode (README): the read-only mirror of Lens Chain, a Lens deployment in migration mode that is never sealed.
// Its importers stand behind the canonical proxies, so normal writes revert, and they emit their own events, which
// these handlers turn into the tables the launch deployment's handlers write (index.ts). Only in mirror mode, whose
// config lists the importers.
if (MIRROR) {
  ponder.on('MigrationAccountDeployer:AccountMapped', ({ event, context }) =>
    accountMapped(event, context)
  );
  ponder.on('MigrationAccount:AccountImported', ({ event, context }) =>
    accountImported(event, context)
  );
  ponder.on('MigrationNamespace:UsernameImported', ({ event, context }) =>
    usernameImported(event, context)
  );
  ponder.on('MigrationFeed:PostImported', ({ event, context }) => postImported(event, context));
  ponder.on('MigrationFeed:FeedCountersImported', ({ event, context }) =>
    feedCountersImported(event, context)
  );
  ponder.on('MigrationGraph:FollowImported', ({ event, context }) =>
    followImported(event, context)
  );
  ponder.on('MigrationAccountBlockingRule:BlockImported', ({ event, context }) =>
    blockImported(event, context)
  );
}
