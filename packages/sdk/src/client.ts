import { SETU } from '@setu/shared';

export interface SetuClientConfig {
  /** Base URL of the Setu API gateway. */
  url: string;
  /** Project API key. */
  apiKey: string;
}

/**
 * Setu TypeScript client SDK.
 *
 * Provides a fluent, purpose-aware interface for interacting with the
 * Setu platform — authentication, data queries, file storage, and functions.
 */
export class SetuClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: SetuClientConfig) {
    this.baseUrl = config.url.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
  }

  /**
   * Start building a query against a tenant table.
   */
  from(table: string): QueryBuilder {
    return new QueryBuilder(this.baseUrl, this.apiKey, table);
  }

  // TODO: auth, storage, functions, workflows
}

/**
 * Fluent query builder with `.forPurpose()` as the terminal method.
 */
class QueryBuilder {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly table: string;
  private columns: string = '*';
  private purpose?: string;
  private filters: Array<{ column: string; op: string; value: unknown }> = [];

  constructor(baseUrl: string, apiKey: string, table: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.table = table;
  }

  select(columns: string): this {
    this.columns = columns;
    return this;
  }

  where(column: string, op: string, value: unknown): this {
    this.filters.push({ column, op, value });
    return this;
  }

  /**
   * Declare the purpose for this data access.
   * This is evaluated against the consent engine before any data is returned.
   */
  async forPurpose(purpose: string): Promise<unknown[]> {
    this.purpose = purpose;
    return this.execute();
  }

  private async execute(): Promise<unknown[]> {
    const url = `${this.baseUrl}/data/${this.table}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        [SETU.HEADERS.PURPOSE]: this.purpose ?? '',
      },
      body: JSON.stringify({
        select: this.columns,
        filters: this.filters,
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(
        `Setu API error ${response.status}: ${JSON.stringify(body)}`,
      );
    }

    const body = await response.json() as { data: unknown[] };
    return body.data;
  }
}
