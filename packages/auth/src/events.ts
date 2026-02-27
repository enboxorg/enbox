/**
 * Typed event emitter for auth state changes.
 * @module
 */

import type { AuthEvent, AuthEventHandler, AuthEventMap } from './types.js';

/**
 * A minimal, type-safe event emitter for auth lifecycle events.
 *
 * Usage:
 * ```ts
 * const emitter = new AuthEventEmitter();
 * const unsub = emitter.on('state-change', ({ previous, current }) => {
 *   console.log(`State: ${previous} → ${current}`);
 * });
 * emitter.emit('state-change', { previous: 'locked', current: 'unlocked' });
 * unsub(); // stop listening
 * ```
 */
export class AuthEventEmitter {
  private _listeners = new Map<AuthEvent, Set<AuthEventHandler<AuthEvent>>>();

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on<E extends AuthEvent>(event: E, handler: AuthEventHandler<E>): () => void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(handler as AuthEventHandler<AuthEvent>);

    return () => {
      set!.delete(handler as AuthEventHandler<AuthEvent>);
      if (set!.size === 0) {
        this._listeners.delete(event);
      }
    };
  }

  /**
   * Emit an event to all registered listeners.
   * @internal
   */
  emit<E extends AuthEvent>(event: E, payload: AuthEventMap[E]): void {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[AuthEventEmitter] Error in '${event}' handler:`, err);
      }
    }
  }

  /**
   * Remove all listeners for all events.
   * @internal
   */
  removeAllListeners(): void {
    this._listeners.clear();
  }
}
