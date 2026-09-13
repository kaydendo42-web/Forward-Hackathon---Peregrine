'use client';

import type { Workspace } from '../core/types';
import type { FamilyGroup } from '../core/family';
import { entitySummary, groupSummary, lineStatus } from '../core/tree';

type EntityRef = { id: string; name: string; type: string };
type Props = {
  state: Workspace; group: FamilyGroup | undefined; entities: EntityRef[]; entityId: string; selectedId: string; clientView: boolean;
  selectEntity: (id: string) => void; openRequest: (entityId: string, requestId: string) => void;
};

function needs(summary: ReturnType<typeof entitySummary>) {
  if (!summary.hasBaseline) return 'No baseline';
  if (!summary.total) return 'FY25 imported · no FY26 requests yet';
  const parts = [
    summary.awaiting && `${summary.awaiting} awaiting client`,
    summary.review + summary.difference && `${summary.review + summary.difference} for adviser`,
    summary.followUp && `${summary.followUp} follow-up`,
    summary.done && `${summary.done} done`,
  ].filter(Boolean);
  return parts.join(' · ');
}

/** Sidebar tree: family group → entities (what is still missing) → request lines (status, documents). */
export function FamilyTree({ state, group, entities, entityId, selectedId, clientView, selectEntity, openRequest }: Props) {
  const totals = groupSummary(state, entities.map(e => e.id));
  return <nav className="tree" aria-label="Family tree">
    <div className="tree-root">
      <p className="eyebrow">{group?.name ?? 'Family group'}</p>
      {group && !clientView && <p className="tree-liaison">Contact: {group.liaison.name}<br /><small>{group.liaison.role}</small></p>}
      <p className="tree-totals" data-testid="tree-totals">{totals.total ? `${totals.awaiting} awaiting client · ${totals.review + totals.difference} for adviser · ${totals.done} done across ${totals.withBaseline} ${totals.withBaseline === 1 ? 'entity' : 'entities'}` : `${totals.withBaseline} of ${totals.entities} baselines loaded`}</p>
    </div>
    <ul className="tree-entities">
      {entities.map(entity => {
        const summary = entitySummary(state, entity.id);
        const open = entity.id === entityId;
        const missing = summary.awaiting + summary.followUp;
        const lines = open ? state.requests.filter(r => r.entityId === entity.id) : [];
        return <li key={entity.id} className={`tree-entity ${open ? 'open' : ''} ${missing ? 'missing' : ''}`}>
          <button className={`entity-button ${open ? 'active' : ''}`} onClick={() => selectEntity(entity.id)} aria-pressed={open} aria-expanded={open}>
            <strong>{entity.name}</strong><span>{entity.type} · {needs(summary)}</span>
          </button>
          {open && lines.length > 0 && <ul className="tree-lines" aria-label={`${entity.name} request lines`}>
            {lines.map(request => { const status = lineStatus(request); return <li key={request.id}>
              <button className={`tree-line status-${status.key} ${request.id === selectedId ? 'active' : ''}`} onClick={() => openRequest(entity.id, request.id)} aria-current={request.id === selectedId ? 'true' : undefined}>
                <span className="tree-dot" aria-hidden="true" /><span className="tree-label">{request.label}</span>
                <small>{status.label}{request.evidence.length ? ` · ${request.evidence.length} doc${request.evidence.length === 1 ? '' : 's'}` : ''}</small>
              </button></li>; })}
          </ul>}
        </li>;
      })}
    </ul>
  </nav>;
}
