/**
 * Wire types for the Setu public API.
 *
 * These mirror what the services actually return rather than what the database
 * stores — masked fields arrive present but redacted, which is why every field
 * value is `unknown` and never narrowed to the declared column type.
 */

export type FieldType =
  'text' | 'boolean' | 'integer' | 'bigint' | 'numeric' | 'date' | 'timestamptz' | 'uuid' | 'jsonb';

export type Sensitivity = 'public' | 'personal' | 'sensitive';
export type MaskStrategy = 'null' | 'redact' | 'partial' | 'hash';

/** A field as declared by the tenant. `purposes` is the tenant half of the two gates. */
export interface FieldInput {
  name: string;
  type: FieldType;
  sensitivity?: Sensitivity;
  mask?: MaskStrategy;
  purposes?: string[];
  nullable?: boolean;
  indexed?: boolean;
  unique?: boolean;
}

export interface Field {
  name: string;
  type: FieldType;
  sensitivity: Sensitivity;
  mask: MaskStrategy;
  purposes: string[];
  nullable: boolean;
  indexed: boolean;
  unique: boolean;
}

export interface Collection {
  id: string;
  name: string;
  fields: Field[];
}

/**
 * A row as the bound purpose is permitted to see it.
 *
 * Masked fields are present with a substituted value, never omitted: a stable
 * response shape is what stops absence itself becoming a signal.
 */
export type TenantRecord = Record<string, unknown> & {
  id: string;
  principalId: string;
  createdAt: string;
  updatedAt: string;
};

export interface RecordListPage {
  records: TenantRecord[];
  /** Present only when more rows exist. Pass it back as `cursor`. */
  nextCursor?: string;
}

/**
 * Filters are flat parameters. An equality is `field: value`; a range is
 * `field.gte`, `.gt`, `.lte` or `.lt`. `sort` is `column` or `column:asc`.
 */
export interface ListRecordsQuery {
  limit?: number;
  cursor?: string;
  sort?: string;
  [filter: string]: string | number | undefined;
}

export interface Purpose {
  id: string;
  name: string;
  description: string;
  legalBasis: string;
  createdAt: string;
}

export interface ConsentArtifact {
  id: string;
  principalId: string;
  purpose: string;
  fields: string[];
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}

export interface ConsentCheck {
  granted: boolean;
  fields: string[];
}

export interface AuditRecord {
  id: string;
  seq: number;
  principalId: string;
  purpose: string | null;
  action: string;
  resource: string;
  fields: string[];
  outcome: 'permitted' | 'denied';
  createdAt: string;
}

/** Why a row failed verification: its contents changed, or its link did. */
export type BreakReason = 'bad-digest' | 'broken-link';

export interface ChainBreak {
  seq: string;
  recordId: string;
  reason: BreakReason;
  expected: string;
  found: string;
}

/**
 * A broken chain is a successful verification that found something, so this
 * arrives with a 200 and `intact: false` rather than as an error.
 */
export interface ChainVerification {
  intact: boolean;
  checked: number;
  /** Every break, not only the first — one tampered row would otherwise mask the rest. */
  breaks: ChainBreak[];
  headHash: string | null;
}
