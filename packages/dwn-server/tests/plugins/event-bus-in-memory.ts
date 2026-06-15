import { InMemoryEventBus } from '../../src/event-bus.js';

export default class EventBusInMemory extends InMemoryEventBus {
  public static spyingTheConstructor(): void {
    // Used by dynamic plugin loading tests.
  }

  public static spyingTheClose(): void {
    // Used by dynamic plugin loading tests.
  }

  public constructor() {
    super();
    EventBusInMemory.spyingTheConstructor();
  }

  public override async close(): Promise<void> {
    EventBusInMemory.spyingTheClose();
    await super.close();
  }
}
