import { useWorld } from '../state/world';
import { ErrorBoundary } from './ErrorBoundary';
import { AlertInspector, BuildingInspector, ChangeInspector, EvidenceInspector, ObjectInspector, PointInspector, SensorInspector, TrackInspector } from './inspectors';
import { CoveragePanel, DiffPanel, EvidenceModePanel, IncidentPanel, Overview } from './modePanels';
import { Icon } from './Icons';

/** Right-hand context: the selected thing's evidence, otherwise the current mode's panel or overview. */
export function ContextPanel() {
  const sel = useWorld((s) => s.selection);
  const mode = useWorld((s) => s.mode);
  const incidentId = useWorld((s) => s.incidentId);
  const select = useWorld((s) => s.select);
  let body: React.ReactNode = null;
  if (sel) {
    const key = 'id' in sel ? `${sel.kind}:${sel.id}` : 'point';
    body = (
      <div key={key} className="ctx-body">
        {sel.kind === 'patch' && <EvidenceInspector patchId={sel.id} />}
        {sel.kind === 'track' && <TrackInspector id={sel.id} />}
        {sel.kind === 'sensor' && <SensorInspector id={sel.id} />}
        {sel.kind === 'change' && <ChangeInspector id={sel.id} />}
        {sel.kind === 'alert' && <AlertInspector id={sel.id} />}
        {sel.kind === 'building' && <BuildingInspector id={sel.id} />}
        {sel.kind === 'object' && <ObjectInspector id={sel.id} />}
        {sel.kind === 'incident' && <IncidentPanel id={sel.id} />}
        {sel.kind === 'point' && <PointInspector {...sel.position} />}
      </div>
    );
  } else if (mode === 'INCIDENT' && incidentId)
    body = (
      <div key={`inc:${incidentId}`} className="ctx-body">
        <IncidentPanel id={incidentId} />
      </div>
    );
  else if (mode === 'DIFF')
    body = (
      <div className="ctx-body">
        <DiffPanel />
      </div>
    );
  else if (mode === 'COVERAGE')
    body = (
      <div className="ctx-body">
        <CoveragePanel />
      </div>
    );
  else if (mode === 'EVIDENCE')
    body = (
      <div className="ctx-body">
        <EvidenceModePanel />
      </div>
    );
  else body = <Overview />;
  return (
    <aside className="ops-right" aria-label="Context">
      <div className="panel-h">
        <h3>{sel ? 'Inspector' : mode === 'NOW' || mode === 'HISTORY' ? 'Operational picture' : mode.toLowerCase()}</h3>
        <div className="spacer" />
        {sel && (
          <button className="btn small ghost" onClick={() => select(null)} aria-label="Close inspector">
            <Icon.Close /> Close
          </button>
        )}
      </div>
      <ErrorBoundary area="Inspector">{body}</ErrorBoundary>
    </aside>
  );
}
