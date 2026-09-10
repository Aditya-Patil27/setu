import type pg from "pg";
import {
  ConsentDeniedError,
  NotFoundError,
  ValidationError,
} from "@setu/shared";
import { withContext } from "@setu/db";
import { quoteIdent, qualify, TYPE_ALLOWLIST } from "../ddl/identifiers.js";
import type { CollectionRecord } from "../ddl/collections.js";
import { appendAudit, purposeId, recordDenial } from "./audit.js";

/**
 * Record access. Every statement here runs through `withContext`, which pins
 * app.project_id / app.purpose / app.principal_id to the transaction before the
 * first query lands — so the generated RLS policy and masking view evaluate the
 * caller's real context, not whatever was left on the pooled connection.
 */

/** SQLSTATE raised when an RLS WITH CHECK clause rejects a write. */
const CONSENT_VIOLATION = "42501";
/** SQLSTATE raised when a bind value cannot be cast to the column's type. */
const INVALID_TEXT_REPRESENTATION = "22P02";

type PgError = { code?: string };

function sqlState(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  return (err as PgError).code;
}

/**
 * System columns every collection table carries. Never masked, so always
 * available to filters and sorts.
 */
const SYSTEM_COLUMNS = {
  id: "UUID",
  principal_id: "UUID",
  created_at: "TIMESTAMPTZ",
  updated_at: "TIMESTAMPTZ",
} as const;

const RANGE_OPERATORS = ["gt", "gte", "lt", "lte"] as const;
type RangeOperator = (typeof RANGE_OPERATORS)[number];

const OPERATOR_SQL: Record<RangeOperator, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

export interface ListQuery {
  /** Column → predicate. Equality is exact; ranges compare with the operator. */
  equalities: Array<{ column: string; value: string }>;
  ranges: Array<{ column: string; op: RangeOperator; value: string }>;
  sortColumn: string;
  sortDirection: "asc" | "desc";
  limit: number;
  cursor?: string;
}

// ── Filter and sort eligibility ─────────────────────────────

/**
 * A column may appear in a filter or ORDER BY only if the current purpose can
 * read it in the clear.
 *
 * The gate that matters here is the tenant's policy (`field_purpose_grants`):
 * filtering a column the purpose cannot read turns the filter into an oracle
 * that leaks the value the mask hides — a hash mask answers dictionary probes,
 * a partial mask leaks its last four characters to range comparisons. The
 * rejection is a 400, decided before any SQL is built.
 *
 * Residual risk, deliberately accepted this wave: a principal who withheld a
 * field still sees it masked in their own rows, yet the column remains
 * filterable. Tightening that to per-row visibility needs plan-time knowledge of
 * every scanned principal's artifact and belongs to M7's policy work.
 */
export function assertColumnQueryable(
  collection: CollectionRecord,
  purpose: string,
  column: string,
): void {
  if (column in SYSTEM_COLUMNS) return;

  const field = collection.fields.find((f) => f.name === column);

  // One answer for both "no such field" and "exists, but this purpose holds no
  // grant on it". Naming the difference would let a caller enumerate a
  // collection's shape, and the tenant's purpose grants, from error messages
  // alone — and which fields exist is itself tenant data. The echoed name is
  // the caller's own input, so it discloses nothing they did not already send.
  if (!field || !field.purposes.includes(purpose)) {
    throw new ValidationError(`Field '${column}' cannot be used in this query`, {
      field: column,
    });
  }
}

/** SQL cast target for a column value, resolved from the declaration allowlist. */
function castFor(column: string, collection: CollectionRecord): string {
  if (column in SYSTEM_COLUMNS)
    return SYSTEM_COLUMNS[column as keyof typeof SYSTEM_COLUMNS];
  const field = collection.fields.find((f) => f.name === column);
  if (!field)
    throw new ValidationError(`Unknown field '${column}'`, { field: column });
  return TYPE_ALLOWLIST[field.type].sql;
}

// ── List query parsing ──────────────────────────────────────

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_SORT_COLUMN = "created_at";

/**
 * Parse the raw querystring into a validated ListQuery.
 *
 * Filters look like `?email=x@y.z` or `?created_at.gte=2026-01-01`. Repeated
 * parameters are rejected rather than silently taking the first: two values for
 * one predicate is a bug in the caller's request, not a preference.
 */
export function parseListQuery(
  collection: CollectionRecord,
  purpose: string,
  raw: Record<string, unknown>,
): ListQuery {
  const equalities: ListQuery["equalities"] = [];
  const ranges: ListQuery["ranges"] = [];
  let sortColumn = DEFAULT_SORT_COLUMN;
  let sortDirection: ListQuery["sortDirection"] = "desc";
  let limit = DEFAULT_LIMIT;
  let cursor: string | undefined;

  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      throw new ValidationError(`Parameter '${key}' was repeated`, {
        parameter: key,
      });
    }

    if (key === "cursor") {
      decodeCursor(String(value)); // fail fast on garbage before any SQL runs
      cursor = String(value);
      continue;
    }

    if (key === "limit") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        throw new ValidationError(
          `limit must be an integer between 1 and ${MAX_LIMIT}`,
          {
            limit: value,
          },
        );
      }
      limit = parsed;
      continue;
    }

    if (key === "sort") {
      const [column, direction = "desc"] = String(value).split(":");
      if (direction !== "asc" && direction !== "desc") {
        throw new ValidationError("sort direction must be 'asc' or 'desc'", {
          sort: value,
        });
      }
      sortColumn = column;
      sortDirection = direction;
      continue;
    }

    const dot = key.indexOf(".");
    const base = dot === -1 ? key : key.slice(0, dot);
    const suffix = dot === -1 ? undefined : key.slice(dot + 1);

    if (suffix === undefined) {
      assertColumnQueryable(collection, purpose, base);
      equalities.push({ column: base, value: String(value) });
    } else if ((RANGE_OPERATORS as readonly string[]).includes(suffix)) {
      assertColumnQueryable(collection, purpose, base);
      ranges.push({
        column: base,
        op: suffix as RangeOperator,
        value: String(value),
      });
    } else {
      throw new ValidationError(`Unknown query parameter '${key}'`, {
        parameter: key,
      });
    }
  }

  assertColumnQueryable(collection, purpose, sortColumn);

  /**
   * Keyset pagination needs a total order, and NULL has no place in one: a NULL
   * sort key makes the tuple comparison UNKNOWN and the row vanishes mid-walk.
   * Sortable columns must therefore be NOT NULL — the system columns are, and a
   * declared field must have been declared nullable = false.
   */
  if (!(sortColumn in SYSTEM_COLUMNS)) {
    const field = collection.fields.find((f) => f.name === sortColumn);
    if (!field?.indexed && !field?.unique) {
      throw new ValidationError(
        `Sorting requires an indexed column; '${sortColumn}' is neither indexed nor unique`,
        { sort: sortColumn },
      );
    }
    if (field.nullable) {
      throw new ValidationError(
        `Sorting on '${sortColumn}' requires a non-nullable column: nulls cannot participate in keyset pagination`,
        { sort: sortColumn },
      );
    }
  }

  return { equalities, ranges, sortColumn, sortDirection, limit, cursor };
}

function encodeCursor(
  sortColumn: string,
  direction: string,
  value: unknown,
  id: string,
): string {
  return Buffer.from(
    JSON.stringify({ c: sortColumn, d: direction, v: value, id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(raw: string): {
  c: string;
  d: string;
  v: unknown;
  id: string;
} {
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      typeof (decoded as { c?: unknown }).c !== "string" ||
      typeof (decoded as { id?: unknown }).id !== "string"
    ) {
      throw new Error("malformed");
    }
    return decoded as { c: string; d: string; v: unknown; id: string };
  } catch {
    throw new ValidationError("cursor is malformed", {
      cursor: raw.slice(0, 32),
    });
  }
}

// ── Presentation ────────────────────────────────────────────

interface RawRow extends Record<string, unknown> {
  id: string;
  principal_id: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Tenant field names keep their declared spelling; only the platform-owned
 * columns are recased. Masking has already been applied by the view, so the
 * shape a caller sees is exactly what Postgres decided they may see.
 */
function present(row: RawRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    switch (key) {
      case "principal_id":
        out.principalId = value;
        break;
      case "created_at":
        out.createdAt = value;
        break;
      case "updated_at":
        out.updatedAt = value;
        break;
      default:
        out[key] = value;
    }
  }
  return out;
}

// ── Error translation ───────────────────────────────────────

function mapPgError(err: unknown, purpose: string, fields: string[]): Error {
  const state = sqlState(err);
  if (state === CONSENT_VIOLATION)
    return new ConsentDeniedError(purpose, fields);
  if (state === INVALID_TEXT_REPRESENTATION) {
    return new ValidationError(
      "A filter value is not valid for its field type",
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

// ── Operations ──────────────────────────────────────────────

export interface RequestContext {
  projectId: string;
  purpose: string;
  principalId?: string;
}

export interface CreateInput {
  principalId: string;
  fields: Record<string, unknown>;
}

/**
 * Insert a record on the base table, then read it back through the masking view.
 *
 * The write carries the consent predicate as WITH CHECK, so a record about a
 * principal who never agreed to this purpose cannot exist — SQLSTATE 42501 maps
 * to an explicit 403, the one denial this service is allowed to speak aloud,
 * because the caller attempted a write and deserves to know it failed.
 */
export async function createRecord(
  pool: pg.Pool,
  ctx: RequestContext,
  collection: CollectionRecord,
  input: CreateInput,
): Promise<Record<string, unknown>> {
  const declared = new Set(collection.fields.map((f) => f.name));
  for (const name of Object.keys(input.fields)) {
    if (!declared.has(name)) {
      throw new ValidationError(
        `Unknown field '${name}' on collection '${collection.name}'`,
        {
          field: name,
        },
      );
    }
  }
  for (const field of collection.fields) {
    if (!field.nullable && !(field.name in input.fields)) {
      throw new ValidationError(`Field '${field.name}' is required`, {
        field: field.name,
      });
    }
  }

  const columns = ["principal_id", ...Object.keys(input.fields)];
  const values = [input.principalId, ...Object.values(input.fields)];
  const placeholders = columns.map(
    (col, i) => `$${i + 1}::${castFor(col, collection)}`,
  );

  return withContext(pool, ctx, async (client) => {
    const pid = await purposeId(client, ctx.projectId, ctx.purpose);
    const table = qualify(collection.schemaName, collection.tableName);

    let insertedId: string;
    let rowPrincipalId: string;
    try {
      const res = await client.query<{ id: string; principal_id: string }>(
        `INSERT INTO ${table} (${columns.map(quoteIdent).join(", ")})
         VALUES (${placeholders.join(", ")})
         RETURNING id, principal_id`,
        values,
      );
      insertedId = res.rows[0].id;
      rowPrincipalId = res.rows[0].principal_id;
    } catch (err) {
      throw mapPgError(err, ctx.purpose, Object.keys(input.fields));
    }

    await appendAudit(client, {
      projectId: ctx.projectId,
      principalId: rowPrincipalId,
      purposeId: pid,
      action: "create",
      resource: `${collection.schemaName}.${collection.tableName}/${insertedId}`,
      fields: Object.keys(input.fields),
    });

    const readBack = await client.query<RawRow>(
      `SELECT * FROM ${qualify(collection.schemaName, maskedName(collection.tableName))}
       WHERE id = $1::uuid`,
      [insertedId],
    );
    return present(readBack.rows[0]);
  });
}

function maskedName(table: string): string {
  return `${table}_masked`;
}

export async function getRecord(
  pool: pg.Pool,
  ctx: RequestContext,
  collection: CollectionRecord,
  recordId: string,
): Promise<Record<string, unknown>> {
  return withContext(pool, ctx, async (client) => {
    const pid = await purposeId(client, ctx.projectId, ctx.purpose);

    const res = await client.query<RawRow>(
      `SELECT * FROM ${qualify(collection.schemaName, maskedName(collection.tableName))}
       WHERE id = $1::uuid`,
      [recordId],
    );

    if (!res.rowCount) {
      // Zero rows is "absent" or "forbidden" — the response must not say which,
      // but the audit chain records the truth behind the 404.
      await recordDenial(pool, ctx, {
        projectId: ctx.projectId,
        schemaName: collection.schemaName,
        tableName: collection.tableName,
        recordId,
        purposeId: pid,
        action: "read",
        fields: collection.fields.map((f) => f.name),
      });
      throw new NotFoundError("Record", recordId);
    }

    await appendAudit(client, {
      projectId: ctx.projectId,
      principalId: res.rows[0].principal_id,
      purposeId: pid,
      action: "read",
      resource: `${collection.schemaName}.${collection.tableName}/${recordId}`,
      fields: collection.fields.map((f) => f.name),
    });

    return present(res.rows[0]);
  });
}

/**
 * List through the masking view with keyset pagination.
 *
 * An RLS-filtered list is indistinguishable from an empty one and returns `[]`
 * either way; unlike a point read there is no single row whose existence could
 * establish a denial, so nothing is recorded here.
 */
export async function listRecords(
  pool: pg.Pool,
  ctx: RequestContext,
  collection: CollectionRecord,
  query: ListQuery,
): Promise<{ records: Array<Record<string, unknown>>; nextCursor?: string }> {
  return withContext(pool, ctx, async (client) => {
    const params: unknown[] = [];
    const where: string[] = [];

    for (const eq of query.equalities) {
      params.push(eq.value);
      where.push(
        `${quoteIdent(eq.column)} = $${params.length}::${castFor(eq.column, collection)}`,
      );
    }
    for (const range of query.ranges) {
      params.push(range.value);
      where.push(
        `${quoteIdent(range.column)} ${OPERATOR_SQL[range.op]} $${params.length}::${castFor(range.column, collection)}`,
      );
    }

    if (query.cursor) {
      const cur = decodeCursor(query.cursor);
      if (cur.c !== query.sortColumn || cur.d !== query.sortDirection) {
        throw new ValidationError("cursor does not match the current sort", {
          cursor: true,
        });
      }
      params.push(cur.v, cur.id);
      const comparator = query.sortDirection === "desc" ? "<" : ">";
      where.push(
        `(${quoteIdent(query.sortColumn)}, "id") ${comparator}` +
          ` ($${params.length - 1}::${castFor(query.sortColumn, collection)}, $${params.length}::uuid)`,
      );
    }

    const dir = query.sortDirection.toUpperCase();
    params.push(query.limit + 1);
    const sql =
      `SELECT * FROM ${qualify(collection.schemaName, maskedName(collection.tableName))}` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY ${quoteIdent(query.sortColumn)} ${dir}, "id" ${dir}` +
      ` LIMIT $${params.length}`;

    const res = await client.query<RawRow>(sql, params);

    if (ctx.principalId && res.rowCount) {
      const pid = await purposeId(client, ctx.projectId, ctx.purpose);
      await appendAudit(client, {
        projectId: ctx.projectId,
        principalId: ctx.principalId,
        purposeId: pid,
        action: "list",
        resource: `${collection.schemaName}.${collection.tableName}`,
        fields: collection.fields.map((f) => f.name),
      });
    }

    const rows = res.rows;
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);

    return {
      records: page.map(present),
      ...(hasMore && last
        ? {
            nextCursor: encodeCursor(
              query.sortColumn,
              query.sortDirection,
              serializeSortValue(last[query.sortColumn]),
              last.id,
            ),
          }
        : {}),
    };
  });
}

/** Dates become ISO strings so the round-trip through the cursor casts back cleanly. */
function serializeSortValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

export interface UpdateInput {
  fields: Record<string, unknown>;
}

export async function updateRecord(
  pool: pg.Pool,
  ctx: RequestContext,
  collection: CollectionRecord,
  recordId: string,
  input: UpdateInput,
): Promise<Record<string, unknown>> {
  if (Object.keys(input.fields).length === 0) {
    throw new ValidationError("No fields to update");
  }

  const declared = new Set(collection.fields.map((f) => f.name));
  for (const name of Object.keys(input.fields)) {
    if (!declared.has(name)) {
      throw new ValidationError(
        `Unknown field '${name}' on collection '${collection.name}'`,
        {
          field: name,
        },
      );
    }
  }

  return withContext(pool, ctx, async (client) => {
    const pid = await purposeId(client, ctx.projectId, ctx.purpose);
    const table = qualify(collection.schemaName, collection.tableName);

    const assignments = Object.keys(input.fields).map(
      (col, i) => `${quoteIdent(col)} = $${i + 2}::${castFor(col, collection)}`,
    );
    const values = [recordId, ...Object.values(input.fields)];

    await client.query("SAVEPOINT record_write");
    let rowPrincipalId: string;
    try {
      const res = await client.query<{ principal_id: string }>(
        `UPDATE ${table} SET ${assignments.join(", ")}, "updated_at" = now()
         WHERE id = $1::uuid
         RETURNING principal_id`,
        values,
      );
      if (!res.rowCount) {
        // Same opacity contract as the read path.
        await recordDenial(pool, ctx, {
          projectId: ctx.projectId,
          schemaName: collection.schemaName,
          tableName: collection.tableName,
          recordId,
          purposeId: pid,
          action: "update",
          fields: Object.keys(input.fields),
        });
        throw new NotFoundError("Record", recordId);
      }
      rowPrincipalId = res.rows[0].principal_id;
      await client.query("RELEASE SAVEPOINT record_write");
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT record_write");
      if (sqlState(err) === CONSENT_VIOLATION) {
        // The statement aborted the surrounding work; the savepoint lets the
        // denial still reach the audit chain inside this same transaction.
        await recordDenial(pool, ctx, {
          projectId: ctx.projectId,
          schemaName: collection.schemaName,
          tableName: collection.tableName,
          recordId,
          purposeId: pid,
          action: "update",
          fields: Object.keys(input.fields),
        });
      }
      throw mapPgError(err, ctx.purpose, Object.keys(input.fields));
    }

    await appendAudit(client, {
      projectId: ctx.projectId,
      principalId: rowPrincipalId,
      purposeId: pid,
      action: "update",
      resource: `${collection.schemaName}.${collection.tableName}/${recordId}`,
      fields: Object.keys(input.fields),
    });

    const readBack = await client.query<RawRow>(
      `SELECT * FROM ${qualify(collection.schemaName, maskedName(collection.tableName))}
       WHERE id = $1::uuid`,
      [recordId],
    );
    return present(readBack.rows[0]);
  });
}

export async function deleteRecord(
  pool: pg.Pool,
  ctx: RequestContext,
  collection: CollectionRecord,
  recordId: string,
): Promise<void> {
  return withContext(pool, ctx, async (client) => {
    const pid = await purposeId(client, ctx.projectId, ctx.purpose);
    const table = qualify(collection.schemaName, collection.tableName);

    await client.query("SAVEPOINT record_write");
    let rowPrincipalId: string;
    try {
      const res = await client.query<{ principal_id: string }>(
        `DELETE FROM ${table} WHERE id = $1::uuid RETURNING principal_id`,
        [recordId],
      );
      if (!res.rowCount) {
        await recordDenial(pool, ctx, {
          projectId: ctx.projectId,
          schemaName: collection.schemaName,
          tableName: collection.tableName,
          recordId,
          purposeId: pid,
          action: "delete",
          fields: [],
        });
        throw new NotFoundError("Record", recordId);
      }
      rowPrincipalId = res.rows[0].principal_id;
      await client.query("RELEASE SAVEPOINT record_write");
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT record_write");
      if (sqlState(err) === CONSENT_VIOLATION) {
        await recordDenial(pool, ctx, {
          projectId: ctx.projectId,
          schemaName: collection.schemaName,
          tableName: collection.tableName,
          recordId,
          purposeId: pid,
          action: "delete",
          fields: [],
        });
      }
      throw mapPgError(err, ctx.purpose, []);
    }

    await appendAudit(client, {
      projectId: ctx.projectId,
      principalId: rowPrincipalId,
      purposeId: pid,
      action: "delete",
      resource: `${collection.schemaName}.${collection.tableName}/${recordId}`,
      fields: [],
    });
  });
}
