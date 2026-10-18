import { useEffect, useState, type FormEvent } from 'react';
import { useSession } from '../state/session';
import { StrataField } from '../brand/StrataField';
import { get } from '../api/client';
import { Alert } from '../components/arc/alert/alert';
import { Input } from '../components/arc/input/input';
import { PasswordField } from '../components/arc/password-field/password-field';
import { Lockup } from '../brand/Mark';

interface Banner {
  classification: { level: string; caveat: string };
  site: string;
  simulated: boolean;
  notice: string;
}

function useZulu(): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return new Date(now).toISOString().slice(11, 19);
}

export function Login() {
  const login = useSession((s) => s.login);
  const demo = useSession((s) => s.demo);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const zulu = useZulu();

  useEffect(() => {
    void get<Banner>('/api/auth/banner')
      .then(setBanner)
      .catch(() => setBanner(null));
  }, []);
  useEffect(() => {
    if (demo?.password && !username) setUsername('operator');
  }, [demo, username]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const [siteName, siteSub] = (banner?.site ?? 'Strata').split(' — ');

  return (
    <div className="login">
      <div className="login-main">
        <section className="login-hero" aria-hidden="true">
          <StrataField className="hero-strata" width={1400} height={1000} lines={38} seed={7} relief={0.7} animate observations={3} />
          <div className="hero-clock">
            <span>
              <b>{zulu}Z</b> · {new Date().toISOString().slice(0, 10)}
            </span>
            <span>{siteName?.toUpperCase()}</span>
          </div>
          <div className="hero-copy">
            <div className="hero-mark">
              <Lockup size={36} />
            </div>
            <h2>
              What is happening now, <em>and the record under it.</em>
            </h2>
            <p>Sensors, cameras and allied feeds on one picture. Every alert, decision and handover is kept on the record.</p>
          </div>
        </section>
        <section className="login-side">
          <form className="login-card" onSubmit={submit} aria-label="Sign in">
            <div className="login-mobile-mark" aria-hidden="true">
              <Lockup size={30} />
            </div>
            <h1>Sign in</h1>
            <p>
              {siteName}
              {siteSub ? ` · ${siteSub}` : ''}
            </p>
            <div className="login-fields">
              <Input id="u" label="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="none" />
              <PasswordField id="p" label="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
            </div>
            {error && (
              <div style={{ marginTop: 12 }}>
                <Alert tone="danger" title="Sign-in failed">
                  {error.charAt(0).toUpperCase() + error.slice(1)}
                </Alert>
              </div>
            )}
            <button className="btn primary" disabled={busy || !username || !password}>
              {busy ? <span className="spinner" style={{ width: 14, height: 14, borderTopColor: '#ffffff' }} /> : null}
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <div className="consent" role="note">
              <b>Authorised use only</b>
              {banner?.notice ?? 'This system is for authorised use only. Activity is monitored and recorded.'} By signing in you acknowledge this notice.
            </div>
            {demo?.password && (
              <div className="note" style={{ marginTop: 14, fontSize: 'var(--fs-caption)' }}>
                Demonstration build — accounts <span className="mono">{demo.users.join(' · ')}</span>, password <span className="mono">{demo.password}</span>.
              </div>
            )}
            <div className="login-foot">
              <span>{banner?.simulated ? 'Demonstration site — synthetic data' : 'Live installation'}</span>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
