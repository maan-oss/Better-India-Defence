import { useEffect, useState, type FormEvent } from 'react';
import { useSession } from '../state/session';
import { Icon } from '../components/Icons';
import { TopoHero } from '../components/TopoHero';
import { get } from '../api/client';
import { Alert } from '../components/kit';
import { DitherGradient } from '../components/vendor/componentry/dither-gradient';

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
      setError(err instanceof Error ? err.message : 'sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const cls = banner?.classification ?? { level: 'RESTRICTED', caveat: '' };
  const clsText = `${cls.level}${cls.caveat ? ` // ${cls.caveat}` : ''}`;
  const [siteName, siteSub] = (banner?.site ?? 'Strata').split(' — ');

  return (
    <div className={`login cls-${cls.level}`}>
      <div className="cls-banner">{clsText}</div>
      <div className="login-main">
        <section className="login-hero" aria-hidden="true">
          <DitherGradient className="hero-dither" colorFrom="#141414" colorMid="#262523" colorTo="#3b3934" intensity={0.22} speed={1.2} angle={155} />
          <TopoHero />
          <div className="hero-clock">
            <span>
              <b>{zulu}Z</b> · {new Date().toISOString().slice(0, 10)}
            </span>
            <span>{siteName?.toUpperCase()}</span>
          </div>
          <div className="hero-copy">
            <div className="hero-mark">
              <Icon.Logo size={34} />
              <b>STRATA</b>
            </div>
            <h2>
              One picture of the installation. <em>What is happening, what happened, and the evidence for both.</em>
            </h2>
            <p>Cameras, trackers, UAS, radar and allied feeds fused into a single operational picture with threat evaluation, recognition and response coordination.</p>
            <div className="hero-pillars">
              <div>
                <b>Sense</b>Live cameras, trackers, UAS and C2 feeds
              </div>
              <div>
                <b>Decide</b>Threat evaluation, alerts and standing procedures
              </div>
              <div>
                <b>Respond</b>Dispatch, duty log, SITREPs and evidence
              </div>
            </div>
          </div>
        </section>
        <section className="login-side">
          <form className="login-card" onSubmit={submit} aria-label="Sign in">
            <h1>Sign in</h1>
            <p>
              {siteName}
              {siteSub ? ` · ${siteSub}` : ''}
            </p>
            <label htmlFor="u">Username</label>
            <input id="u" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} />
            <label htmlFor="p">Password</label>
            <input id="p" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
            {error && (
              <div style={{ marginTop: 12 }}>
                <Alert tone="danger" title="Sign-in failed">
                  {error}
                </Alert>
              </div>
            )}
            <button className="btn primary" disabled={busy || !username || !password}>
              {busy ? <span className="spinner" style={{ width: 14, height: 14, borderTopColor: '#06121e' }} /> : null}
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <div className="consent" role="note">
              <b>Authorised use only</b>
              {banner?.notice ?? 'This system is for authorised use only. Activity is monitored and recorded.'} By signing in you acknowledge this notice.
            </div>
            {demo?.password && (
              <div className="note" style={{ marginTop: 14, fontSize: 11.5 }}>
                Demonstration build — accounts <span className="mono">{demo.users.join(' · ')}</span>, password <span className="mono">{demo.password}</span>.
              </div>
            )}
            <div className="login-foot">
              <span>{banner?.simulated ? 'Demonstration site — synthetic data' : 'Live installation'}</span>
              <span className="mono">{clsText}</span>
            </div>
          </form>
        </section>
      </div>
      <div className="cls-banner">{clsText}</div>
    </div>
  );
}
