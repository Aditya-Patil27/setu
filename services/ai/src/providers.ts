import { createHash } from 'node:crypto';

/**
 * The model seams.
 *
 * Both are interfaces for the same reason the event publisher and the step
 * invoker are: the transport is not the interesting part, and a suite that
 * reaches a real model tests the model's mood rather than this service. The
 * deterministic implementations below are the default, so the platform runs
 * with no API key and CI needs no network.
 *
 * What matters for the platform's claim is not which model answers. It is that
 * the text handed to whichever model does was already masked by Postgres.
 */

export const EMBEDDING_DIMENSIONS = 384;

export interface Embedder {
  /** Stable identifier stored alongside each vector; changing it invalidates nothing implicitly. */
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface Completer {
  readonly model: string;
  complete(prompt: string): Promise<string>;
}

/**
 * A deterministic embedder.
 *
 * Hashes the text into a fixed-dimension unit vector. It carries no semantics —
 * two paraphrases are as distant as two unrelated sentences — so it proves
 * nothing about retrieval quality. What it does prove, exactly, is the property
 * this service exists to demonstrate: identical masked text yields an identical
 * vector, and text masked differently yields a different one.
 */
export function createHashEmbedder(model = 'setu-hash-384'): Embedder {
  return {
    model,
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);

        // Expand the digest to fill the dimensions, rather than truncating to 32.
        for (let block = 0; block * 32 < EMBEDDING_DIMENSIONS; block += 1) {
          const digest = createHash('sha256').update(`${block}:${text}`).digest();
          for (let i = 0; i < digest.length; i += 1) {
            const slot = block * 32 + i;
            if (slot >= EMBEDDING_DIMENSIONS) break;
            // Centre on zero so vectors are not all crowded into one orthant.
            vector[slot] = (digest[i] - 127.5) / 127.5;
          }
        }

        const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
        return vector.map((v) => v / norm);
      });
    },
  };
}

/**
 * A completer that answers from the context it was given and nothing else.
 *
 * It echoes the retrieved rows back in a fixed shape. That is deliberate: an
 * answer that can only contain what reached the prompt makes the demonstration
 * checkable — if a masked value is absent from the context it cannot appear in
 * the answer, and the test can assert exactly that.
 */
export function createEchoCompleter(model = 'setu-echo'): Completer {
  return {
    model,
    async complete(prompt) {
      return prompt;
    },
  };
}

/**
 * An OpenAI-compatible embedder, for when a real model is wanted.
 *
 * Deliberately not the default. It is reached only when SETU_EMBEDDING_URL is
 * set, so the absence of configuration is a working system rather than a broken
 * one — and a demo cannot fail because a network was unavailable.
 */
export function createHttpEmbedder(
  url: string,
  apiKey: string,
  model: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Embedder {
  return {
    model,
    async embed(texts) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: texts }),
      });

      if (!response.ok) {
        throw new Error(`Embedding provider returned ${response.status}`);
      }

      const body = (await response.json()) as { data: Array<{ embedding: number[] }> };
      const vectors = body.data.map((d) => d.embedding);

      for (const vector of vectors) {
        if (vector.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Embedding provider returned ${vector.length} dimensions, ` +
              `but record_embeddings is VECTOR(${EMBEDDING_DIMENSIONS})`,
          );
        }
      }

      return vectors;
    },
  };
}

export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder {
  const url = env.SETU_EMBEDDING_URL?.trim();
  if (!url) return createHashEmbedder();

  return createHttpEmbedder(
    url,
    env.SETU_EMBEDDING_KEY ?? '',
    env.SETU_EMBEDDING_MODEL ?? 'text-embedding-3-small',
  );
}
