export type EntityType = 'individual' | 'company' | 'trust';
export type Decision = 'accepted' | 'not_applicable' | 'follow_up';
export type BaselineLine = {
  id: string; category: string; label: string; component: string; amountCents: number | null;
  currency: string; basis: string; sourceRef: string; recurrence: 'annual'; requestText: string;
  // Set only once an adviser accepts a guidance proposal for this line; absent means demo-method-1.
  methodVersion?: string;
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
  // Set on a combined family-group email; entityId then holds the group id.
  groupId?: string;
};
export type AuditEvent = { id: string; at: string; action: string; entityId: string; detail: string };
export type ReviewChange = { requestId: string; decision: Decision; note: string };
export type InboxMessage = {
  messageId: string; inReplyTo: string | null; references: string[]; from: string;
  date: string; subject: string; text: string; textTruncated: boolean;
  attachments: { filename: string; size: number; contentType: string }[];
};
export type InboxReceipt = { messageId: string; requestId: string; acceptedAt: string; answer: string };
export type IntakeFlags = {
  nameMatch: 'match' | 'partial' | 'mismatch';   // entityNameSeen vs the proposed entity's name
  periodInYear: boolean;                         // both dates inside the request's financial year, or dates unreadable
  syntheticMarker: boolean;                      // a synthetic/fictional marker was seen on the page
  targetValid: boolean;                          // proposed request exists, belongs to proposed entity, review still pending
};
/** One document the model saw in one attachment. `flags` is filled by code, never by the model. */
export type IntakeDocument = {
  docType: string; entityNameSeen: string; periodStart: string; periodEnd: string;
  amounts: { label: string; amountCents: number | null }[];
  proposedEntityId: string; proposedRequestId: string;
  confidence: 'high' | 'medium' | 'low'; reason: string;
  flags: IntakeFlags;
};
/** A read attachment awaiting adviser review. Bytes live in IndexedDB under `fileHash`. */
export type IntakeProposal = {
  id: string; messageId: string; attachmentIndex: number; filename: string; contentType: string;
  size: number; fileHash: string; model: string; promptVersion: string; createdAt: string;
  source: 'image' | 'pdf_text';
  documents: IntakeDocument[];
  review: { status: 'pending' | 'accepted' | 'rejected'; decidedAt: string; note: string };
};
export type SourceStatus = 'final_guidance' | 'draft' | 'announcement' | 'synthetic_fixture';
/**
 * A proposed change to one baseline line's request wording, traced to the passage it
 * came from. Only `proposedText`, `sourceId`, `quote`, `appliesToEntityTypes`,
 * `appliesToYears` and `rationale` come from the model; the rest is filled in by code.
 */
export type GuidanceProposal = {
  lineId: string; currentText: string; proposedText: string; sourceId: string; quote: string;
  appliesToEntityTypes: EntityType[]; appliesToYears: number[]; sourceStatus: SourceStatus;
  rationale: string; retrievedAt: string; sourceHash: string; model: string; promptVersion: string;
  createdAt: string; review: { status: 'pending' | 'accepted' | 'rejected'; reviewer: string; decidedAt: string };
};
export type Workspace = {
  schemaVersion: 1; version: number; baselines: Baseline[]; requests: CollectionRequest[];
  outbox: Draft[]; audit: AuditEvent[]; inbox: InboxMessage[]; inboxReceipts: InboxReceipt[];
  // Absent in workspaces saved before attachment intake existed.
  intake?: IntakeProposal[];
  // Absent in workspaces saved before the guidance track existed.
  guidance?: GuidanceProposal[];
};
