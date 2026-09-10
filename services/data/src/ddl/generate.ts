import { ValidationError } from '@setu/shared';
import {
  assertFieldName,
  assertIdentifier,
  qualify,
  quoteIdent,
  quoteLiteral,
  resolveType,
  type ColumnType,
} from './identifiers.js';

export type MaskStrategy = 'null' | 'redact' | 'partial' | 'hash';
export type Sensitivity = 'public' | 'personal' | 'sensitive';

export interface FieldSpec {
  name: string;
  type: string;
  sensitivity: Sensitivity;
  mask: MaskStrategy;
  /** Purpose names this field may be read under. The tenant's half of the two gates. */
  purposes: string[];
  nullable: boolean;
  indexed: boolean;
  unique: boolean;
}

/** Columns the platform generates on every collection. */
export const SYSTEM_COLUMNS = ['id', 'principal_id', 'created_at', 'updated_at'] as const;

/**
 * `<name>_masked` must still be a legal identifier, so the collection name has to
 * leave room for the suffix.
 */
const MAX_COLLECTION_NAME = 55;

export function maskedViewName(table: string): string {
  return `${table}_masked`;
}

export function assertCollectionName(name: string): string {
  assertIdentifier(name, 'collection name');
  if (name.length > MAX_COLLECTION_NAME) {
    throw new ValidationError(
      `Collection name must be at most ${MAX_COLLECTION_NAME} characters, to leave room for the _masked view`,
      { name },
    );
  }
  return name;
}

/** Validate a field and resolve its type. Throws on anything not expressible. */
export function validateField(field: FieldSpec): ColumnType {
  assertFieldName(field.name);
  const type = resolveType(field.type);

  if (field.mask !== 'null' && !type.isText) {
    throw new ValidationError(
      `Mask strategy '${field.mask}' needs a text column; '${field.name}' is ${field.type}. Use 'null'.`,
      { field: field.name, mask: field.mask, type: field.type },
    );
  }

  // A unique or indexed column is compared and ordered by the database in the
  // clear. Allowing that on a sensitive field would undercut the masking.
  if (field.sensitivity === 'sensitive' && field.unique) {
    throw new ValidationError(
      `Field '${field.name}' cannot be both sensitive and unique`,
      { field: field.name },
    );
  }

  return type;
}

/**
 * The consent predicate, shared by the policy's USING and WITH CHECK clauses.
 *
 * `NULLIF(..., '')` matters: an unset app.project_id arrives as the empty string,
 * and casting that to uuid raises rather than returning NULL. Failing closed means
 * returning no rows, not erroring.
 */
export function consentPredicate(table: string): string {
  return `EXISTS (
      SELECT 1
        FROM public.consent_artifacts ca
        JOIN public.purposes p ON p.id = ca.purpose_id
       WHERE ca.principal_id = ${quoteIdent(table)}.principal_id
         AND p.name       = current_setting('app.purpose', true)
         AND p.project_id = NULLIF(current_setting('app.project_id', true), '')::uuid
         AND ca.status = 'active'
         AND ca.revoked_at IS NULL
         AND (ca.expires_at IS NULL OR ca.expires_at > now())
    )`;
}

export function createTableSql(schema: string, table: string, fields: FieldSpec[]): string {
  const columns = fields.map((f) => {
    const type = validateField(f);
    return `  ${quoteIdent(f.name)} ${type.sql}${f.nullable ? '' : ' NOT NULL'}`;
  });

  return `CREATE TABLE ${qualify(schema, table)} (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "principal_id" UUID NOT NULL REFERENCES public.principals(id) ON DELETE CASCADE,
${columns.join(',\n')}${columns.length ? ',' : ''}
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT now()
)`;
}

/**
 * FORCE is not redundant with ENABLE: without it the table's owner ignores the
 * policy, and the owner role is the one that ran this DDL.
 */
export function enableRlsSql(schema: string, table: string): string[] {
  return [
    `ALTER TABLE ${qualify(schema, table)} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${qualify(schema, table)} FORCE ROW LEVEL SECURITY`,
  ];
}

export function policySql(schema: string, table: string): string {
  const predicate = consentPredicate(table);
  return `CREATE POLICY "consent_gate" ON ${qualify(schema, table)}
    FOR ALL
    USING (${predicate})
    WITH CHECK (${predicate})`;
}

function maskExpression(field: FieldSpec, type: ColumnType, alias = 't'): string {
  const col = `${alias}.${quoteIdent(field.name)}`;
  switch (field.mask) {
    case 'redact':
      return `'***'`;
    case 'partial':
      return `'****' || right(${col}, 4)`;
    case 'hash':
      return `encode(digest(${col}, 'sha256'), 'hex')`;
    case 'null':
    default:
      return `NULL::${type.sql}`;
  }
}

/**
 * Build the masking view.
 *
 * `security_invoker = true` is what keeps the base table's RLS in force: without
 * it the view runs as its owner, who can see every row, and the view becomes a
 * hole straight through the policy.
 */
export function maskingViewSql(
  schema: string,
  table: string,
  collectionId: string,
  fields: FieldSpec[],
): string {
  const projected = fields.map((f) => {
    const type = validateField(f);
    const visible = `public.setu_field_visible(t."principal_id", ${quoteLiteral(collectionId)}::uuid, ${quoteLiteral(f.name)}, current_setting('app.purpose', true))`;
    return `  CASE WHEN ${visible} THEN t.${quoteIdent(f.name)} ELSE ${maskExpression(f, type)} END AS ${quoteIdent(f.name)}`;
  });

  const system = SYSTEM_COLUMNS.map((c) => `  t.${quoteIdent(c)}`);

  return `CREATE VIEW ${qualify(schema, maskedViewName(table))} WITH (security_invoker = true) AS
SELECT
${[...system, ...projected].join(',\n')}
FROM ${qualify(schema, table)} t`;
}

export function dropViewSql(schema: string, table: string): string {
  return `DROP VIEW IF EXISTS ${qualify(schema, maskedViewName(table))}`;
}

export function indexSql(schema: string, table: string, fields: FieldSpec[]): string[] {
  const statements: string[] = [
    `CREATE INDEX ${quoteIdent(`${table}_principal_idx`)} ON ${qualify(schema, table)} ("principal_id")`,
    `CREATE INDEX ${quoteIdent(`${table}_created_idx`)} ON ${qualify(schema, table)} ("created_at" DESC, "id" DESC)`,
  ];

  for (const field of fields) {
    if (field.unique) {
      statements.push(
        `CREATE UNIQUE INDEX ${quoteIdent(`${table}_${field.name}_uniq`)} ON ${qualify(schema, table)} (${quoteIdent(field.name)})`,
      );
    } else if (field.indexed) {
      statements.push(
        `CREATE INDEX ${quoteIdent(`${table}_${field.name}_idx`)} ON ${qualify(schema, table)} (${quoteIdent(field.name)})`,
      );
    }
  }

  return statements;
}

/**
 * Grants for the read-path role.
 *
 * setu_runtime gets DML on the base table — RLS is what constrains it, not the
 * grant — and SELECT on the view it actually reads through.
 */
export function grantSql(schema: string, table: string): string[] {
  return [
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${qualify(schema, table)} TO setu_runtime`,
    `GRANT SELECT ON ${qualify(schema, maskedViewName(table))} TO setu_runtime`,
  ];
}

export function addColumnSql(schema: string, table: string, field: FieldSpec): string {
  const type = validateField(field);
  // Existing rows have no value, so a new column cannot be NOT NULL without a default.
  return `ALTER TABLE ${qualify(schema, table)} ADD COLUMN ${quoteIdent(field.name)} ${type.sql}`;
}
