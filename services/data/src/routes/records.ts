import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ValidationError, contextFromHeaders, parseInput } from "@setu/shared";
import type { SignedContext } from "@setu/shared";
import { loadCollection } from "../ddl/collections.js";
import type { RequestContext } from "../services/records.js";
import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  parseListQuery,
  updateRecord,
} from "../services/records.js";

/**
 * Every record route requires a bound purpose — it is the declared intent the
 * database evaluates consent against. `contextFromHeaders` enforces presence
 * after verifying the signature, so an unsigned or purposeless request never
 * reaches Postgres at all.
 */
function recordContext(ctx: SignedContext): RequestContext {
  if (!ctx.purpose) {
    // Unreachable: contextFromHeaders ran with requirePurpose.
    throw new ValidationError("A purpose is required for this request");
  }
  return {
    projectId: ctx.projectId,
    purpose: ctx.purpose,
    principalId: ctx.principalId,
  };
}

const CreateRecord = z
  .object({
    principalId: z.string().uuid(),
  })
  .passthrough();

const UpdateRecord = z.object({}).passthrough();

async function requireCollection(
  pool: import("pg").Pool,
  projectId: string,
  name: string,
): Promise<NonNullable<Awaited<ReturnType<typeof loadCollection>>>> {
  const found = await loadCollection(pool, projectId, name);
  if (!found) throw new NotFoundCollection(name);
  return found;
}

class NotFoundCollection extends ValidationError {
  constructor(name: string) {
    super(`Collection '${name}' not found`, { collection: name });
    this.name = "NotFoundError";
  }
}

/**
 * Tenant field names arrive flat alongside principalId. A collision is
 * impossible: the identifier validator rejects uppercase, so no declared field
 * can ever be named `principalId`.
 */
function splitFields(body: Record<string, unknown>): Record<string, unknown> {
  const { principalId: _ignored, ...fields } = body;
  void _ignored;
  if ("principal_id" in fields) {
    throw new ValidationError(
      "Use 'principalId'; 'principal_id' is platform-owned",
      {
        field: "principal_id",
      },
    );
  }
  return fields;
}

const routes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { name: string } }>(
    "/collections/:name/records",
    async (request, reply) => {
      const ctx = contextFromHeaders(request.headers, app.signingSecret, {
        requirePurpose: true,
      });
      const parsed = parseInput(CreateRecord, request.body, "record");
      const collection = await requireCollection(
        app.pools.runtime,
        ctx.projectId,
        request.params.name,
      );

      const record = await createRecord(
        app.pools.runtime,
        recordContext(ctx),
        collection,
        {
          principalId: parsed.principalId,
          fields: splitFields(parsed),
        },
      );

      return reply.status(201).send(record);
    },
  );

  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    "/collections/:name/records",
    async (request) => {
      const ctx = contextFromHeaders(request.headers, app.signingSecret, {
        requirePurpose: true,
      });
      const collection = await requireCollection(
        app.pools.runtime,
        ctx.projectId,
        request.params.name,
      );

      const query = parseListQuery(
        collection,
        ctx.purpose ?? "",
        request.query,
      );
      return listRecords(
        app.pools.runtime,
        recordContext(ctx),
        collection,
        query,
      );
    },
  );

  app.get<{ Params: { name: string; id: string } }>(
    "/collections/:name/records/:id",
    async (request) => {
      const ctx = contextFromHeaders(request.headers, app.signingSecret, {
        requirePurpose: true,
      });
      if (!/^[0-9a-f-]{36}$/i.test(request.params.id)) {
        throw new ValidationError("Invalid record id", {
          id: request.params.id,
        });
      }
      const collection = await requireCollection(
        app.pools.runtime,
        ctx.projectId,
        request.params.name,
      );

      return getRecord(
        app.pools.runtime,
        recordContext(ctx),
        collection,
        request.params.id,
      );
    },
  );

  app.patch<{ Params: { name: string; id: string } }>(
    "/collections/:name/records/:id",
    async (request) => {
      const ctx = contextFromHeaders(request.headers, app.signingSecret, {
        requirePurpose: true,
      });
      const parsed = parseInput(UpdateRecord, request.body, "record");
      const collection = await requireCollection(
        app.pools.runtime,
        ctx.projectId,
        request.params.name,
      );

      return updateRecord(
        app.pools.runtime,
        recordContext(ctx),
        collection,
        request.params.id,
        {
          fields: splitFields(parsed),
        },
      );
    },
  );

  app.delete<{ Params: { name: string; id: string } }>(
    "/collections/:name/records/:id",
    async (request, reply) => {
      const ctx = contextFromHeaders(request.headers, app.signingSecret, {
        requirePurpose: true,
      });
      const collection = await requireCollection(
        app.pools.runtime,
        ctx.projectId,
        request.params.name,
      );

      await deleteRecord(
        app.pools.runtime,
        recordContext(ctx),
        collection,
        request.params.id,
      );
      return reply.status(204).send();
    },
  );
};

export default routes;
