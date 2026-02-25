/**
 * Formatting utilities for the admin dashboard.
 */

/** Formats a byte count into a human-readable string (e.g., "1.5 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) { return '0 B'; }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Formats a number with locale separators. */
export function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Formats seconds into a human-readable duration string. */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) { parts.push(`${d}d`); }
  if (h > 0) { parts.push(`${h}h`); }
  if (m > 0) { parts.push(`${m}m`); }
  if (parts.length === 0 || s > 0) { parts.push(`${s}s`); }
  return parts.join(' ');
}

/** Formats an ISO timestamp to a short local date-time string. */
export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Truncates a DID to a shorter display form. */
export function truncateDid(did: string, maxLen = 40): string {
  if (did.length <= maxLen) { return did; }
  return did.slice(0, maxLen - 3) + '...';
}
