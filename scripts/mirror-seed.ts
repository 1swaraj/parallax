// Imports a small, made-up slice of Lens Chain into the local mirror (scripts/mirror-chain.sh) through its importers,
// the way the migrator imports the real one (monad-developers/lens-monad-migration): Accounts and their usernames
// first, then the active Accounts' recent posts, follows and blocks, then the rest of the history, newest first,
// where later imports edit and delete posts, unfollow, unblock and move a username; last, Lens Chain's "new" activity,
// from after the mirror started, which notifies. Posts point at Lens metadata as Lens Chain's do: inline here, of
// several types and versions, and a few offchain URIs that can't be read, which show as links.
//
// The demo wallet, anvil's 10th account (0xa0Ee7A142d267C1f36714E4a8F75612F20a79720), owns two of the Accounts:
// signing in with it shows both. Made-up people don't belong on a public network: this only runs on chain 31337.
//
//   pnpm mirror:chain      # deploys the mirror, then runs this (MIRROR_SEED=0 to skip)

import {
  accountMetadata,
  getMirrorDeployment,
  migrationAccountDeployerAbi,
  monadLocal,
  textOnlyPost,
  toDataURI,
} from '../packages/protocol/src';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbiParameters,
  parseEventLogs,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAddress } from 'viem/accounts';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
// mirror-chain.sh's MIGRATION_OPERATOR: anvil's 7th account, which the node signs for.
const OPERATOR: Address = '0x976EA74026E726554dB657fA54763abd0C3a0aa9';
// Anvil's 10th account. Its key is public, as anvil's are: local data only.
const DEMO_WALLET: Address = '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720';
// Lens Chain mainnet's global Feed: posts keep the ids they have there.
const LENS_CHAIN_FEED: Address = '0xcB5E109FFC0E15565082d78E68dDDf2573703580';

const publicClient = createPublicClient({ chain: monadLocal, transport: http(RPC) });
const operator = createWalletClient({ chain: monadLocal, transport: http(RPC), account: OPERATOR });

// What the importers' applyBatch takes, as each one decodes it.
const ACCOUNTS = parseAbiParameters(
  '(address source, (address owner, address proxyAdminOwner, string metadataURI, (address account, bool execute, bool transferTokens, bool setMetadata, uint32 allowanceKey)[] managers) account)[]'
);
const USERNAMES = parseAbiParameters(
  '((string username, uint256 id, address owner, address assignedAccount, address approved, address creationSource, address assignmentSource)[] usernames, (address owner, address operator, bool approved)[] approvals)'
);
const POSTS = parseAbiParameters(
  '((uint256 id, (address author, uint256 authorPostSequentialId, uint256 postSequentialId, string contentURI, uint256 rootPostId, uint256 repostedPostId, uint256 quotedPostId, uint256 repliedPostId, uint80 creationTimestamp, uint80 lastUpdatedTimestamp, bool isDeleted) post, address creationSource, address lastUpdateSource)[] posts, (address author, uint256 count)[] authors, uint256 postCount)'
);
const FOLLOWS = parseAbiParameters(
  '((address follower, address followed, uint256 id, uint256 timestamp, bool active, address source)[] follows, (address account, uint256 lastId)[] highWater)'
);
const BLOCKS = parseAbiParameters('(address source, address target, bool blocked)[]');

const IMPORTER_ABI = [
  {
    type: 'function',
    name: 'applyBatch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sequence', type: 'uint64' },
      { name: 'revision', type: 'uint64' },
      { name: 'payload', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'nextSequence',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint64' }],
  },
] as const satisfies Abi;

/** One batch for an importer, at its next sequence. */
async function apply(importer: Address, revision: bigint, payload: Hex) {
  const sequence = await publicClient.readContract({
    address: importer,
    abi: IMPORTER_ABI,
    functionName: 'nextSequence',
  });
  const hash = await operator.writeContract({
    address: importer,
    abi: IMPORTER_ABI,
    functionName: 'applyBatch',
    args: [sequence, revision, payload],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`The import into ${importer} reverted`);
  }
  return receipt;
}

const portrait = (kind: 'women' | 'men', n: number) =>
  `https://randomuser.me/api/portraits/${kind}/${n}.jpg`;
const photo = (id: number) => `https://picsum.photos/id/${id}/1200/800`;

type Person = {
  username: string;
  name: string;
  bio: string;
  picture?: string;
  /** Profiles of Lens Chain accounts are mostly offchain: this one's can't be read locally. */
  offchain?: boolean;
  owner?: Address;
};

const PEOPLE = {
  ana: {
    username: 'ana_lima',
    name: 'Ana Lima',
    bio: 'Designer. On Lens since v1, now reading it on Monad.',
    picture: portrait('women', 26),
    owner: DEMO_WALLET,
  },
  studio: {
    username: 'ana_posters',
    name: 'Ana Lima Studio',
    bio: 'Posters and zines, run by @lens/ana_lima.',
    picture: photo(1062),
    owner: DEMO_WALLET,
  },
  kai: {
    username: 'kai_lens',
    name: 'Kai Nakamura',
    bio: 'Protocol engineer. Graphs, feeds, namespaces.',
    picture: portrait('men', 52),
  },
  ruth: {
    username: 'ruthbuilds',
    name: 'Ruth Okafor',
    bio: 'Shipping a Lens client. Ask me about indexers.',
    picture: portrait('women', 63),
  },
  marco: { username: 'marco_p', name: 'Marco Pellegrini', bio: '', offchain: true },
  zoe: {
    username: 'zoe_onchain',
    name: 'Zoë Laurent',
    bio: 'Writing about onchain social.',
    picture: portrait('women', 31),
  },
  samir: {
    username: 'samir_dev',
    name: 'Samir Haddad',
    bio: 'Solidity and coffee.',
    picture: portrait('men', 18),
  },
  nina: { username: 'nina_reads', name: 'Nina Petrova', bio: 'Book club on Lens. Quiet lately.' },
  // An account no one follows, posting spam: the mirror's Everyone timeline leaves it out.
  claims: { username: 'free_mon_claims', name: 'FREE MON', bio: 'Claim now!!!' },
} satisfies Record<string, Person>;

type Key = keyof typeof PEOPLE;

/** A Lens Chain address for each person, which the mirror maps to a new Monad address. */
const lensChainAddress = (key: Key) =>
  getAddress(keccak256(toHex(`lens-chain:${key}`)).slice(0, 42));
const ownerOf = (key: Key) =>
  (PEOPLE[key] as Person).owner ?? privateKeyToAddress(keccak256(toHex(`owner:${key}`)));

/** An app with a key that acts for Kai, as Account managers on Lens Chain do. */
const KAI_APP = getAddress(keccak256(toHex('lens-chain:kai-app')).slice(0, 42));

/** An Account's state, as the migrator imports it: from scratch, so with every manager it has. */
function accountImport(key: Key, change: Partial<Person> = {}, managers: Address[] = []) {
  const person = { ...PEOPLE[key], ...change } as Person;
  return {
    source: lensChainAddress(key),
    account: {
      owner: ownerOf(key),
      proxyAdminOwner: ownerOf(key),
      metadataURI: person.offchain
        ? `lens://${keccak256(toHex(`profile:${key}`)).slice(2)}`
        : toDataURI(
            accountMetadata({ name: person.name, bio: person.bio, picture: person.picture })
          ),
      managers: managers.map((account) => ({
        account,
        execute: true,
        transferTokens: false,
        setMetadata: true,
        allowanceKey: 0,
      })),
    },
  };
}

const DAY = 86_400n;

type PostSpec = {
  key: string;
  by: Key;
  /** Seconds before the seed started (history), or after the mirror started (new activity). */
  at: bigint;
  metadata?: unknown;
  /** An offchain contentURI instead. */
  uri?: string;
  reply?: string;
  quote?: string;
  repost?: string;
};

const text = (content: string) => textOnlyPost(content);

const HISTORY: PostSpec[] = [
  {
    key: 'v3-thread',
    by: 'kai',
    at: 20n * DAY,
    metadata: text(
      'Lens v3 notes: Accounts are smart wallets now, and usernames live in namespaces. A thread #lens'
    ),
  },
  {
    key: 'v3-thread-2',
    by: 'kai',
    at: 20n * DAY - 300n,
    reply: 'v3-thread',
    metadata: text('Accounts own their followers: the Graph is a primitive any app can read.'),
  },
  {
    key: 'v3-quote',
    by: 'ruth',
    at: 19n * DAY,
    quote: 'v3-thread',
    metadata: text('Best explainer of v3 so far.'),
  },
  {
    // Lens v2's publication metadata, flat: what many migrated posts still point at.
    key: 'reading-list',
    by: 'nina',
    at: 18n * DAY,
    metadata: {
      version: '2.0.0',
      metadata_id: 'nina-reading-list',
      content: 'Reading list for the week: The Dispossessed, Ursula K. Le Guin. #bookclub',
      mainContentFocus: 'TEXT_ONLY',
      locale: 'en',
    },
  },
  {
    key: 'lisbon',
    by: 'marco',
    at: 15n * DAY,
    metadata: {
      $schema: 'https://json-schemas.lens.dev/posts/image/3.0.0.json',
      lens: {
        id: 'lisbon',
        locale: 'en',
        mainContentFocus: 'IMAGE',
        content: 'Lisbon, on Portra 400 #filmphotography',
        image: { item: photo(1043), type: 'image/jpeg', altTag: 'Rooftops of Lisbon at dusk' },
      },
    },
  },
  {
    key: 'article',
    by: 'zoe',
    at: 12n * DAY,
    metadata: {
      $schema: 'https://json-schemas.lens.dev/posts/article/3.0.0.json',
      lens: {
        id: 'article',
        locale: 'en',
        mainContentFocus: 'ARTICLE',
        title: 'What a mirror is for',
        content:
          'A mirror lets you read a network somewhere new before you write there.\n\nYour posts stay where they are, and every app reads the same copy.',
      },
    },
  },
  {
    key: 'gas-tip',
    by: 'samir',
    at: 10n * DAY,
    metadata: text('Gas golf tip: pack your booleans. #solidity'),
  },
  {
    key: 'hello',
    by: 'ana',
    at: 8n * DAY,
    metadata: text('Hello Lens! New posters coming soon #design'),
  },
  {
    key: 'poster',
    by: 'studio',
    at: 7n * DAY,
    metadata: {
      $schema: 'https://json-schemas.lens.dev/posts/image/3.0.0.json',
      lens: {
        id: 'poster',
        locale: 'en',
        mainContentFocus: 'IMAGE',
        content: 'Poster #12, risograph, two colors.',
        image: { item: photo(1062), type: 'image/jpeg' },
      },
    },
  },
  {
    key: 'talk',
    by: 'kai',
    at: 6n * DAY,
    metadata: {
      $schema: 'https://json-schemas.lens.dev/posts/video/3.0.0.json',
      lens: {
        id: 'talk',
        locale: 'en',
        mainContentFocus: 'VIDEO',
        content: 'Talk recording: the Lens Graph in ten minutes.',
        video: {
          item: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
          type: 'video/mp4',
        },
      },
    },
  },
  {
    key: 'link',
    by: 'ruth',
    at: 5n * DAY,
    metadata: {
      $schema: 'https://json-schemas.lens.dev/posts/link/3.0.0.json',
      lens: {
        id: 'link',
        locale: 'en',
        mainContentFocus: 'LINK',
        content: 'The Lens protocol, open source.',
        sharingLink: 'https://github.com/lens-protocol',
      },
    },
  },
  {
    key: 'posters',
    by: 'zoe',
    at: 4n * DAY,
    metadata: text('@lens/ana_lima your posters are great'),
  },
  { key: 'oops', by: 'samir', at: 3n * DAY, metadata: text('oops, wrong account') },
  {
    key: 'zine',
    by: 'ana',
    at: 2n * DAY,
    metadata: text('Working on a zine about onchain social. Who wants a copy? #lens'),
  },
  {
    key: 'zine-reply',
    by: 'kai',
    at: 2n * DAY - 3_600n,
    reply: 'zine',
    metadata: text('Me! @lens/ana_lima'),
  },
  { key: 'zine-repost', by: 'ruth', at: DAY + 7_200n, repost: 'zine' },
  // Lens Chain's metadata is mostly on Grove. This key doesn't exist: the post links to it.
  {
    key: 'offchain',
    by: 'marco',
    at: DAY,
    uri: 'lens://a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
  },
  {
    key: 'spam',
    by: 'claims',
    at: DAY - 600n,
    metadata: text('Claim free MON now at free-mon.example #airdrop'),
  },
  {
    key: 'film',
    by: 'zoe',
    at: 20n * 3_600n,
    quote: 'lisbon',
    metadata: text('Film never gets old.'),
  },
];

// After the mirror started: replies, quotes, reposts and mentions that notify.
const NEW: PostSpec[] = [
  {
    key: 'count-me-in',
    by: 'kai',
    at: 10n,
    reply: 'zine',
    metadata: text('Count me in, and cc @lens/zoe_onchain'),
  },
  {
    key: 'classic',
    by: 'zoe',
    at: 11n,
    quote: 'hello',
    metadata: text("Ana's first post on Lens, still a classic."),
  },
  { key: 'poster-repost', by: 'samir', at: 12n, repost: 'poster' },
];

type Follow = [follower: Key, followed: Key, at: bigint];

const FOLLOWS_ACTIVE: Follow[] = [
  ['kai', 'ana', 9n * DAY],
  ['ruth', 'ana', 9n * DAY],
  ['zoe', 'ana', 8n * DAY],
  ['marco', 'ana', 8n * DAY],
  ['ana', 'kai', 7n * DAY],
  ['ana', 'zoe', 7n * DAY],
  ['studio', 'ana', 7n * DAY],
  ['kai', 'ruth', 6n * DAY],
  ['ruth', 'kai', 6n * DAY],
  ['zoe', 'kai', 5n * DAY],
  ['ana', 'studio', 5n * DAY],
  ['kai', 'studio', 4n * DAY],
];
const FOLLOWS_HISTORY: Follow[] = [
  ['samir', 'kai', 30n * DAY],
  ['samir', 'ruth', 29n * DAY],
  ['nina', 'kai', 28n * DAY],
  ['marco', 'zoe', 25n * DAY],
  ['zoe', 'marco', 24n * DAY],
  ['kai', 'marco', 20n * DAY],
  ['ana', 'nina', 18n * DAY],
  ['kai', 'samir', 15n * DAY],
];

async function main() {
  const chainId = await publicClient.getChainId();
  if (chainId !== 31337) {
    throw new Error(`Made-up people only go on the local chain (31337), not ${chainId}`);
  }
  const { contracts } = getMirrorDeployment(31337);
  const head = await publicClient.getBlock();
  const now = head.timestamp;
  const ago = (seconds: bigint) => now - seconds;

  // 1. Identity: Accounts, then usernames.
  const keys = Object.keys(PEOPLE) as Key[];
  const target = new Map<Key, Address>();
  for (let i = 0; i < keys.length; i += 5) {
    const batch = keys.slice(i, i + 5);
    const receipt = await apply(
      contracts.MigrationAccountDeployer,
      1n,
      encodeAbiParameters(ACCOUNTS, [batch.map((key) => accountImport(key))])
    );
    for (const log of parseEventLogs({
      abi: migrationAccountDeployerAbi,
      eventName: 'AccountMapped',
      logs: receipt.logs,
    })) {
      const key = batch.find((candidate) => lensChainAddress(candidate) === log.args.source)!;
      target.set(key, log.args.target);
    }
  }
  const monad = (key: Key) => target.get(key)!;

  type Username = { name: string; key: Key | null };
  const assign = (names: Username[], revision: bigint) =>
    apply(
      contracts.LensGlobalNamespace,
      revision,
      encodeAbiParameters(USERNAMES, [
        {
          usernames: names
            .map(({ name, key }) => ({
              username: name,
              id: BigInt(keccak256(toHex(name))),
              owner: key ? ownerOf(key) : DEMO_WALLET,
              assignedAccount: key ? monad(key) : zeroAddress,
              approved: zeroAddress,
              creationSource: zeroAddress,
              assignmentSource: zeroAddress,
            }))
            // The importer takes them in id order.
            .sort((a, b) => (a.id < b.id ? -1 : 1)),
          approvals: [],
        },
      ])
    );
  await assign(
    keys.map((key) => ({ name: PEOPLE[key].username, key })),
    1n
  );

  // Every post's Lens Chain identity: its author's nth post, its place in the feed, and its id.
  const chronological = [...HISTORY].sort((a, b) => (a.at > b.at ? -1 : 1));
  const posts = new Map<
    string,
    PostSpec & { id: bigint; n: bigint; sequence: bigint; createdAt: bigint }
  >();
  const authorCounts = new Map<Key, bigint>();
  const register = (spec: PostSpec, createdAt: bigint) => {
    const n = (authorCounts.get(spec.by) ?? 0n) + 1n;
    authorCounts.set(spec.by, n);
    const id = BigInt(
      keccak256(
        encodeAbiParameters(parseAbiParameters('string, uint256, address, address, uint256'), [
          'evm:',
          232n,
          LENS_CHAIN_FEED,
          lensChainAddress(spec.by),
          n,
        ])
      )
    );
    posts.set(spec.key, { ...spec, id, n, sequence: BigInt(posts.size + 1), createdAt });
  };
  for (const spec of chronological) {
    register(spec, ago(spec.at));
  }

  const record = (key: string, edit?: { metadata: unknown; at: bigint } | 'delete') => {
    const post = posts.get(key)!;
    const ref = (other?: string) => (other ? posts.get(other)!.id : 0n);
    const root = (other?: string): bigint =>
      other ? (posts.get(other)!.reply ? root(posts.get(other)!.reply) : ref(other)) : post.id;
    const metadata = edit && edit !== 'delete' ? edit.metadata : post.metadata;
    return {
      id: post.id,
      post: {
        author: monad(post.by),
        authorPostSequentialId: post.n,
        postSequentialId: post.sequence,
        contentURI: post.repost ? '' : (post.uri ?? toDataURI(metadata)),
        rootPostId: post.reply ? root(post.reply) : post.id,
        repostedPostId: ref(post.repost),
        quotedPostId: ref(post.quote),
        repliedPostId: ref(post.reply),
        creationTimestamp: post.createdAt,
        lastUpdatedTimestamp: edit === 'delete' ? now : edit ? ago(edit.at) : post.createdAt,
        isDeleted: edit === 'delete',
      },
      creationSource: zeroAddress,
      lastUpdateSource: zeroAddress,
    };
  };
  const feed = (records: ReturnType<typeof record>[], revision: bigint) =>
    apply(
      contracts.LensGlobalFeed,
      revision,
      encodeAbiParameters(POSTS, [
        {
          posts: records,
          authors: [...authorCounts].map(([key, count]) => ({ author: monad(key), count })),
          postCount: BigInt(posts.size),
        },
      ])
    );

  // Follow ids count each followed account's followers, in order.
  const followIds = new Map<Key, bigint>();
  const followRecord = ([follower, followed, at]: Follow) => {
    const id = (followIds.get(followed) ?? 0n) + 1n;
    followIds.set(followed, id);
    return {
      follower: monad(follower),
      followed: monad(followed),
      id,
      timestamp: at,
      active: true,
      source: zeroAddress,
    };
  };
  const graph = (
    follows: {
      follower: Address;
      followed: Address;
      id: bigint;
      timestamp: bigint;
      active: boolean;
      source: Address;
    }[],
    revision: bigint
  ) =>
    apply(
      contracts.LensGlobalGraph,
      revision,
      encodeAbiParameters(FOLLOWS, [
        {
          follows,
          highWater: [...followIds].map(([key, lastId]) => ({ account: monad(key), lastId })),
        },
      ])
    );
  const unfollow = (follower: Key, followed: Key) => ({
    follower: monad(follower),
    followed: monad(followed),
    id: 0n,
    timestamp: 0n,
    active: false,
    source: zeroAddress,
  });
  const blocks = (list: [Key, Key, boolean][], revision: bigint) =>
    apply(
      contracts.AccountBlockingRule,
      revision,
      encodeAbiParameters(BLOCKS, [
        list.map(([source, target, blocked]) => ({
          source: monad(source),
          target: monad(target),
          blocked,
        })),
      ])
    );

  // History's follow ids come before the recent ones: number them first.
  const historyFollows = FOLLOWS_HISTORY.map(([follower, followed, at]) =>
    followRecord([follower, followed, ago(at)])
  );
  const activeFollows = FOLLOWS_ACTIVE.map(([follower, followed, at]) =>
    followRecord([follower, followed, ago(at)])
  );

  // 2. The active Accounts' recent content, newest first: a repost and a reply come before their post.
  const recent = chronological.filter((spec) => spec.at <= 4n * DAY).reverse();
  await feed(
    recent.map((spec) => record(spec.key)),
    2n
  );
  await graph(activeFollows, 2n);
  await blocks(
    [
      ['ana', 'claims', true],
      ['kai', 'claims', true],
    ],
    2n
  );

  // 3. The rest of the history, newest first, and what changed since: an edit, a deletion, an unfollow, an
  // unblock, a follow again, a username moving, and two Accounts imported again, in one batch: Kai's new bio, with an
  // app managing the Account now, and Nina's.
  const older = chronological.filter((spec) => spec.at > 4n * DAY).reverse();
  for (let i = 0; i < older.length; i += 4) {
    await feed(
      older.slice(i, i + 4).map((spec) => record(spec.key)),
      3n
    );
  }
  await feed(
    [
      record('posters', {
        at: 3n * DAY,
        metadata: text('@lens/ana_lima your posters are great. Ordered two!'),
      }),
      record('oops', 'delete'),
    ],
    3n
  );
  await graph(historyFollows, 3n);
  await graph([unfollow('samir', 'ruth'), followRecord(['zoe', 'marco', ago(2n * DAY)])], 3n);
  await blocks([['kai', 'claims', false]], 3n);
  await assign(
    [
      { name: 'ana_studio', key: 'studio' },
      { name: 'ana_posters', key: null },
    ],
    3n
  );
  await apply(
    contracts.MigrationAccountDeployer,
    3n,
    encodeAbiParameters(ACCOUNTS, [
      [
        accountImport('kai', { bio: 'Protocol engineer. Graphs, feeds, namespaces, and Monad.' }, [
          KAI_APP,
        ]),
        accountImport('nina', { bio: 'Book club on Lens. Reading again.' }),
      ],
    ])
  );

  // 4. Lens Chain's new activity, from after the mirror started: it notifies.
  const started = (await publicClient.getBlock()).timestamp;
  for (const spec of NEW) {
    register(spec, started + spec.at);
  }
  await feed(
    NEW.map((spec) => record(spec.key)),
    4n
  );
  await graph([followRecord(['ruth', 'studio', started + 13n])], 4n);

  const sequences = await Promise.all(
    [
      contracts.MigrationAccountDeployer,
      contracts.LensGlobalNamespace,
      contracts.LensGlobalFeed,
      contracts.LensGlobalGraph,
      contracts.AccountBlockingRule,
    ].map((address) =>
      publicClient.readContract({ address, abi: IMPORTER_ABI, functionName: 'nextSequence' })
    )
  );
  console.log(
    `Imported ${keys.length} Accounts, ${posts.size} posts, ${historyFollows.length + activeFollows.length + 2} follows ` +
      `and 3 blocks into the mirror, in ${sequences.reduce((sum, next) => sum + next, 0n)} batches. ` +
      `The demo wallet ${DEMO_WALLET} owns @${PEOPLE.ana.username} and @ana_studio.`
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
