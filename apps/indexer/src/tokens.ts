// The tokens the app links in posts (RichText in apps/web/src/components/account.tsx), so that a notified mention or
// an indexed hashtag is one the reader sees as a link: URLs come first, so an @ or # inside a URL is neither. Lens
// apps write mentions with the namespace, @lens/name, which is the global namespace's name. Keep both in sync.
const TOKEN =
  /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|(@(?:lens\/)?[a-z0-9][a-z0-9_-]{2,})|(#[\p{L}\d_]+)/gu;

/** Bounds the username lookups, and the notifications, a single post can cause. */
export const MAX_MENTIONS = 20;

/** Bounds the hashtag rows a single post can add. */
export const MAX_HASHTAGS = 10;

/** Longer hashtags aren't indexed: an index entry has to fit in a Postgres page. */
export const MAX_HASHTAG_LENGTH = 100;

/** The distinct values of one kind of token, in order of appearance, at most `max`. */
function distinctTokens(
  content: string | null,
  group: 2 | 3,
  max: number,
  normalize: (token: string) => string | null
) {
  const values = new Set<string>();
  for (const match of content?.matchAll(TOKEN) ?? []) {
    const value = match[group] ? normalize(match[group]) : null;
    if (value !== null) {
      values.add(value);
      if (values.size === max) {
        break;
      }
    }
  }
  return [...values];
}

/** The distinct usernames a post mentions, at most MAX_MENTIONS. */
export function mentionedUsernames(content: string | null): string[] {
  return distinctTokens(content, 2, MAX_MENTIONS, (mention) => mention.replace(/^@(lens\/)?/, ''));
}

/** The distinct hashtags of a post, lowercase and without '#', at most MAX_HASHTAGS. */
export function hashtagsOf(content: string | null): string[] {
  return distinctTokens(content, 3, MAX_HASHTAGS, (hashtag) => {
    const tag = hashtag.slice(1).toLowerCase();
    return tag.length <= MAX_HASHTAG_LENGTH ? tag : null;
  });
}
