import { useState, type FormEvent } from 'react';
import { useSession } from '../state/session';
import { Icon } from '../components/Icons';

export function Login() {
  const login = useSession((s) => s.login);
  const demo = useSession((s) => s.demo);
  const [username, setUsername] = useState('operator');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card reveal" onSubmit={submit} aria-label="Sign in">
        <Icon.Logo />
        <h1>Strata</h1>
        <p>4D reality intelligence · Site KESTREL (synthetic test facility)</p>
        <label htmlFor="u">Username</label>
        <input id="u" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        <label htmlFor="p">Password</label>
        <input id="p" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
        {error && (
          <div className="note warn" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
        <button className="btn primary" style={{ width: '100%', height: 34, marginTop: 18, justifyContent: 'center' }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {demo?.password && (
          <div className="note" style={{ marginTop: 18, fontSize: 11.5 }}>
            Development build — demo accounts <span className="mono">{demo.users.join(' · ')}</span> with password{' '}
            <span className="mono">{demo.password}</span>. Roles differ: identity hand-off requires <b>analyst</b>, failure injection requires <b>admin</b>.
          </div>
        )}
        <div className="dim" style={{ marginTop: 16, fontSize: 11 }}>
          All data in this environment is synthetic. No real persons, sensors or facilities are represented.
        </div>
      </form>
    </div>
  );
}
