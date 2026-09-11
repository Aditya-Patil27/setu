import { z } from 'zod';
import type { SetuClient } from '@setu/sdk';
import type { McpConfig } from './config.js';

/**
 * The tool surface.
 *
 * Every tool is a thin wrapper over one gateway route. Nothing here decides
 * what an agent may see — the purpose it names is bound at the gateway and
 * evaluated by Postgres, so a tool cannot widen its own access no matter what
 * arguments it is called with.
 */

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** Mutates tenant or control-plane state; gated behind SETU_ALLOW_WRITES. */
  write?: boolean;
  handler: (args: Record<string, unknown>, client: SetuClient) => Promise<unknown>;
}

const FieldInputSchema = z.object({
  name: z.string().describe('Column name, lower_snake_case'),
  type: z
    .enum([
      'text',
      'boolean',
      'integer',
      'bigint',
      'numeric',
      'date',
      'timestamptz',
      'uuid',
      'jsonb',
    ])
    .describe('Postgres column type'),
  sensitivity: z.enum(['public', 'personal', 'sensitive']).optional(),
  mask: z
    .enum(['null', 'redact', 'partial', 'hash'])
    .optional()
    .describe(
      'What a purpose that may not read this field sees instead. ' +
        "'redact' yields ***, 'partial' keeps the last 4 characters, " +
        "'null' yields null. Non-text columns must use 'null'.",
    ),
  purposes: z
    .array(z.string())
    .optional()
    .describe(
      'Purposes the tenant grants read access to. This is only half the gate — ' +
        'the data subject must also have consented to the field.',
    ),
  nullable: z.boolean().optional(),
  indexed: z.boolean().optional(),
  unique: z.boolean().optional(),
});

/**
 * The purpose parameter, as a closed enum over the configured allowlist.
 *
 * Declaring it as an enum rather than a string is what stops an agent inventing
 * a purpose: the value is rejected by schema validation before any request is
 * made, and the tool description tells the model what the choice means.
 */
function purposeSchema(config: McpConfig) {
  const description =
    'Why this data is being accessed. The database evaluates consent against ' +
    'this value, and it is recorded in the audit trail. Choose the narrowest ' +
    'purpose that fits the task.';

  if (config.purposes.length === 0) {
    return z.string().describe(description);
  }
  // z.enum needs a non-empty tuple.
  const [first, ...rest] = config.purposes;
  return z.enum([first, ...rest] as [string, ...string[]]).describe(description);
}

export function buildTools(config: McpConfig): ToolDefinition[] {
  const purpose = purposeSchema(config);

  const tools: ToolDefinition[] = [
    // ── Collections ─────────────────────────────────────────
    {
      name: 'setu_list_collections',
      title: 'List collections',
      description:
        'List every collection declared in this project. Control-plane only: ' +
        'reads no records and binds no purpose.',
      inputSchema: {},
      handler: (_args, client) => client.listCollections(),
    },
    {
      name: 'setu_describe_collection',
      title: 'Describe a collection',
      description:
        'Return a collection with every field, its mask strategy, and which ' +
        'purposes the tenant has granted read access to. Call this before ' +
        'querying so you know which fields a given purpose can actually see.',
      inputSchema: { name: z.string().describe('Collection name') },
      handler: (args, client) => client.getCollection(args.name as string),
    },
    {
      name: 'setu_create_collection',
      title: 'Declare a collection',
      description:
        'Declare a collection. One call generates the table, its row-level ' +
        'security policy and its masking view. Field purposes set the tenant ' +
        'half of the two-gate field check.',
      inputSchema: {
        name: z.string().describe('Collection name, at most 55 characters'),
        fields: z.array(FieldInputSchema).min(1),
      },
      write: true,
      handler: (args, client) =>
        client.createCollection(
          args.name as string,
          args.fields as Parameters<SetuClient['createCollection']>[1],
        ),
    },
    {
      name: 'setu_add_fields',
      title: 'Add fields to a collection',
      description: 'Extend an existing collection with new fields and rebuild its masking view.',
      inputSchema: {
        name: z.string(),
        fields: z.array(FieldInputSchema).min(1),
      },
      write: true,
      handler: (args, client) =>
        client.addFields(
          args.name as string,
          args.fields as Parameters<SetuClient['addFields']>[1],
        ),
    },

    // ── Records ─────────────────────────────────────────────
    {
      name: 'setu_list_records',
      title: 'List records',
      description:
        'List records under a purpose. Results come back already masked for ' +
        'that purpose — a field you are not granted arrives redacted, not ' +
        'omitted. Filtering or sorting on a field the purpose cannot read is ' +
        'refused, because that would let the value be inferred.',
      inputSchema: {
        collection: z.string(),
        purpose,
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional().describe('nextCursor from a previous page'),
        sort: z.string().optional().describe("Column, or 'column:asc'"),
        filters: z
          .record(z.string())
          .optional()
          .describe(
            "Flat filters: { city: 'Pune' } for equality, " +
              "{ 'created_at.gte': '2026-01-01' } for a range.",
          ),
      },
      handler: (args, client) =>
        client.listRecords(args.collection as string, args.purpose as string, {
          ...((args.filters as Record<string, string>) ?? {}),
          limit: args.limit as number | undefined,
          cursor: args.cursor as string | undefined,
          sort: args.sort as string | undefined,
        }),
    },
    {
      name: 'setu_get_record',
      title: 'Get one record',
      description:
        'Read a single record under a purpose. A record that exists but is not ' +
        'visible to this purpose returns the same not-found as one that never ' +
        'existed — the difference is recorded in the audit trail, not returned.',
      inputSchema: { collection: z.string(), purpose, id: z.string() },
      handler: (args, client) =>
        client.getRecord(args.collection as string, args.purpose as string, args.id as string),
    },
    {
      name: 'setu_create_record',
      title: 'Create a record',
      description:
        'Create a record belonging to a principal. The principal must already ' +
        'have consented to this purpose or the write is refused.',
      inputSchema: {
        collection: z.string(),
        purpose,
        principalId: z.string().describe('UUID of the data subject this row is about'),
        fields: z.record(z.unknown()).describe('Declared field values, by name'),
      },
      write: true,
      handler: (args, client) =>
        client.createRecord(
          args.collection as string,
          args.purpose as string,
          args.principalId as string,
          args.fields as Record<string, unknown>,
        ),
    },
    {
      name: 'setu_update_record',
      title: 'Update a record',
      description: 'Update declared fields on a record under a purpose.',
      inputSchema: {
        collection: z.string(),
        purpose,
        id: z.string(),
        fields: z.record(z.unknown()),
      },
      write: true,
      handler: (args, client) =>
        client.updateRecord(
          args.collection as string,
          args.purpose as string,
          args.id as string,
          args.fields as Record<string, unknown>,
        ),
    },
    {
      name: 'setu_delete_record',
      title: 'Delete a record',
      description: 'Delete a record under a purpose.',
      inputSchema: { collection: z.string(), purpose, id: z.string() },
      write: true,
      handler: async (args, client) => {
        await client.deleteRecord(
          args.collection as string,
          args.purpose as string,
          args.id as string,
        );
        return { deleted: args.id };
      },
    },

    // ── Purposes ────────────────────────────────────────────
    {
      name: 'setu_list_purposes',
      title: 'List purposes',
      description:
        'List the purposes registered for this project. This is the vocabulary ' +
        'every consent decision and every access is evaluated against.',
      inputSchema: {},
      handler: (_args, client) => client.listPurposes(),
    },
    {
      name: 'setu_create_purpose',
      title: 'Register a purpose',
      description:
        'Register a new purpose. Note that registering one does not let this ' +
        'server bind it — the allowlist it may choose from is fixed by ' +
        'configuration, not by the registry.',
      inputSchema: {
        name: z.string().describe('lower_snake_case'),
        description: z.string().optional(),
        legalBasis: z.string().optional(),
      },
      write: true,
      handler: (args, client) =>
        client.createPurpose(
          args.name as string,
          args.description as string | undefined,
          args.legalBasis as string | undefined,
        ),
    },

    // ── Consent ─────────────────────────────────────────────
    {
      name: 'setu_list_consents',
      title: 'List consent artifacts',
      description: 'List consent artifacts, optionally for one principal.',
      inputSchema: { principalId: z.string().optional() },
      handler: (args, client) => client.listConsents(args.principalId as string | undefined),
    },
    {
      name: 'setu_check_consent',
      title: 'Check consent',
      description:
        'Check whether a principal has granted a purpose, and which fields. ' +
        'Cheaper than attempting a read and interpreting the masking.',
      inputSchema: { principalId: z.string(), purpose: z.string() },
      handler: (args, client) =>
        client.checkConsent(args.principalId as string, args.purpose as string),
    },
    {
      name: 'setu_grant_consent',
      title: 'Grant consent',
      description:
        'Record that a principal consented to a purpose over specific fields. ' +
        'Supersedes any active artifact for the same principal and purpose.',
      inputSchema: {
        principalId: z.string(),
        purpose: z.string(),
        fields: z.array(z.string()).min(1),
        expiresAt: z.string().optional().describe('ISO 8601 timestamp'),
      },
      write: true,
      handler: (args, client) =>
        client.grantConsent(
          args.principalId as string,
          args.purpose as string,
          args.fields as string[],
          args.expiresAt as string | undefined,
        ),
    },
    {
      name: 'setu_revoke_consent',
      title: 'Revoke consent',
      description:
        'Revoke a consent artifact by id. Rows that depended on it become ' +
        'invisible immediately, through row-level security rather than a sweep.',
      inputSchema: { id: z.string() },
      write: true,
      handler: (args, client) => client.revokeConsent(args.id as string),
    },

    // ── Audit ───────────────────────────────────────────────
    {
      name: 'setu_audit_records',
      title: 'Read the audit trail',
      description:
        'Read the hash-chained audit trail: who accessed what, under which ' +
        'purpose, and whether it was permitted or denied. Every call made ' +
        'through these tools appears here.',
      inputSchema: {
        principalId: z.string().optional(),
        purpose: z.string().optional(),
        action: z.enum(['read', 'create', 'update', 'delete']).optional(),
        outcome: z.enum(['permitted', 'denied']).optional(),
        since: z.string().optional().describe('ISO 8601'),
        until: z.string().optional().describe('ISO 8601'),
        after: z.number().int().optional().describe('Keyset cursor: seq of the last row seen'),
        limit: z.number().int().min(1).max(200).optional(),
      },
      handler: (args, client) =>
        client.listAuditRecords(args as Parameters<SetuClient['listAuditRecords']>[0]),
    },
    {
      name: 'setu_verify_chain',
      title: 'Verify the audit chain',
      description:
        'Recompute every digest in the project audit chain and report whether ' +
        'it is intact. A broken chain returns intact: false with the breaks, ' +
        'not an error.',
      inputSchema: {},
      handler: (_args, client) => client.verifyChain(),
    },
  ];

  return config.allowWrites ? tools : tools.filter((t) => !t.write);
}
