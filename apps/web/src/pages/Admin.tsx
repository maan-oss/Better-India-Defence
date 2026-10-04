import { useState } from 'react';
import type { Role } from '@strata/domain';
import { get, patch, post } from '../api/client';
import type { UserRecord } from '../api/types';
import { ErrorNote, Loading, Modal, useAsync } from '../components/common';
import { useOnWatch } from '../components/ops/OnWatch';
import { Check, Copy, KeyRound, Settings2, UserCheck, UserCog } from 'lucide-react';
import { useSession } from '../state/session';
import { FACILITY } from '@strata/domain';
import { CodeBlock, Alert, Avatar, AvatarGroup, Badge, Button, ConfirmMorph, DropdownMenu, Input, JsonViewer, PasswordStrength, RadioCards, SortableDataTable, useToastStack } from '../components/kit';

interface ConfigResponse {
  stored: { key: string; value: unknown; updated_by: string; updated_at: number }[];
  effective: Record<string, unknown>;
  integrations: { name: string; adapter: string; status: string }[];
}

/** ADMINISTRATION — users, roles, configuration and integration settings. */
export function Admin() {
  const me = useSession((s) => s.user);
  const users = useAsync((s) => get<UserRecord[]>('/api/admin/users', s), []);
  const roles = useAsync((s) => get<{ role: Role; description: string; permissions: string[] }[]>('/api/admin/roles', s), []);
  const config = useAsync((s) => get<ConfigResponse>('/api/admin/config', s), []);
  const [form, setForm] = useState({ username: '', displayName: '', role: 'viewer' as Role, password: '' });
  const [err, setErr] = useState<string | null>(null);
  const [strength, setStrength] = useState(0);
  const allPerms = [...new Set((roles.data ?? []).flatMap((r) => r.permissions))];
  const online = useOnWatch();
  const onlineNames = new Set(online.map((o) => o.username));
  const { toast } = useToastStack();
  const [resetFor, setResetFor] = useState<UserRecord | null>(null);
  const update = async (u: UserRecord, body: { role?: Role; disabled?: boolean; password?: string }, done: string) => {
    try {
      await patch(`/api/admin/users/${u.id}`, body);
      toast({ type: 'success', title: done, description: 'Recorded in the audit log' });
      users.reload();
    } catch (e) {
      toast({ type: 'error', title: 'Not changed', description: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  };
  const create = async () => {
    setErr(null);
    try {
      await post('/api/admin/users', form);
      toast({ type: 'success', title: `${form.displayName} added`, description: `${form.username} · ${form.role}` });
      setForm({ username: '', displayName: '', role: 'viewer', password: '' });
      users.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    }
  };
  return (
    <div className="page">
      <div className="page-h">
        <h1>Administration</h1>
        <span className="sub">Local identity, role-based access control, configuration. All changes are audited.</span>
      </div>
      <div className="page-body split">
        <div className="scroll">
          <div className="section">
            <div className="row admin-users-h">
              <h4 style={{ margin: 0 }}>Users</h4>
              <span className="muted" style={{ fontSize: 12 }}>
                {(users.data ?? []).filter((u) => !u.disabled).length} active · {online.length} signed in now
              </span>
              <span className="spacer" />
              {online.length > 0 && <AvatarGroup size="sm" max={6} label="Signed in now" members={online.map((o) => ({ name: o.displayName, status: 'online' as const }))} />}
            </div>
            {users.error && <ErrorNote error={users.error} />}
            {!users.data && <Loading />}
            <div className="admin-users">
              {(users.data ?? []).map((u) => {
                const isMe = u.id === me?.id;
                const on = onlineNames.has(u.username);
                return (
                  <div key={u.id} className={`admin-user ${u.disabled ? 'off' : ''}`}>
                    <Avatar name={u.displayName} size="md" status={u.disabled ? undefined : on ? 'online' : 'offline'} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="ellipsis" style={{ fontWeight: 500 }}>
                        {u.displayName} {isMe && <span className="muted">(you)</span>}
                      </div>
                      <div className="mono dim" style={{ fontSize: 11.5 }}>
                        {u.username}
                      </div>
                    </div>
                    <Badge tone={u.role === 'administrator' ? 'warning' : u.role === 'viewer' ? 'neutral' : 'info'} size="sm">
                      {u.role}
                    </Badge>
                    {u.disabled && (
                      <Badge tone="danger" size="sm">
                        disabled
                      </Badge>
                    )}
                    {!isMe && (
                      <DropdownMenu
                        label="Manage"
                        icon={<Settings2 size={14} />}
                        items={[
                          ...(['viewer', 'operator', 'analyst', 'administrator'] as Role[]).map((r) => ({
                            label: r === u.role ? `Role: ${r} (current)` : `Make ${r}`,
                            disabled: r === u.role,
                            icon: <UserCog size={14} />,
                            onSelect: () => void update(u, { role: r }, `${u.displayName} is now ${r === 'viewer' ? 'a' : 'an'} ${r}`),
                          })),
                          { label: 'Reset password…', icon: <KeyRound size={14} />, separatorBefore: true, onSelect: () => setResetFor(u) },
                          { label: 'Copy username', icon: <Copy size={14} />, onSelect: () => void navigator.clipboard.writeText(u.username).then(() => toast({ type: 'success', title: 'Username copied', description: u.username })) },
                          ...(u.disabled ? [{ label: 'Enable account', icon: <UserCheck size={14} />, separatorBefore: true, onSelect: () => void update(u, { disabled: false }, `${u.displayName} can sign in again`) }] : []),
                        ]}
                      />
                    )}
                    {!isMe && !u.disabled && (
                      <ConfirmMorph
                        label="Disable"
                        prompt={`Disable ${u.username}? They are signed out at once.`}
                        confirmLabel="Disable"
                        pendingLabel="Disabling"
                        doneLabel="Disabled"
                        tone="danger"
                        onConfirm={() => update(u, { disabled: true }, `${u.displayName} can no longer sign in`)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="section col admin-create" style={{ maxWidth: 620, gap: 14 }}>
            <h4>Create user</h4>
            <div className="admin-two">
              <Input label="Username" placeholder="e.g. jkumar" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '') })} />
              <Input label="Full name and rank" placeholder="e.g. Capt J. Kumar" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            </div>
            <RadioCards
              aria-label="Role"
              layout="grid"
              minColumnWidth={200}
              value={form.role}
              onValueChange={(v) => setForm({ ...form, role: v as Role })}
              options={(roles.data ?? []).map((r) => ({ value: r.role, label: r.role.charAt(0).toUpperCase() + r.role.slice(1), description: r.description, meta: `${r.permissions.length} permissions` }))}
            />
            <PasswordStrength label="Initial password" value={form.password} onValueChange={(v, st) => (setForm({ ...form, password: v }), setStrength(st.level))} />
            {err && (
              <Alert tone="danger" title="Could not create the user">
                {err}
              </Alert>
            )}
            <div className="row">
              <span className="muted" style={{ fontSize: 12 }}>
                At least 12 characters. The user should change it at first sign-in.
              </span>
              <span className="spacer" />
              <Button variant="primary" disabled={form.username.length < 3 || form.displayName.trim().length < 2 || form.password.length < 12 || strength < 2} onClick={() => void create()}>
                Create user
              </Button>
            </div>
          </div>
          <div className="section">
            <h4>Role capabilities</h4>
            <table className="table">
              <thead>
                <tr>
                  <th>Permission</th>
                  {(roles.data ?? []).map((r) => (
                    <th key={r.role}>{r.role}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allPerms.map((p) => (
                  <tr key={p}>
                    <td className="mono">{p}</td>
                    {(roles.data ?? []).map((r) => (
                      <td key={r.role} className="perm-cell">
                        {r.permissions.includes(p) ? <Check size={14} aria-label="granted" /> : <span className="dim" aria-label="not granted">·</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="scroll">
          <div className="section">
            <h4>Effective configuration</h4>
            {config.error && <ErrorNote error={config.error} />}
            {config.data && <JsonViewer data={config.data.effective} rootName="config" defaultExpandDepth={1} maxHeight={420} label="Effective configuration" />}
            <div className="muted" style={{ marginTop: 8, fontSize: 11.5 }}>
              Secrets (service token, session secret, API keys, storage key) are environment-only and never displayed.
            </div>
          </div>
          <div className="section">
            <h4>Integrations</h4>
            <SortableDataTable
              caption="Integrations"
              rowKey="name"
              itemName={{ one: 'integration', other: 'integrations' }}
              emptyMessage="No integrations configured"
              rows={config.data?.integrations ?? []}
              columns={[
                { key: 'name', label: 'Integration', sortable: true },
                { key: 'adapter', label: 'Adapter', sortable: true, render: (v) => <span className="mono dim">{String(v)}</span> },
                { key: 'status', label: 'Status', sortable: true, render: (v) => <span className="muted" style={{ whiteSpace: 'normal', fontSize: 12.5 }}>{String(v)}</span> },
              ]}
            />
          </div>
          <div className="section">
            <h4>Connect equipment</h4>
            <p className="muted" style={{ fontSize: 12.5, margin: '0 0 10px' }}>
              Anything that can send HTTPS can be a sensor: register it in Site configuration, then post <span className="mono">strata.ingest/v1</span> envelopes with the service token. Re-sent message ids are de-duplicated, so retries are safe. Formats and adapters: docs/INTEROP.md.
            </p>
            <CodeBlock filename="health-report.sh" language="bash" code={ingestExample(window.location.origin, FACILITY.sensors[0]?.id ?? 'C01')} />
          </div>
          <div className="section">
            <h4>Accreditation status</h4>
            <div className="note warn">This build is a development prototype. It holds no government or defence certification or accreditation. See docs/SECURITY.md for what would be required.</div>
          </div>
        </div>
      </div>
      {resetFor && <ResetPassword user={resetFor} onClose={() => setResetFor(null)} onSave={(pw) => update(resetFor, { password: pw }, `Password reset for ${resetFor.displayName}`).then(() => setResetFor(null))} />}
    </div>
  );
}

function ingestExample(origin: string, sensorId: string) {
  return `# A health report from ${sensorId}. The token is STRATA_SERVICE_TOKEN from the server environment.
now=$(date +%s%3N)
curl -sS -X POST ${origin}/api/ingest/batch \\
  -H "Authorization: Bearer $STRATA_SERVICE_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{ "messages": [ {
    "schema": "strata.ingest/v1",
    "messageId": "${sensorId.toLowerCase()}-health-'"$now"'",
    "sensorId": "${sensorId}",
    "adapter": "site.health.v1",
    "seq": 1,
    "observedAt": '"$now"',
    "sentAt": '"$now"',
    "kind": "sensor.health",
    "payload": { "status": "ok", "uptimeS": 86400, "message": "self-test passed" }
  } ] }'
# 202 accepted · 207 some rejected (reasons listed) · 401 wrong token`;
}

function ResetPassword({ user, onClose, onSave }: { user: UserRecord; onClose: () => void; onSave: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState('');
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Reset password · ${user.username}`} onClose={onClose}>
      <div className="col" style={{ gap: 14 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Give the new password to {user.displayName} in person or by a separate channel. Their open sessions stay signed in until they expire.
        </p>
        <PasswordStrength label="New password" value={pw} onValueChange={(v, st) => (setPw(v), setLevel(st.level))} />
        <div className="row">
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={pw.length < 12 || level < 2}
            onClick={() => {
              setBusy(true);
              void onSave(pw).catch(() => undefined).finally(() => setBusy(false));
            }}
          >
            Set password
          </Button>
        </div>
      </div>
    </Modal>
  );
}
