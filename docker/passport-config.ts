// Registers this app with the local Community Passport as a club, for the passport service in compose.yaml. Writes,
// in STATE_DIR: clubs.json (the registration), passport.env (the Passport's configuration) and admin.txt (what to
// enter in Admin → Community Passport).
//
//   STATE_DIR=… REGISTRY=0x… FORWARDER=0x… node --import tsx docker/passport-config.ts
//
// Local only: the relayer key is anvil's 9th test account, from its public test phrase.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress, toFunctionSelector, type Abi } from 'viem';
import {
  MEDIA_STORE_ADDRESS,
  accountBlockingRuleAbi,
  feedAbi,
  getDeployment,
  graphAbi,
  mediaStoreAbi,
} from '../packages/protocol/src';

const { STATE_DIR, REGISTRY, FORWARDER } = process.env;
if (!STATE_DIR || !REGISTRY || !FORWARDER) throw new Error('Set STATE_DIR, REGISTRY and FORWARDER');
const registry = getAddress(REGISTRY);
const forwarder = getAddress(FORWARDER);
const contracts = getDeployment(31337).contracts;
const selector = (abi: Abi, name: string) =>
  toFunctionSelector(abi.find((item) => item.type === 'function' && item.name === name) as never);

// What /api/relay sends for a member (sponsor.ts). Deleting reaches posts made in other apps, so it's optional.
const permissions = [
  ['Post and reply as you', contracts.LensGlobalFeed, selector(feedAbi, 'createPost')],
  ['Follow people as you', contracts.LensGlobalGraph, selector(graphAbi, 'follow')],
  ['Follow people as you', contracts.LensGlobalGraph, selector(graphAbi, 'unfollow')],
  [
    'Block people as you',
    contracts.AccountBlockingRule,
    selector(accountBlockingRuleAbi, 'blockUser'),
  ],
  [
    'Block people as you',
    contracts.AccountBlockingRule,
    selector(accountBlockingRuleAbi, 'unblockUser'),
  ],
  ['Post images as you', MEDIA_STORE_ADDRESS, selector(mediaStoreAbi as Abi, 'put')],
  [
    'Delete any of your posts, including ones made in other apps',
    contracts.LensGlobalFeed,
    selector(feedAbi, 'deletePost'),
    true,
  ],
] as const;

const clientSecret = randomBytes(24).toString('hex');
const clubsFile = resolve(STATE_DIR, 'clubs.json');
writeFileSync(
  clubsFile,
  `${JSON.stringify(
    [
      {
        clientId: 'parallax-local',
        name: 'Parallax (local)',
        clientSecret,
        redirectUris: ['http://localhost:3000/api/auth/passport/callback'],
        grantee: forwarder,
        grantDays: 90,
        permissions: permissions.map(([label, target, selector, optional]) => ({
          label,
          target,
          selector,
          ...(optional ? { optional } : {}),
        })),
      },
    ],
    null,
    2
  )}\n`
);

writeFileSync(
  resolve(STATE_DIR, 'passport.env'),
  `PASSPORT_ISSUER=http://localhost:4000
PASSPORT_PORT=4000
PASSPORT_DATA_DIR=${resolve(STATE_DIR, 'data')}
PASSPORT_CHAIN_ID=31337
PASSPORT_RPC_URL=http://127.0.0.1:8545
PASSPORT_GRANT_REGISTRY=${registry}
PASSPORT_ACCOUNT_FACTORY=${contracts.AccountFactory}
PASSPORT_LENS_FACTORY=${contracts.LensFactory}
PASSPORT_NAMESPACE=${contracts.LensGlobalNamespace}
PASSPORT_SCOPE_TARGETS=${[...new Set(permissions.map(([, target]) => target))].join(',')}
PASSPORT_RELAYER_KEY=0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97
PASSPORT_KEYSTORE_SECRET=${randomBytes(24).toString('hex')}
PASSPORT_CLUBS_FILE=${clubsFile}
`
);

writeFileSync(
  resolve(STATE_DIR, 'admin.txt'),
  `Admin → Community Passport (http://localhost:3000/admin/passport):
  Passport URL            http://localhost:4000
  Client ID               parallax-local
  Grant registry address  ${registry}
  Forwarder address       ${forwarder}
  Client secret           ${clientSecret}
`
);
