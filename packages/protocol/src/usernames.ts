/**
 * The launch Namespace's rules for non-admins (script/NamespaceDeployer.sol): UsernameSimpleCharsetNamespaceRule
 * (a-z or 0-9 first, then also `_` and `-`), and a minimum length of 4 (MIN_USERNAME_LENGTH). The reserved-usernames
 * rule can only be checked on-chain.
 */
export const MIN_USERNAME_LENGTH = 4;

export function usernameError(username: string): string | null {
  if (username.length < MIN_USERNAME_LENGTH) {
    return `At least ${MIN_USERNAME_LENGTH} characters`;
  }
  if (!/^[a-z0-9]/.test(username)) {
    return 'Starts with a lowercase letter or a digit';
  }
  if (!/^[a-z0-9_-]+$/.test(username)) {
    return 'Only lowercase letters, digits, _ and -';
  }
  return null;
}
