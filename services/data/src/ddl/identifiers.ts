import { ValidationError } from '@setu/shared';

/**
 * The DDL generator is the only place in Setu where caller-supplied strings reach
 * a CREATE statement, so it is the whole injection surface. Nothing here is
 * clever: names must match a narrow pattern, types come from a fixed map, and
 * everything is quoted on the way out even after passing both checks.
 */
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Columns the platform owns on every collection table. A tenant cannot declare
 * a field with one of these names — it would collide with the generated column.
 */
export const RESERVED_COLUMNS = new Set(['id', 'principal_id', 'created_at', 'updated_at']);

/** A small, deliberately boring subset of SQL keywords likely to be used as names. */
const RESERVED_WORDS = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'authorization',
  'between', 'both', 'case', 'cast', 'check', 'collate', 'column', 'constraint',
  'create', 'current_date', 'current_role', 'current_time', 'current_timestamp',
  'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end',
  'except', 'false', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in',
  'initially', 'intersect', 'into', 'leading', 'limit', 'localtime', 'localtimestamp',
  'not', 'null', 'offset', 'on', 'only', 'or', 'order', 'placing', 'primary',
  'references', 'returning', 'select', 'session_user', 'some', 'symmetric', 'table',
  'then', 'to', 'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic',
  'when', 'where', 'window', 'with',
]);

export interface ColumnType {
  /** The SQL type emitted into DDL. Never interpolated from input. */
  sql: string;
  /**
   * Whether the redact/partial/hash mask strategies are expressible.
   * For anything else, `null` is the only type-safe mask.
   */
  isText: boolean;
}

export const TYPE_ALLOWLIST: Record<string, ColumnType> = {
  text: { sql: 'TEXT', isText: true },
  boolean: { sql: 'BOOLEAN', isText: false },
  integer: { sql: 'INTEGER', isText: false },
  bigint: { sql: 'BIGINT', isText: false },
  numeric: { sql: 'NUMERIC', isText: false },
  date: { sql: 'DATE', isText: false },
  timestamptz: { sql: 'TIMESTAMPTZ', isText: false },
  uuid: { sql: 'UUID', isText: false },
  jsonb: { sql: 'JSONB', isText: false },
};

export type TypeName = keyof typeof TYPE_ALLOWLIST;

/**
 * Reject anything that is not a plain lower_snake_case identifier.
 *
 * This runs before quoting, not instead of it: quoting alone would happily accept
 * a name like `"; DROP TABLE x --` and produce a table nobody can work with.
 */
export function assertIdentifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new ValidationError(
      `${what} must be lower_snake_case, start with a letter, and be at most 63 characters`,
      { [what]: name },
    );
  }
  if (RESERVED_WORDS.has(name)) {
    throw new ValidationError(`${what} '${name}' is a reserved SQL word`, { [what]: name });
  }
  return name;
}

export function assertFieldName(name: string): string {
  assertIdentifier(name, 'field name');
  if (RESERVED_COLUMNS.has(name)) {
    throw new ValidationError(`Field name '${name}' is reserved by the platform`, { field: name });
  }
  return name;
}

export function resolveType(name: string): ColumnType {
  const type = TYPE_ALLOWLIST[name];
  if (!type) {
    throw new ValidationError(
      `Unsupported field type '${name}'. Supported: ${Object.keys(TYPE_ALLOWLIST).join(', ')}`,
      { type: name },
    );
  }
  return type;
}

/** Quote an identifier. Applied even to names that have already been validated. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a string literal for the rare places a bind parameter is not accepted (DDL). */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Fully-qualified, quoted table reference. */
export function qualify(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}
