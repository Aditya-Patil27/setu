import type pg from 'pg';

/**
 * Just enough collection metadata to build a prompt from.
 *
 * Deliberately a local read rather than an import from the Data service. The
 * two services already share the database and the DDL generator is the only
 * thing permitted to emit collection DDL — reaching into its module here would
 * couple a read path to a write path for the sake of one query.
 */

export interface AiField {
  name: string;
  /** Purposes the tenant grants read access to. The tenant half of the two gates. */
  purposes: string[];
}

export interface AiCollection {
  id: string;
  name: string;
  tableName: string;
  schemaName: string;
  fields: AiField[];
}

export async function loadCollection(
  pool: pg.Pool,
  projectId: string,
  name: string,
): Promise<AiCollection | null> {
  const found = await pool.query<{
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
  if (!found.rowCount) return null;

  const fields = await pool.query<{ name: string; purposes: string[] }>(
    `SELECT f.name,
            COALESCE(array_agg(p.name) FILTER (WHERE p.name IS NOT NULL), '{}') AS purposes
       FROM field_definitions f
       LEFT JOIN field_purpose_grants g ON g.field_id = f.id
       LEFT JOIN purposes p             ON p.id = g.purpose_id
      WHERE f.collection_id = $1
      GROUP BY f.id
      ORDER BY f.created_at, f.name`,
    [found.rows[0].id],
  );

  return {
    id: found.rows[0].id,
    name: found.rows[0].name,
    tableName: found.rows[0].table_name,
    schemaName: found.rows[0].schema_name,
    fields: fields.rows.map((f) => ({ name: f.name, purposes: f.purposes })),
  };
}

export async function purposeId(
  client: pg.ClientBase,
  projectId: string,
  purpose: string,
): Promise<string | null> {
  const res = await client.query<{ id: string }>(
    `SELECT id FROM purposes WHERE project_id = $1 AND name = $2`,
    [projectId, purpose],
  );
  return res.rowCount ? res.rows[0].id : null;
}
