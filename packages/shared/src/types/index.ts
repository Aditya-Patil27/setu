/**
 * Setu Platform — Core Domain Types
 *
 * These types are shared across all services. Changes here require
 * full-team agreement (see: Contract Freeze, Gate 2).
 */

// ── Tenant & Project ──────────────────────────────────────

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  schemaName: string; // Postgres schema for this project
  createdAt: Date;
  updatedAt: Date;
}

// ── Identity & Auth ───────────────────────────────────────

export interface Principal {
  id: string;
  projectId: string;
  phone?: string;
  email?: string;
  displayName?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface JwtPayload {
  sub: string; // principal ID
  tenantId: string;
  projectId: string;
  roles: string[];
  iat: number;
  exp: number;
}

export interface ApiKey {
  id: string;
  projectId: string;
  keyHash: string;
  name: string;
  scopes: string[];
  expiresAt?: Date;
  createdAt: Date;
}

// ── Consent ───────────────────────────────────────────────

export type ConsentStatus = 'active' | 'expired' | 'revoked';

export interface Purpose {
  id: string;
  projectId: string;
  name: string; // e.g., 'appointment_reminder'
  description: string;
  legalBasis: string;
  createdAt: Date;
}

export interface ConsentArtifact {
  id: string;
  principalId: string;
  purposeId: string;
  fields: string[]; // granted fields
  grantedAt: Date;
  expiresAt?: Date;
  revokedAt?: Date;
  status: ConsentStatus;
}

// ── Audit & Lineage ──────────────────────────────────────

export type AuditEdgeType = 'accessed' | 'derived-from' | 'transmitted-to' | 'delegated-to';

export interface AuditEdge {
  id: string;
  projectId: string;
  sourceNode: string;
  targetNode: string;
  edgeType: AuditEdgeType;
  principalId: string;
  purposeId: string;
  fields: string[];
  outcome: 'permitted' | 'denied';
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditRecord {
  id: string;
  projectId: string;
  principalId: string;
  purposeId: string;
  action: string;
  resource: string;
  fields: string[];
  outcome: 'permitted' | 'denied';
  prevHash: string;
  hash: string;
  createdAt: Date;
}

// ── Functions & Workflows ─────────────────────────────────

export type FunctionStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface FunctionDefinition {
  id: string;
  projectId: string;
  name: string;
  runtime: 'js';
  entrypoint: string;
  timeout: number; // seconds
  memoryMb: number;
  createdAt: Date;
}

export interface FunctionExecution {
  id: string;
  functionId: string;
  status: FunctionStatus;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

export type WorkflowStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface WorkflowDefinition {
  id: string;
  projectId: string;
  name: string;
  dag: WorkflowStep[];
  schedule?: string; // cron expression
  createdAt: Date;
}

export interface WorkflowStep {
  id: string;
  functionId: string;
  dependsOn: string[]; // step IDs
  purpose?: string; // inherits from parent if not set
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  status: FunctionStatus;
  steps: Record<string, WorkflowStepStatus>;
  startedAt: Date;
  completedAt?: Date;
}

// ── Storage ───────────────────────────────────────────────

export interface StorageObject {
  id: string;
  projectId: string;
  bucket: string;
  key: string;
  contentType: string;
  sizeBytes: number;
  purposeTags: string[];
  encryptedAtRest: boolean;
  createdAt: Date;
}

// ── Metering ──────────────────────────────────────────────

export interface UsageRecord {
  id: string;
  tenantId: string;
  projectId: string;
  service: string;
  metric: string;
  value: number;
  recordedAt: Date;
}

// ── Request Context ───────────────────────────────────────

export interface RequestContext {
  requestId: string;
  tenantId: string;
  projectId: string;
  principalId?: string;
  purpose?: string;
  roles: string[];
  timestamp: Date;
}
