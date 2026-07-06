import type { Readable, Writable } from 'node:stream';

import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';

import QRCode from 'qrcode';

export type BrowserOpenCommand = {
  args: string[];
  command: string;
};

/**
 * Prompt for one line of terminal input.
 */
export async function promptLine({
  input = process.stdin,
  output = process.stdout,
  question,
}: {
  input?: Readable;
  output?: Writable;
  question: string;
}): Promise<string> {
  const readline = createInterface({ input, output });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}

/**
 * Render a URL as a terminal QR code.
 */
export async function renderTerminalQr(uri: string): Promise<string> {
  return new Promise((resolve, reject) => {
    QRCode.toString(uri, { small: true, type: 'terminal' }, (error, qr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(qr);
    });
  });
}

/**
 * Open a URL with the host platform's default browser.
 */
export async function openBrowser(uri: string): Promise<void> {
  const { args, command } = getBrowserOpenCommand(uri);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached : true,
      stdio    : 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Returns the platform command used to open URLs in the default browser.
 */
export function getBrowserOpenCommand(uri: string, platform: NodeJS.Platform = process.platform): BrowserOpenCommand {
  if (platform === 'darwin') {
    return {
      args    : [uri],
      command : 'open',
    };
  }

  if (platform === 'win32') {
    return {
      args    : ['url.dll,FileProtocolHandler', uri],
      command : 'rundll32',
    };
  }

  return {
    args    : [uri],
    command : 'xdg-open',
  };
}
