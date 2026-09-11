import { SetuHttp, type SetuClientConfig } from './http.js';
import type {
  AuditRecord,
  ChainVerification,
  Collection,
  ConsentArtifact,
  ConsentCheck,
  FieldInput,
  ListRecordsQuery,
  Purpose,
  RecordListPage,
  TenantRecord,
} from './types.js';

/**
 * Typed client for the Setu gateway.
 *
 * Every method maps to one public route. Where the gateway requires a bound
 * purpose the signature demands one, so a caller cannot omit it and discover
 * the requirement from a 400 at runtime.
 */
export class SetuClient {
  private readonly http: SetuHttp;

  constructor(config: SetuClientConfig) {
    this.http = new SetuHttp(config);
  }

  // ── Collections (control plane: no purpose) ───────────────

  async listCollections(): Promise<{ collections: Collection[] }> {
    return this.http.request('/v1/collections');
  }

  async getCollection(name: string): Promise<Collection> {
    return this.http.request(`/v1/collections/${encodeURIComponent(name)}`);
  }

  async createCollection(name: string, fields: FieldInput[]): Promise<Collection> {
    return this.http.request('/v1/collections', {
      method: 'POST',
      body: { name, fields },
    });
  }

  async addFields(name: string, fields: FieldInput[]): Promise<Collection> {
    return this.http.request(`/v1/collections/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: { fields },
    });
  }

  // ── Records (data plane: purpose required) ────────────────

  /**
   * Tenant field values sit flat alongside principalId, matching the service's
   * own contract — `principal_id` is platform-owned and rejected.
   */
  async createRecord(
    collection: string,
    purpose: string,
    principalId: string,
    fields: Record<string, unknown>,
  ): Promise<TenantRecord> {
    return this.http.request(`/v1/collections/${encodeURIComponent(collection)}/records`, {
      method: 'POST',
      purpose,
      body: { principalId, ...fields },
    });
  }

  /**
   * Filters are flat query parameters: `{ city: 'Pune' }` or
   * `{ 'created_at.gte': '2026-01-01' }`. A filter on a column this purpose
   * cannot read is refused rather than silently ignored — that refusal is what
   * stops a masked column being walked out through comparisons.
   */
  async listRecords(
    collection: string,
    purpose: string,
    query: ListRecordsQuery = {},
  ): Promise<RecordListPage> {
    return this.http.request(`/v1/collections/${encodeURIComponent(collection)}/records`, {
      purpose,
      query: query as Record<string, string | number | undefined>,
    });
  }

  async getRecord(collection: string, purpose: string, id: string): Promise<TenantRecord> {
    return this.http.request(
      `/v1/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`,
      { purpose },
    );
  }

  async updateRecord(
    collection: string,
    purpose: string,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<TenantRecord> {
    return this.http.request(
      `/v1/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`,
      { method: 'PATCH', purpose, body: fields },
    );
  }

  async deleteRecord(collection: string, purpose: string, id: string): Promise<void> {
    await this.http.request(
      `/v1/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`,
      { method: 'DELETE', purpose },
    );
  }

  // ── Purposes ──────────────────────────────────────────────

  async listPurposes(): Promise<{ purposes: Purpose[] }> {
    return this.http.request('/v1/purposes');
  }

  async createPurpose(name: string, description = '', legalBasis = 'consent'): Promise<Purpose> {
    return this.http.request('/v1/purposes', {
      method: 'POST',
      body: { name, description, legalBasis },
    });
  }

  // ── Consent ───────────────────────────────────────────────

  async listConsents(principalId?: string): Promise<{ consents: ConsentArtifact[] }> {
    return this.http.request('/v1/consents', { query: { principalId } });
  }

  /** A new grant supersedes any active artifact for the same principal+purpose. */
  async grantConsent(
    principalId: string,
    purpose: string,
    fields: string[],
    expiresAt?: string,
  ): Promise<ConsentArtifact> {
    return this.http.request('/v1/consents', {
      method: 'POST',
      body: { principalId, purpose, fields, expiresAt },
    });
  }

  async revokeConsent(id: string): Promise<{ id: string; status: string }> {
    return this.http.request(`/v1/consents/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
    });
  }

  async checkConsent(principalId: string, purpose: string): Promise<ConsentCheck> {
    return this.http.request('/v1/consents/check', {
      query: { principalId, purpose },
    });
  }

  // ── Audit ─────────────────────────────────────────────────

  async listAuditRecords(
    query: {
      principalId?: string;
      purpose?: string;
      action?: 'read' | 'create' | 'update' | 'delete';
      outcome?: 'permitted' | 'denied';
      since?: string;
      until?: string;
      after?: number;
      limit?: number;
    } = {},
  ): Promise<{ records: AuditRecord[]; nextAfter?: number }> {
    return this.http.request('/v1/audit/records', {
      query: query as Record<string, string | number | undefined>,
    });
  }

  async verifyChain(): Promise<ChainVerification> {
    return this.http.request('/v1/audit/verify');
  }
}
