import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { SetuError, ValidationError } from "@setu/shared";
import { closePools, createPools, type Pools } from "./db.js";
import routes from "./routes/index.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Record access runs as runtime; DDL generation alone uses owner. */
    pools: Pools;
    /** HMAC key the gateway signs request context with. */
    signingSecret: string;
  }
}

export interface AppOptions {
  pools?: Pools;
  signingSecret?: string;
}

/**
 * Build the data service Fastify application.
 * Separated from index.ts for testability.
 */
export async function buildApp(
  opts: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  await app.register(cors);

  const ownsPools = opts.pools === undefined;
  app.decorate("pools", opts.pools ?? createPools());
  app.decorate(
    "signingSecret",
    opts.signingSecret ?? process.env.INTERNAL_SIGNING_SECRET ?? "",
  );

  if (!app.signingSecret) {
    throw new Error(
      "INTERNAL_SIGNING_SECRET is required — refusing to trust unsigned context",
    );
  }

  if (ownsPools) {
    app.addHook("onClose", async (instance) => {
      await closePools(instance.pools);
    });
  }

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ValidationError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    if (err instanceof SetuError) {
      return reply.status(err.statusCode).send(err.toJSON());
    }

    // Never surface an unrecognised error: it may carry SQL text or connection details.
    request.log.error({ err }, "unhandled error");
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        requestId: request.id,
      },
    });
  });

  app.get("/health", async () => ({ status: "ok", service: "data" }));

  await app.register(routes, { prefix: "/v1" });

  return app;
}
