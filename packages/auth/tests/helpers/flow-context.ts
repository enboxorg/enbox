import type { AuthSession } from '../../src/identity-session.js';
import type { FlowContext } from '../../src/connect/lifecycle.js';

type DirectFlowContext = Omit<
  FlowContext,
  'assertActive' | 'commitSession' | 'runMutation' | 'sessionSignal'
>;

/** Simulate the AuthManager lifecycle boundary for a directly exercised connect flow. */
export function createFlowContext(context: DirectFlowContext): FlowContext {
  return {
    ...context,
    sessionSignal : new AbortController().signal,
    assertActive  : (): void => {},
    runMutation   : <T>(operation: () => Promise<T>): Promise<T> => operation(),
    commitSession : (operation: () => Promise<AuthSession>): Promise<AuthSession> => operation(),
  };
}
