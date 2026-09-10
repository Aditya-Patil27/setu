import type pg from 'pg';
import { ConflictError, NotFoundError, ValidationError } from '@setu/shared';
import {
  addColumnSql,
  assertCollectionName,
  createTableSql,
  dropViewSql,
  enableRlsSql,
  grantSql,
  indexSql,
  maskedViewName,
  maskingViewSql,
  policySql,
  validateField,
  type FieldSpec,
} from './generate.js';

export interface FieldRecord {
  id: string;
  name: string;
  type: string;
  sensitivity: string;
  mask: string;
  nullable: boolean;
  indexed: boolean;
  unique: boolean;
  /** Purpose names the tenant has granted read access to this field. */
  purposes: string[];
}

export interface CollectionRecord {
  id: string;
  name: string;
  tableName: string;
  schemaName: string;
  fields: FieldRecord[];
}

async function projectSchema(client: pg.ClientBase, projectId: string): Promise<string> {
  const res = await client.query<{ schema_name: string }>(
    `SELECT schema_name FROM projects WHERE id = $1`,
    [projectId],
  );
  if (!res.rowCount) throw new NotFoundError('Project', projectId);
  return res.rows[0].schema_name;
}

/**
 * Resolve purpose names to ids within the project.
 *
 * An unknown purpose is an error rather than a silently dropped grant: a field
 * declared readable under a purpose that does not exist would be permanently
 * invisible, which is a confusing way to lose data.
 */
async function resolvePurposes(
  client: pg.ClientBase,
  projectId: string,
  names: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(names)];
  if (unique.length === 0) return new Map();

  const res = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM purposes WHERE project_id = $1 AND name = ANY($2::text[])`,
    [projectId, unique],
  );

  const found = new Map(res.rows.map((r) => [r.name, r.id]));
  const missing = unique.filter((n) => !found.has(n));
  if (missing.length) {
    throw new ValidationError(`Unknown purpose(s): ${missing.join(', ')}`, { purposes: missing });
  }
  return found;
}

async function insertFields(
  client: pg.ClientBase,
  projectId: string,
  collectionId: string,
  fields: FieldSpec[],
): Promise<void> {
  const purposeIds = await resolvePurposes(client, projectId, fields.flatMap((f) => f.purposes));

  for (const field of fields) {
    validateField(field);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO field_definitions
         (collection_id, name, pg_type, sensitivity, mask_strategy, is_nullable, is_indexed, is_unique)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        collectionId,
        field.name,
        field.type,
        field.sensitivity,
        field.mask,
        field.nullable,
        field.indexed,
        field.unique,
      ],
    );

    for (const purpose of new Set(field.purposes)) {
      await client.query(
        `INSERT INTO field_purpose_grants (field_id, purpose_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [inserted.rows[0].id, purposeIds.get(purpose)],
      );
    }
  }
}

/**
 * Declare a collection: metadata rows, physical table, RLS policy and masking view,
 * all in one transaction.
 *
 * Metadata and generated objects are written together deliberately — the masking
 * view is built from the metadata, so if the two could drift, a field could end up
 * projected in the clear with no record of why.
 */
export async function declareCollection(
  owner: pg.Pool,
  projectId: string,
  name: string,
  fields: FieldSpec[],
): Promise<CollectionRecord> {
  assertCollectionName(name);
  fields.forEach(validateField);

  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.name)) {
      throw new ValidationError(`Duplicate field '${field.name}'`, { field: field.name });
    }
    seen.add(field.name);
  }

  const client = await owner.connect();
  try {
    await client.query('BEGIN');

    const schema = await projectSchema(client, projectId);
    const tableName = name;

    const exists = await client.query(
      `SELECT 1 FROM collection_definitions WHERE project_id = $1 AND name = $2`,
      [projectId, name],
    );
    if (exists.rowCount) throw new ConflictError(`Collection '${name}' already exists`);

    const collection = await client.query<{ id: string }>(
      `INSERT INTO collection_definitions (project_id, name, table_name)
       VALUES ($1, $2, $3) RETURNING id`,
      [projectId, name, tableName],
    );
    const collectionId = collection.rows[0].id;

    await insertFields(client, projectId, collectionId, fields);

    await client.query(createTableSql(schema, tableName, fields));
    for (const sql of indexSql(schema, tableName, fields)) await client.query(sql);
    for (const sql of enableRlsSql(schema, tableName)) await client.query(sql);
    await client.query(policySql(schema, tableName));
    await client.query(maskingViewSql(schema, tableName, collectionId, fields));
    for (const sql of grantSql(schema, tableName)) await client.query(sql);

    await client.query('COMMIT');

    return (await loadCollection(owner, projectId, name))!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Add fields to an existing collection and rebuild its masking view. */
export async function addFields(
  owner: pg.Pool,
  projectId: string,
  name: string,
  fields: FieldSpec[],
): Promise<CollectionRecord> {
  fields.forEach(validateField);

  const existing = await loadCollection(owner, projectId, name);
  if (!existing) throw new NotFoundError('Collection', name);

  for (const field of fields) {
    if (existing.fields.some((f) => f.name === field.name)) {
      throw new ConflictError(`Field '${field.name}' already exists on '${name}'`);
    }
    if (!field.nullable) {
      throw new ValidationError(
        `Field '${field.name}' cannot be NOT NULL: existing rows have no value for it`,
        { field: field.name },
      );
    }
  }

  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    const schema = await projectSchema(client, projectId);

    await insertFields(client, projectId, existing.id, fields);

    for (const field of fields) {
      await client.query(addColumnSql(schema, existing.tableName, field));
    }
    for (const sql of indexSql(schema, existing.tableName, fields).slice(2)) {
      await client.query(sql);
    }

    // The view projects a fixed column list, so it is rebuilt rather than patched.
    await client.query(dropViewSql(schema, existing.tableName));

    const allFields = await readFieldSpecs(client, existing.id);
    await client.query(maskingViewSql(schema, existing.tableName, existing.id, allFields));
    await client.query(
      `GRANT SELECT ON ${schemaQualifiedView(schema, existing.tableName)} TO setu_runtime`,
    );

    await client.query('COMMIT');
    return (await loadCollection(owner, projectId, name))!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function schemaQualifiedView(schema: string, table: string): string {
  return `"${schema.replace(/"/g, '""')}"."${maskedViewName(table).replace(/"/g, '""')}"`;
}

async function readFieldSpecs(client: pg.ClientBase, collectionId: string): Promise<FieldSpec[]> {
  const res = await client.query<{
    name: string;
    pg_type: string;
    sensitivity: string;
    mask_strategy: string;
    is_nullable: boolean;
    is_indexed: boolean;
    is_unique: boolean;
  }>(
    `SELECT name, pg_type, sensitivity, mask_strategy, is_nullable, is_indexed, is_unique
       FROM field_definitions WHERE collection_id = $1 ORDER BY created_at, name`,
    [collectionId],
  );

  return res.rows.map((r) => ({
    name: r.name,
    type: r.pg_type,
    sensitivity: r.sensitivity as FieldSpec['sensitivity'],
    mask: r.mask_strategy as FieldSpec['mask'],
    purposes: [],
    nullable: r.is_nullable,
    indexed: r.is_indexed,
    unique: r.is_unique,
  }));
}

export async function loadCollection(
  pool: pg.Pool,
  projectId: string,
  name: string,
): Promise<CollectionRecord | null> {
  const res = await pool.query<{
    id: string;
    name: string;
    table_name: string;
    schema_name: string;
  }>(
    `SELECT c.id, c.name, c.table_name, p.schema_name
       FROM collection_definitions c
       JOIN projects p ON p.id = c.project_id
      WHERE c.project_id = $1 AND c.name = $2`,
    [projectId, name],
  );
  if (!res.rowCount) return null;

  const fields = await pool.query<{
    id: string;
    name: string;
    pg_type: string;
    sensitivity: string;
    mask_strategy: string;
    is_nullable: boolean;
    is_indexed: boolean;
    is_unique: boolean;
    purposes: string[];
  }>(
    `SELECT f.id, f.name, f.pg_type, f.sensitivity, f.mask_strategy,
            f.is_nullable, f.is_indexed, f.is_unique,
            COALESCE(array_agg(p.name) FILTER (WHERE p.name IS NOT NULL), '{}') AS purposes
       FROM field_definitions f
       LEFT JOIN field_purpose_grants g ON g.field_id = f.id
       LEFT JOIN purposes p             ON p.id = g.purpose_id
      WHERE f.collection_id = $1
      GROUP BY f.id
      ORDER BY f.created_at, f.name`,
    [res.rows[0].id],
  );

  return {
    id: res.rows[0].id,
    name: res.rows[0].name,
    tableName: res.rows[0].table_name,
    schemaName: res.rows[0].schema_name,
    fields: fields.rows.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.pg_type,
      sensitivity: f.sensitivity,
      mask: f.mask_strategy,
      nullable: f.is_nullable,
      indexed: f.is_indexed,
      unique: f.is_unique,
      purposes: f.purposes,
    })),
  };
}

export async function listCollections(pool: pg.Pool, projectId: string): Promise<string[]> {
  const res = await pool.query<{ name: string }>(
    `SELECT name FROM collection_definitions WHERE project_id = $1 ORDER BY name`,
    [projectId],
  );
  return res.rows.map((r) => r.name);
}
