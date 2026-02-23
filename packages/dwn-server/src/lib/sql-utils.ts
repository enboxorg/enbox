/**
 * Escapes SQL LIKE wildcard characters (`%`, `_`, `\`) in user-supplied input
 * so that they are treated as literal characters rather than pattern operators.
 */
export function escapeLikeWildcards(input: string): string {
  return input.replace(/[%_\\]/g, '\\$&');
}
