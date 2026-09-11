import { randomUUID } from 'node:crypto';
import { contextToHeaders, type SignedContext } from '@setu/shared';

/**
 * How a step runs its function.
 *
 * An interface because the tests need a deterministic one, and because the
 * transport is not the interesting part. What matters is that the context the
 * step runs under is signed here and not assembled by the function: the purpose
 * a step runs as was fixed when the workflow was defined, and the step is in no
 * position to widen it.
 */
export interface StepResult {
  status: 'succeeded' | 'failed';
  output: unknown;
  error?: string;
}

export interface StepInvoker {
  invoke(functionName: string, input: unknown, context: SignedContext): Promise<StepResult>;
}

export function functionsUrlFromEnv(): string {
  return (
    process.env.FUNCTIONS_SERVICE_URL ??
    `http://localhost:${process.env.FUNCTIONS_SERVICE_PORT ?? 3004}`
  );
}

/**
 * Invoke over HTTP against the Functions service.
 *
 * The Functions service checks the purpose against what the function declared,
 * so a workflow cannot reach a function that never agreed to run for this
 * purpose — the definition-time check in this service is the early, friendlier
 * half of the same rule, not a replacement for it.
 */
export function createHttpInvoker(baseUrl: string, signingSecret: string): StepInvoker {
  return {
    async invoke(functionName, input, context) {
      const url = new URL(`/v1/functions/${encodeURIComponent(functionName)}/invoke`, baseUrl);

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...contextToHeaders(
              { ...context, requestId: context.requestId || randomUUID() },
              signingSecret,
            ),
          },
          body: JSON.stringify({ input }),
        });
      } catch (err) {
        // Unreachable upstream is a failed step, not a crashed workflow: the step
        // stays retryable and the execution survives to be advanced again.
        return { status: 'failed', output: null, error: `functions service unreachable: ${err}` };
      }

      const text = await response.text();
      if (!response.ok) {
        return {
          status: 'failed',
          output: null,
          error: `invoke failed (${response.status}): ${text}`,
        };
      }

      try {
        const body = JSON.parse(text) as {
          output: unknown;
          execution?: { status?: string; stderr?: string | null };
        };
        if (body.execution?.status !== 'succeeded') {
          return {
            status: 'failed',
            output: null,
            error: body.execution?.stderr?.trim() || 'function did not succeed',
          };
        }
        return { status: 'succeeded', output: body.output };
      } catch {
        return {
          status: 'failed',
          output: null,
          error: 'functions service returned unparseable body',
        };
      }
    },
  };
}
