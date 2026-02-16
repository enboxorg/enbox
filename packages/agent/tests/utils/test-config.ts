const DEFAULT_TEST_DWN_URL = 'http://localhost:3000';

const getTestDwnUrl = (): string => process.env.TEST_DWN_URL || DEFAULT_TEST_DWN_URL;

export const testDwnUrl = getTestDwnUrl();