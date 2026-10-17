// Seeds a local chain with realistic people and conversations, for demos and screenshots: accounts with names,
// bios and pictures, posts, threads, quotes, reposts and a follow graph, through the same contracts and relayer the
// app uses, with block timestamps spread over the last few days. Then, if the app is running, likes through its API.
//
//   pnpm chain            # deploys, then seeds the chain (SEED=0 to skip)
//   pnpm seed:likes       # once the indexer and the app run: likes, through the app's API
//
// Fake people don't belong on a public network: this refuses any chain but 31337 unless SEED_ALLOW_REMOTE=1.

import {
  accountFactoryAbi,
  accountMetadata,
  createAccountWithUsernameArgs,
  createPost,
  feedAbi,
  follow,
  getDeployment,
  lensFactoryAbi,
  monadLocal,
  namespaceAbi,
  repost,
  sponsorRouterAbi,
  textOnlyPost,
  toDataURI,
  type AccountCall,
  type PostReference,
} from '../packages/protocol/src';
import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const APP = process.env.APP_URL ?? 'http://localhost:3000';
// Anvil's 4th account, the relayer DeployLaunch allowlists locally.
const RELAYER_KEY = (process.env.RELAYER_PRIVATE_KEY ??
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6') as Hex;
// Owners derive from anvil's public mnemonic, at indexes no other tool uses: local data only.
const MNEMONIC = 'test test test test test test test test test test test junk';

type Person = { username: string; name: string; bio: string; picture?: string };

const portrait = (kind: 'women' | 'men', n: number) =>
  `https://randomuser.me/api/portraits/${kind}/${n}.jpg`;

const PEOPLE: Person[] = [
  {
    username: 'maya_builds',
    name: 'Maya Chen',
    bio: 'Frontend at a DEX on Monad. I make swaps feel instant. she/her',
    picture: portrait('women', 44),
  },
  {
    username: 'devonk',
    name: 'Devon Kim',
    bio: 'Solidity, gas golf and too much coffee. Building lending on Monad.',
    picture: portrait('men', 32),
  },
  {
    username: 'priyarao',
    name: 'Priya Rao',
    bio: 'Protocol research. Parallel execution and consensus nerd. Writing notes on MonadBFT.',
    picture: portrait('women', 68),
  },
  {
    username: 'lucasmendes',
    name: 'Lucas Mendes',
    bio: 'Product designer. Making onchain apps feel like apps.',
    picture: portrait('men', 46),
  },
  {
    username: 'ana_onchain',
    name: 'Ana Souza',
    bio: 'Community in São Paulo. Meetups, workshops, gmonad.',
    picture: portrait('women', 12),
  },
  {
    username: 'tombecker',
    name: 'Tom Becker',
    bio: 'Perps, charts and too many tabs. Not financial advice.',
    picture: portrait('men', 75),
  },
  {
    username: 'sofiawrites',
    name: 'Sofia Rossi',
    bio: 'I write a newsletter about crypto UX. On Lens since v1.',
    picture: portrait('women', 90),
  },
  {
    username: 'kenji_dev',
    name: 'Kenji Watanabe',
    bio: 'Rust and EVM tooling. Indexers, RPCs, the plumbing.',
    picture: portrait('men', 11),
  },
  {
    username: 'nadia_art',
    name: 'Nadia Haddad',
    bio: 'Generative artist. Every piece is seeded by a block hash.',
    picture: portrait('women', 29),
  },
  {
    username: 'omarbuilds',
    name: 'Omar Farouk',
    bio: 'Founder. Payments on Monad. Ex-fintech, still allergic to settlement delays.',
    picture: portrait('men', 52),
  },
  {
    username: 'julesmartin',
    name: 'Jules Martin',
    bio: 'Brought my Lens account to Monad on day one.',
    picture: portrait('women', 57),
  },
  {
    username: 'ravi_eth',
    name: 'Ravi Patel',
    bio: 'Smart contract auditor. Reading your code so you can sleep.',
    picture: portrait('men', 22),
  },
  {
    username: 'emmalarsen',
    name: 'Emma Larsen',
    bio: 'PM for wallets. Fewer popups, fewer seed phrases, more people onchain.',
    picture: portrait('women', 33),
  },
  {
    username: 'chaindaily',
    name: 'Chain Daily',
    bio: 'Short notes on what shipped this week. Community-run, not official.',
  },
];

type Step =
  | { at: number; post: string; by: string; text: string }
  | { at: number; reply: string; to: string; by: string; text: string }
  | { at: number; quote: string; of: string; by: string; text: string }
  | { at: number; repost: string; by: string }
  | { at: number; follows: [string, string[]][] };

// Hours ago, oldest first.
const SCRIPT: Step[] = [
  {
    at: 98,
    follows: [
      ['maya_builds', ['devonk', 'lucasmendes', 'priyarao', 'kenji_dev', 'emmalarsen']],
      ['devonk', ['maya_builds', 'priyarao', 'ravi_eth', 'kenji_dev', 'tombecker']],
      ['priyarao', ['devonk', 'kenji_dev', 'ravi_eth']],
      ['lucasmendes', ['maya_builds', 'emmalarsen', 'sofiawrites', 'nadia_art']],
      ['ana_onchain', ['omarbuilds', 'maya_builds', 'julesmartin', 'chaindaily', 'priyarao']],
      ['tombecker', ['devonk', 'omarbuilds', 'chaindaily']],
      ['sofiawrites', ['lucasmendes', 'emmalarsen', 'julesmartin', 'maya_builds']],
      ['kenji_dev', ['priyarao', 'devonk', 'ravi_eth']],
      ['nadia_art', ['lucasmendes', 'sofiawrites', 'ana_onchain']],
      ['omarbuilds', ['ana_onchain', 'emmalarsen', 'devonk', 'tombecker']],
      ['julesmartin', ['sofiawrites', 'ana_onchain', 'maya_builds', 'nadia_art']],
      ['ravi_eth', ['devonk', 'priyarao', 'kenji_dev']],
      ['emmalarsen', ['lucasmendes', 'sofiawrites', 'omarbuilds', 'maya_builds']],
      ['chaindaily', ['priyarao', 'omarbuilds', 'maya_builds']],
    ],
  },
  {
    at: 96,
    post: 'priya-bft',
    by: 'priyarao',
    text: 'Rereading the MonadBFT notes. The trick is pipelining: agree on the order of transactions first, execute them right after, and never let one wait on the other. #monad',
  },
  {
    at: 94,
    reply: 'devon-bft',
    to: 'priya-bft',
    by: 'devonk',
    text: "This is why our oracle updates and liquidations can land in the same block without drama. Would love a diagram version of this if you're up for it.",
  },
  {
    at: 93,
    reply: 'priya-bft-2',
    to: 'devon-bft',
    by: 'priyarao',
    text: 'On it. Drawing it this weekend.',
  },
  {
    at: 90,
    post: 'ana-meetup',
    by: 'ana_onchain',
    text: 'gmonad from São Paulo ☀️ Meetup next Thursday: two talks, one workshop on deploying your first contract, and a lot of pão de queijo. Who is coming? #gmonad',
  },
  {
    at: 88,
    reply: 'omar-meetup',
    to: 'ana-meetup',
    by: 'omarbuilds',
    text: "I'll be there. Happy to demo the payments flow live if there's a slot.",
  },
  {
    at: 87,
    reply: 'ana-meetup-2',
    to: 'omar-meetup',
    by: 'ana_onchain',
    text: '@omarbuilds you just got the closing slot 🙌',
  },
  { at: 85, repost: 'priya-bft', by: 'kenji_dev' },
  {
    at: 80,
    post: 'lucas-ux',
    by: 'lucasmendes',
    text: "Hot take: onchain apps shouldn't look onchain. No hex in the main UI, no wallet popup to follow someone. If the chain is fast and the fees are sponsored, the interface can finally get out of the way. #design",
  },
  {
    at: 79,
    reply: 'emma-ux',
    to: 'lucas-ux',
    by: 'emmalarsen',
    text: 'Agree. Every popup is a place people drop off. We measured it: one extra signature step cost us about a third of new users.',
  },
  {
    at: 78,
    reply: 'maya-ux',
    to: 'lucas-ux',
    by: 'maya_builds',
    text: "100%. Users shouldn't need to know what a nonce is.",
  },
  {
    at: 74,
    post: 'devon-gas',
    by: 'devonk',
    text: 'Gas golfed our liquidation path from 312k to 198k. On Monad you pay for the gas limit you set, not the gas you use, so tight limits matter. What we changed ↓ #buildinpublic',
  },
  {
    at: 73.9,
    reply: 'devon-gas-2',
    to: 'devon-gas',
    by: 'devonk',
    text: '1/ Packed three storage slots into one. Cold reads are the expensive part, so fewer slots touched means real savings.',
  },
  {
    at: 73.8,
    reply: 'devon-gas-3',
    to: 'devon-gas-2',
    by: 'devonk',
    text: '2/ Estimate gas per call and add a small buffer instead of a flat 1M limit. The buffer covers price moves between simulation and inclusion.',
  },
  {
    at: 72,
    reply: 'ravi-gas',
    to: 'devon-gas',
    by: 'ravi_eth',
    text: 'Nice. Make sure the packed slot still has room for the next upgrade, I have seen that one bite people.',
  },
  {
    at: 68,
    post: 'sofia-lens',
    by: 'sofiawrites',
    text: 'Moved my Lens account over and my followers came with me. That was always the pitch of Lens, and it finally clicked for me this week. #lens',
  },
  { at: 66, repost: 'sofia-lens', by: 'julesmartin' },
  {
    at: 64,
    post: 'kenji-rpc',
    by: 'kenji_dev',
    text: 'If you index Monad, budget for getLogs limits on public RPCs: about 100 blocks per call. A paid RPC and an indexer that pages properly saved us a weekend.',
  },
  {
    at: 63,
    reply: 'priya-rpc',
    to: 'kenji-rpc',
    by: 'priyarao',
    text: 'Bookmarking this for the next person who asks me why their backfill takes all day.',
  },
  {
    at: 58,
    post: 'nadia-mint',
    by: 'nadia_art',
    text: 'New series next week: 64 generative pieces, each seeded by the hash of the block it was minted in. Same code, different chain state, different art. #art #monad',
  },
  {
    at: 56,
    quote: 'lucas-nadia',
    of: 'nadia-mint',
    by: 'lucasmendes',
    text: 'The previews are beautiful. Block-seeded art is such a good use of a fast chain.',
  },
  {
    at: 52,
    post: 'tom-blocks',
    by: 'tombecker',
    text: 'Built a tiny dashboard that watches block times. It is almost boring to look at. Boring is the goal.',
  },
  {
    at: 48,
    post: 'omar-payments',
    by: 'omarbuilds',
    text: 'We settled 10,000 test payments in an afternoon on testnet. Merchants care about two things: it arrived, and it cost nothing. Both checked. Mainnet next. #monad',
  },
  {
    at: 47,
    reply: 'emma-payments',
    to: 'omar-payments',
    by: 'emmalarsen',
    text: 'How are you handling refunds? That is where most payment UX falls apart.',
  },
  {
    at: 46,
    reply: 'omar-payments-2',
    to: 'emma-payments',
    by: 'omarbuilds',
    text: 'Refunds are just a payment back with a reference to the original. Took us a while to accept that simple is fine.',
  },
  { at: 45, repost: 'omar-payments', by: 'tombecker' },
  {
    at: 40,
    post: 'chain-week',
    by: 'chaindaily',
    text: 'This week: Lens Protocol V3 contracts deployed on Monad testnet, a social app (hi 👋) live on top, and two new indexers. Send us what you shipped. #monad #lens',
  },
  {
    at: 36,
    post: 'jules-first',
    by: 'julesmartin',
    text: 'First post on Parallax. It feels like early Twitter, except nobody can take my followers away.',
  },
  {
    at: 35,
    quote: 'sofia-jules',
    of: 'jules-first',
    by: 'sofiawrites',
    text: 'Welcome! It took me two minutes to sign up and I never needed MON.',
  },
  {
    at: 34,
    reply: 'ana-jules',
    to: 'jules-first',
    by: 'ana_onchain',
    text: 'Welcome Jules 🎉',
  },
  {
    at: 28,
    post: 'emma-wallets',
    by: 'emmalarsen',
    text: 'Wallet onboarding checklist I keep coming back to: one signature to sign in, zero to post, and a clear way to take full control later. Most apps get the first one right.',
  },
  {
    at: 27,
    reply: 'lucas-wallets',
    to: 'emma-wallets',
    by: 'lucasmendes',
    text: 'The third one is underrated. Sponsored by default, self-custody when you want it.',
  },
  {
    at: 22,
    post: 'ravi-audit',
    by: 'ravi_eth',
    text: 'Audit tip: if a function takes a value and also checks msg.value, make sure it charges the one that actually moves. You would be surprised how often they differ.',
  },
  { at: 21, repost: 'ravi-audit', by: 'devonk' },
  {
    at: 18,
    post: 'maya-swap',
    by: 'maya_builds',
    text: 'Shipped the new swap screen: every interaction under 100ms, no spinners on confirmation. Fast blocks make optimistic UI feel boring, in a good way. #buildinpublic',
  },
  {
    at: 17,
    reply: 'tom-swap',
    to: 'maya-swap',
    by: 'tombecker',
    text: 'Tried it. Did a swap before my coffee finished brewing.',
  },
  {
    at: 16,
    quote: 'lucas-swap',
    of: 'maya-swap',
    by: 'lucasmendes',
    text: 'The motion on this is so good. @maya_builds send the Figma.',
  },
  {
    at: 12,
    post: 'priya-diagram',
    by: 'priyarao',
    text: 'As promised @devonk: the pipelining diagram is up. Consensus on block N, execution of N-1, and nobody waits.',
  },
  {
    at: 11,
    reply: 'devon-diagram',
    to: 'priya-diagram',
    by: 'devonk',
    text: 'This is great, sharing it with the team.',
  },
  {
    at: 8,
    post: 'nadia-live',
    by: 'nadia_art',
    text: 'Mint is live. Thank you to everyone who helped test, especially @lucasmendes for the feedback on the previews.',
  },
  { at: 7.5, repost: 'nadia-live', by: 'lucasmendes' },
  {
    at: 6,
    post: 'kenji-oss',
    by: 'kenji_dev',
    text: 'Open-sourced the small indexer we use for Lens on Monad. Ponder, a few tables, a REST API. PRs welcome.',
  },
  {
    at: 4,
    post: 'ana-recap',
    by: 'ana_onchain',
    text: 'Meetup recap: 80 people, 12 first deployments, zero fees paid by anyone. Next one in Rio. #gmonad',
  },
  {
    at: 3.5,
    reply: 'omar-recap',
    to: 'ana-recap',
    by: 'omarbuilds',
    text: 'Best crowd yet. Count me in for Rio.',
  },
  {
    at: 2,
    post: 'sofia-ux',
    by: 'sofiawrites',
    text: "This week's newsletter: what crypto apps can learn from the first five minutes of using Parallax. Spoiler: fewer steps than most web2 sign-ups.",
  },
  {
    at: 0.6,
    post: 'tom-gm',
    by: 'tombecker',
    text: 'gm. Markets are quiet, blocks are fast, coffee is hot.',
  },
];

// Likes, through the app's API: who likes which post.
const LIKES: [string, string[]][] = [
  ['priyarao', ['devon-gas', 'kenji-rpc', 'ravi-audit', 'maya-swap']],
  ['devonk', ['priya-bft', 'priya-diagram', 'kenji-rpc', 'ravi-audit', 'maya-swap', 'tom-blocks']],
  ['maya_builds', ['lucas-ux', 'emma-ux', 'lucas-swap', 'omar-payments', 'sofia-lens']],
  ['lucasmendes', ['maya-swap', 'nadia-mint', 'emma-wallets', 'jules-first', 'nadia-live']],
  ['ana_onchain', ['omar-payments', 'jules-first', 'sofia-jules', 'chain-week']],
  ['tombecker', ['omar-payments', 'maya-swap', 'devon-gas']],
  ['sofiawrites', ['lucas-ux', 'emma-wallets', 'jules-first', 'nadia-live', 'ana-recap']],
  ['kenji_dev', ['priya-bft', 'priya-rpc', 'devon-gas', 'priya-diagram']],
  ['nadia_art', ['lucas-nadia', 'lucas-ux', 'sofia-lens']],
  ['omarbuilds', ['ana-meetup', 'ana-recap', 'emma-wallets', 'tom-blocks']],
  ['julesmartin', ['sofia-lens', 'sofia-jules', 'ana-jules', 'nadia-live']],
  ['ravi_eth', ['devon-gas', 'devon-gas-3', 'kenji-oss']],
  ['emmalarsen', ['lucas-ux', 'lucas-wallets', 'omar-payments-2', 'sofia-ux']],
  ['chaindaily', ['kenji-oss', 'nadia-live', 'ana-recap', 'omar-payments']],
];

const { contracts } = getDeployment(monadLocal.id);
const publicClient = createPublicClient({
  chain: monadLocal,
  transport: http(RPC),
  pollingInterval: 100,
});
const relayer = createWalletClient({
  chain: monadLocal,
  transport: http(RPC),
  account: privateKeyToAccount(RELAYER_KEY),
});

async function at(hoursAgo: number) {
  const target = BigInt(Math.floor(Date.now() / 1000 - hoursAgo * 3600));
  const latest = await publicClient.getBlock();
  if (target > latest.timestamp) {
    await publicClient.request({
      method: 'anvil_setNextBlockTimestamp' as never,
      params: [`0x${target.toString(16)}`] as never,
    });
  }
}

async function send(request: Parameters<typeof relayer.writeContract>[0]) {
  const hash = await relayer.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`Transaction ${hash} reverted`);
  }
  return receipt;
}

// What a run created, so `--likes` can find the posts later.
const STATE_FILE = path.resolve(import.meta.dirname, '../.anvil/seed.json');

const owners = new Map<string, ReturnType<typeof mnemonicToAccount>>();
const accounts = new Map<string, Address>();
const posts = new Map<string, bigint>();

async function signUp(person: Person, index: number) {
  const owner = mnemonicToAccount(MNEMONIC, { addressIndex: 200 + index });
  owners.set(person.username, owner);
  const taken = await publicClient.readContract({
    address: contracts.LensGlobalNamespace,
    abi: namespaceAbi,
    functionName: 'exists',
    args: [person.username],
  });
  const existing = taken
    ? await publicClient.readContract({
        address: contracts.LensGlobalNamespace,
        abi: namespaceAbi,
        functionName: 'accountOf',
        args: [person.username],
      })
    : zeroAddress;
  if (existing !== zeroAddress) {
    accounts.set(person.username, existing);
    return false;
  }
  const receipt = await send({
    address: contracts.LensFactory,
    abi: lensFactoryAbi,
    functionName: 'createAccountWithUsernameFree',
    args: createAccountWithUsernameArgs({
      namespace: contracts.LensGlobalNamespace,
      owner: owner.address,
      username: person.username,
      metadataURI: toDataURI(
        accountMetadata({ name: person.name, bio: person.bio, picture: person.picture })
      ),
      sponsorRouter: contracts.SponsorRouter,
    }),
  } as never);
  const [created] = parseEventLogs({
    abi: accountFactoryAbi,
    eventName: 'Lens_Account_Created',
    logs: receipt.logs,
  });
  accounts.set(person.username, created!.args.account);
  return true;
}

async function act(username: string, call: AccountCall) {
  const account = accounts.get(username);
  if (!account) {
    throw new Error(`Unknown person ${username}`);
  }
  const receipt = await send({
    address: contracts.SponsorRouter,
    abi: sponsorRouterAbi,
    functionName: 'execute',
    args: [account, call.target, call.data],
  } as never);
  const [event] = parseEventLogs({
    abi: feedAbi,
    eventName: 'Lens_Feed_PostCreated',
    logs: receipt.logs,
  });
  return event?.args.postId;
}

function postId(key: string) {
  const id = posts.get(key);
  if (id === undefined) {
    throw new Error(`Unknown post ${key}`);
  }
  return id;
}

async function writePost(key: string, by: string, text: string, reference?: PostReference) {
  const account = accounts.get(by)!;
  const id = await act(
    by,
    createPost(contracts.LensGlobalFeed, account, toDataURI(textOnlyPost(text)), reference)
  );
  posts.set(key, id!);
}

/** Signs in to the app as a seeded person (SIWE), and likes posts through its API. */
async function like(username: string, keys: string[]) {
  const owner = owners.get(username)!;
  let cookie = '';
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${APP}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        origin: APP,
        ...(cookie ? { cookie } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      cookie = setCookie.split(';')[0]!;
    }
    if (!response.ok) {
      throw new Error(`${path}: ${response.status} ${await response.text()}`);
    }
    return response.json();
  };
  const { nonce } = (await call('/api/auth/nonce')) as { nonce: string };
  const message = createSiweMessage({
    address: owner.address,
    chainId: monadLocal.id,
    domain: new URL(APP).host,
    uri: APP,
    nonce,
    version: '1',
  });
  await call('/api/auth/verify', {
    method: 'POST',
    body: { message, signature: await owner.signMessage({ message }) },
  });
  for (const key of keys) {
    await call('/api/likes', { method: 'POST', body: { postId: postId(key).toString() } });
  }
}

async function seedLikes() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as Record<string, string>;
  for (const [key, id] of Object.entries(state)) {
    posts.set(key, BigInt(id));
  }
  PEOPLE.forEach((person, index) =>
    owners.set(person.username, mnemonicToAccount(MNEMONIC, { addressIndex: 200 + index }))
  );
  const appUp = await fetch(`${APP}/api/auth/session`).then(
    (response) => response.ok,
    () => false
  );
  if (!appUp) {
    throw new Error(`The app isn't running at ${APP}`);
  }
  let likes = 0;
  for (const [username, keys] of LIKES) {
    await like(username, keys).then(
      () => (likes += keys.length),
      (error: Error) => console.warn(`Likes by ${username} failed: ${error.message}`)
    );
  }
  console.log(`${likes} likes added through ${APP}`);
}

async function main() {
  if (process.argv.includes('--likes')) {
    return seedLikes();
  }
  const chainId = await publicClient.getChainId();
  if (chainId !== monadLocal.id && process.env.SEED_ALLOW_REMOTE !== '1') {
    throw new Error(`Chain ${chainId} isn't local. Fake people don't belong on a public network.`);
  }
  const first = SCRIPT[0]!.at;
  const latest = await publicClient.getBlock();
  const backdated = Number(latest.timestamp) < Date.now() / 1000 - first * 3600;
  if (!backdated) {
    console.warn(
      'The chain clock is too recent to backdate posts: they will all look new. Restart it with `pnpm chain`.'
    );
  }

  await at(first + 2);
  let created = 0;
  for (const [index, person] of PEOPLE.entries()) {
    created += (await signUp(person, index)) ? 1 : 0;
  }
  console.log(`${created} accounts created, ${PEOPLE.length - created} already there`);
  if (created === 0) {
    console.log('Already seeded.');
    return;
  }

  for (const step of SCRIPT) {
    await at(step.at);
    if ('follows' in step) {
      for (const [follower, targets] of step.follows) {
        for (const target of targets) {
          await act(
            follower,
            follow(contracts.LensGlobalGraph, accounts.get(follower)!, accounts.get(target)!)
          );
        }
      }
    } else if ('post' in step) {
      await writePost(step.post, step.by, step.text);
    } else if ('reply' in step) {
      await writePost(step.reply, step.by, step.text, { kind: 'reply', postId: postId(step.to) });
    } else if ('quote' in step) {
      await writePost(step.quote, step.by, step.text, { kind: 'quote', postId: postId(step.of) });
    } else {
      await act(
        step.by,
        repost(contracts.LensGlobalFeed, accounts.get(step.by)!, postId(step.repost))
      );
    }
  }
  console.log(`${posts.size} posts and replies written`);
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(Object.fromEntries([...posts].map(([key, id]) => [key, id.toString()])))
  );

  // Back to the wall clock, so new posts from the app read "now".
  await at(0);
  await publicClient.request({ method: 'evm_mine' as never, params: [] as never });
  console.log('Seeded. Once the indexer and the app run, add likes with `pnpm seed:likes`.');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
