// mitt v3 does not include `"type": "module"` in its package.json, so under
// TypeScript's `NodeNext` module resolution the `export default function` in
// mitt's own typings is treated as a CJS namespace rather than a callable.
// This ambient module declaration re-exports the factory as a proper ESM
// default so `import mitt from 'mitt'` type-checks correctly.
declare module 'mitt' {
  type EventType = string | symbol;
  type Handler<T = unknown> = (event: T) => void;
  type EventHandlerList<T = unknown> = Array<Handler<T>>;
  type WildCardEventHandlerList<T = Record<string, unknown>> = Array<
    (type: keyof T, event: T[keyof T]) => void
  >;
  type EventHandlerMap<Events extends Record<EventType, unknown>> = Map<
    keyof Events | '*',
    EventHandlerList<Events[keyof Events]> | WildCardEventHandlerList<Events>
  >;

  interface Emitter<Events extends Record<EventType, unknown>> {
    all: EventHandlerMap<Events>;
    on<Key extends keyof Events>(type: Key, handler: Handler<Events[Key]>): void;
    off<Key extends keyof Events>(type: Key, handler?: Handler<Events[Key]>): void;
    emit<Key extends keyof Events>(type: Key, event: Events[Key]): void;
  }

  export default function mitt<Events extends Record<EventType, unknown>>(
    all?: EventHandlerMap<Events>
  ): Emitter<Events>;
}
