import type { AgentSession } from '@enbox/agent';
import type { FlowContext } from '../../src/connect/lifecycle.js';

type DirectFlowContext = Omit<
  FlowContext,
  'assertActive' | 'commitSession' | 'operationSignal' | 'runMutation' | 'sessionSignal'
>;

/** Simulate the AuthManager lifecycle boundary for a directly exercised connect flow. */
export function createFlowContext(context: DirectFlowContext): FlowContext {
  return {
    ...context,
    sessionSignal   : new AbortController().signal,
    operationSignal : new AbortController().signal,
    assertActive    : (): void => {},
    runMutation     : <T>(operation: () => Promise<T>): Promise<T> => operation(),
    commitSession   : (operation: () => Promise<AgentSession>): Promise<AgentSession> => operation(),
  };
}
