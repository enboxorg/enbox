type DwnStatus = {
  code: number;
  detail?: string;
};

type DwnStatusCarrier =
  | { status: DwnStatus }
  | { reply: { status: DwnStatus } };

const freshDidRetryDelaysMs = [500, 1_000, 2_000, 4_000, 8_000, 16_000];

function getStatus(result: DwnStatusCarrier): DwnStatus {
  if ('reply' in result) {
    return result.reply.status;
  }

  return result.status;
}

function isFreshDidResolutionFailure(status: DwnStatus): boolean {
  return status.code === 401
    && (status.detail ?? '').includes('GetPublicKeyNotFound');
}

function isPlainHttpBadRequest(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('failed to parse json rpc response')
    && error.message.includes('status: 400');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function retryFreshDidResolution<T extends DwnStatusCarrier>(
  operation: () => Promise<T>
): Promise<T> {
  let lastReply: T | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt <= freshDidRetryDelaysMs.length; attempt++) {
    if (attempt > 0) {
      await sleep(freshDidRetryDelaysMs[attempt - 1]);
    }

    try {
      const reply = await operation();
      if (!isFreshDidResolutionFailure(getStatus(reply))) {
        return reply;
      }

      lastReply = reply;
    } catch (error) {
      if (!isPlainHttpBadRequest(error)) {
        throw error;
      }

      lastError = error;
    }
  }

  if (lastReply) {
    return lastReply;
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error('retryFreshDidResolution exhausted without a DWN reply');
}
