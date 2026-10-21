import type { Context } from 'ponder:registry';
import { notification, post, username } from 'ponder:schema';
import { isAddressEqual, type Address } from 'viem';
import { mentionedUsernames } from './tokens';

type PostRow = typeof post.$inferSelect;
type NotificationRow = typeof notification.$inferInsert;
export type NotificationType = NotificationRow['type'];
/** Where a notification happened: the event's block and log (in mirror mode, the record's time and tiebreaker). */
export type Position = { blockNumber: bigint; logIndex: number; timestamp: bigint };

/** A log notifies each recipient at most once, so its position identifies the notification for that recipient. */
export async function notify(
  context: Context,
  position: Position,
  actor: Address,
  recipients: Map<Address, NotificationType>,
  posts: (type: NotificationType) => Pick<NotificationRow, 'actorPostId' | 'postId'>
) {
  if (recipients.size === 0) {
    return;
  }
  await context.db
    .insert(notification)
    .values(
      [...recipients].map(([recipient, type]) => ({
        recipient,
        blockNumber: position.blockNumber,
        logIndex: position.logIndex,
        type,
        mentions: type === 'reply' || type === 'mention',
        actor,
        ...posts(type),
        createdAt: position.timestamp,
      }))
    )
    .onConflictDoNothing();
}

/** Never notifies the actor, and keeps the first type given to a recipient. */
export function addRecipient(
  recipients: Map<Address, NotificationType>,
  actor: Address,
  recipient: Address | undefined,
  type: NotificationType
) {
  const key = recipient?.toLowerCase() as Address | undefined;
  if (key && !isAddressEqual(key, actor) && !recipients.has(key)) {
    recipients.set(key, type);
  }
}

/**
 * Notifies the authors of the reposted, replied and quoted posts, then the accounts the content mentions: a recipient
 * gets one notification per post, a reply rather than a mention.
 */
export async function notifyPost(
  context: Context,
  position: Position,
  created: Pick<PostRow, 'id' | 'author' | 'content' | 'repostedPostId'>,
  references: { reposted?: PostRow; replied?: PostRow; quoted?: PostRow }
) {
  const recipients = new Map<Address, NotificationType>();
  addRecipient(recipients, created.author, references.reposted?.author, 'repost');
  addRecipient(recipients, created.author, references.replied?.author, 'reply');
  addRecipient(recipients, created.author, references.quoted?.author, 'quote');
  const holders = await Promise.all(
    mentionedUsernames(created.content).map((name) => context.db.find(username, { username: name }))
  );
  for (const holder of holders) {
    addRecipient(recipients, created.author, holder?.account, 'mention');
  }
  await notify(context, position, created.author, recipients, (type) => ({
    actorPostId: created.id,
    postId: type === 'repost' ? created.repostedPostId : created.id,
  }));
}
