import { useState } from 'react';
import type { Role } from '@strata/domain';
import { get, patch, post } from '../api/client';
import type { UserRecord } from '../api/types';
import { ErrorNote, Loading, useAsync } from '../components/common';
import { useSession } from '../state/session';
import { Alert, Button, Input, PasswordStrength, RadioCards } from '../components/kit';

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
  const create = async () => {
    setErr(null);
    try {
      await post('/api/admin/users', form);
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
            <h4>Users</h4>
            {users.error && <ErrorNote error={users.error} />}
            {!users.data && <Loading />}
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(users.data ?? []).map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.displayName} <span className="mono dim">{u.username}</span>
                    </td>
                    <td>
                      <select className="input" value={u.role} disabled={u.id === me?.id} onChange={(e) => void patch(`/api/admin/users/${u.id}`, { role: e.target.value }).then(users.reload)}>
                        {(['viewer', 'operator', 'analyst', 'administrator'] as Role[]).map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    </td>
                    <td>{u.disabled ? 'disabled' : 'active'}</td>
                    <td>
                      {u.id !== me?.id && (
                        <button className="btn small" onClick={() => void patch(`/api/admin/users/${u.id}`, { disabled: !u.disabled }).then(users.reload)}>
                          {u.disabled ? 'Enable' : 'Disable'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                      <td key={r.role}>{r.permissions.includes(p) ? '●' : <span className="dim">·</span>}</td>
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
            <dl className="kv">
              {Object.entries(config.data?.effective ?? {}).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd className="mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
            <div className="muted" style={{ marginTop: 8, fontSize: 11.5 }}>
              Secrets (service token, session secret, API keys, storage key) are environment-only and never displayed.
            </div>
          </div>
          <div className="section">
            <h4>Integrations</h4>
            <table className="table">
              <tbody>
                {(config.data?.integrations ?? []).map((i) => (
                  <tr key={i.name}>
                    <td>{i.name}</td>
                    <td className="mono dim">{i.adapter}</td>
                    <td className="muted">{i.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="section">
            <h4>Accreditation status</h4>
            <div className="note warn">This build is a development prototype. It holds no government or defence certification or accreditation. See docs/SECURITY.md for what would be required.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
