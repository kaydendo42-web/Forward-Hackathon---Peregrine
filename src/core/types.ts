export type EntityType = 'individual' | 'company' | 'trust';
export type Decision = 'accepted' | 'not_applicable' | 'follow_up';
export type BaselineLine = {
  id: string; category: string; label: string; component: string; amountCents: number | null;
  currency: string; basis: string; sourceRef: string; recurrence: 'annual'; requestText: string;
};
export type Baseline = {
  workbookId: string; entityId: string; entityName: string; entityType: EntityType;
  financialYear: number; baselineVersion: number; synthetic: true; lines: BaselineLine[];
};
export type EvidenceInput = {
  documentId: string; lineId: string; entityId: string; financialYear: number;
  component: string; currency: string; basis: string; amountCents: number | null;
  description: string; filename: string; fileHash: string;
};
export type CollectionRequest = {
  id: string; entityId: string; financialYear: number; lineId: string; category: string;
  label: string; question: string; reason: string; component: string; currency: string; basis: string;
  priorAmountCents: number | null; comparisonCents: number | null; evidence: EvidenceInput[];
  answer: string; review: 'pending' | Decision; reviewNote: string; paused: boolean;
  origin: 'baseline' | 'discovery' | 'planning'; methodVersion: string;
};
export type SendReceipt = { to: string; messageId: string; sentAt: string };
export type Draft = {
  id: string; entityId: string; kind: 'initial' | 'reminder'; status: 'draft' | 'superseded' | 'sent';
  requestIds: string[]; subject: string; body: string; fingerprint: string;
  to?: string; messageId?: string; sentAt?: string;
};
export type AuditEvent = { id: string; at: string; action: string; entityId: string; detail: string };
export type ReviewChange = { requestId: string; decision: Decision; note: string };
export type Workspace = {
  schemaVersion: 1; version: number; baselines: Baseline[]; requests: CollectionRequest[];
  outbox: Draft[]; audit: AuditEvent[];
};
