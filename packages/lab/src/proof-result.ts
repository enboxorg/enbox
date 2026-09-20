export type LabCheckStatus = 'fail' | 'pass' | 'unsupported';

export type LabCheck = {
  details?: Record<string, boolean | number | string>;
  id: string;
  status: LabCheckStatus;
  summary: string;
};

export type LabProofStatus = LabCheckStatus;

export type LabProofReport = {
  checks: LabCheck[];
  finishedAt: string;
  proof: string;
  schemaVersion: 1;
  startedAt: string;
  status: LabProofStatus;
};

/** Returns the strict aggregate status for a proof's checks. */
export function aggregateCheckStatus(checks: LabCheck[]): LabProofStatus {
  if (checks.some((check): boolean => check.status === 'fail')) {
    return 'fail';
  }
  if (checks.some((check): boolean => check.status === 'unsupported')) {
    return 'unsupported';
  }
  return 'pass';
}

/** Creates a completed proof report with a deterministic aggregate verdict. */
export function createProofReport(params: {
  checks: LabCheck[];
  finishedAt?: Date;
  proof: string;
  startedAt: Date;
}): LabProofReport {
  return {
    checks        : params.checks,
    finishedAt    : (params.finishedAt ?? new Date()).toISOString(),
    proof         : params.proof,
    schemaVersion : 1,
    startedAt     : params.startedAt.toISOString(),
    status        : aggregateCheckStatus(params.checks),
  };
}
