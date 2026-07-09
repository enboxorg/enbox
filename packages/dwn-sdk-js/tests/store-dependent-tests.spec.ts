import { describe } from 'bun:test';

import { TestSuite } from './test-suite.js';

// The `it()` cases for this suite live inside `TestSuite.runInjectableDependentTests()`,
// a shared parameterized helper. Sonar's S2187 ("add tests to this file or delete it")
// can't see through that indirection and false-positives here, so it is suppressed for
// this file in `sonar-project.properties`. The `.spec.ts` name must stay so `bun test`
// discovers it.
describe('Store dependent tests', () => {
  TestSuite.runInjectableDependentTests();
});