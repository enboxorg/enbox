import type { LabCheck, LabProofReport } from './proof-result.js';

import { access } from 'node:fs/promises';
import { chromium } from 'playwright';
import { constants } from 'node:fs';
import { createProofReport } from './proof-result.js';

const EXPECTED_BUN_VERSION = '1.3.14';
const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64']);
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);

export type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type LabDoctorDependencies = {
  architecture?: string;
  browserExecutablePath?: string;
  now?: () => Date;
  platform?: string;
  runCommand?: (command: string[]) => Promise<CommandResult>;
};

async function runCommand(command: string[]): Promise<CommandResult> {
  const process = Bun.spawn(command, {
    stderr : 'pipe',
    stdout : 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);
  return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
}

function commandCheck(id: string, name: string, result: CommandResult): LabCheck {
  if (result.exitCode !== 0) {
    return {
      details: {
        exitCode : result.exitCode,
        stderr   : result.stderr || 'command failed without stderr',
      },
      id,
      status  : 'fail',
      summary : `${name} is unavailable`,
    };
  }

  return {
    details : { version: result.stdout },
    id,
    status  : 'pass',
    summary : `${name} is available`,
  };
}

async function browserCheck(browserExecutablePath: string): Promise<LabCheck> {
  try {
    await access(browserExecutablePath, constants.X_OK);
    return {
      details : { executablePath: browserExecutablePath },
      id      : 'chromium',
      status  : 'pass',
      summary : 'Managed Chromium executable is installed',
    };
  } catch {
    return {
      details : { executablePath: browserExecutablePath },
      id      : 'chromium',
      status  : 'fail',
      summary : 'Managed Chromium executable is not installed or executable',
    };
  }
}

/** Inspects the local prerequisites used by Enbox Lab P0 proofs. */
export async function runDoctor(dependencies: LabDoctorDependencies = {}): Promise<LabProofReport> {
  const now = dependencies.now ?? ((): Date => new Date());
  const startedAt = now();
  const runner = dependencies.runCommand ?? runCommand;
  const architecture = dependencies.architecture ?? process.arch;
  const platform = dependencies.platform ?? process.platform;
  const browserExecutablePath = dependencies.browserExecutablePath ?? chromium.executablePath();

  const [bunVersion, dockerVersion, composeVersion, chromiumCheck] = await Promise.all([
    runner(['bun', '--version']),
    runner(['docker', 'version', '--format', '{{.Client.Version}}/{{.Server.Version}}']),
    runner(['docker', 'compose', 'version', '--short']),
    browserCheck(browserExecutablePath),
  ]);

  const bunCheck = commandCheck('bun', 'Bun', bunVersion);
  if (bunCheck.status === 'pass' && bunVersion.stdout !== EXPECTED_BUN_VERSION) {
    bunCheck.status = 'fail';
    bunCheck.summary = `Bun ${bunVersion.stdout} does not match the pinned ${EXPECTED_BUN_VERSION}`;
  }

  const platformSupported = SUPPORTED_PLATFORMS.has(platform) && SUPPORTED_ARCHITECTURES.has(architecture);
  const checks: LabCheck[] = [
    bunCheck,
    commandCheck('docker-engine', 'Docker Engine', dockerVersion),
    commandCheck('docker-compose', 'Docker Compose', composeVersion),
    chromiumCheck,
    {
      details : { architecture, platform },
      id      : 'platform',
      status  : platformSupported ? 'pass' : 'unsupported',
      summary : platformSupported
        ? `${platform}/${architecture} is a candidate supported platform`
        : `${platform}/${architecture} is outside the P0 support matrix`,
    },
  ];

  return createProofReport({ checks, finishedAt: now(), proof: 'doctor', startedAt });
}
