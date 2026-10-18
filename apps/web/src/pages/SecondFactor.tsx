import { useEffect, useState, type FormEvent } from 'react';
import { useSession } from '../state/session';
import { post } from '../api/client';
import { Alert } from '../components/arc/alert/alert';
import { Input } from '../components/arc/input/input';
import { Lockup } from '../brand/Mark';

interface Setup {
  secret: string;
  uri: string;
  issuer: string;
}

/**
 * Shown to a privileged account until it has a second factor. The secret is shown once, for typing into an
 * authenticator app; the account is then asked for a code from that app, and the console opens.
 */
export function SecondFactor() {
  const user = useSession((s) => s.user);
  const completeEnrolment = useSession((s) => s.completeEnrolment);
  const logout = useSession((s) => s.logout);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    post<Setup>('/api/auth/mfa/enrol')
      .then(setSetup)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'could not start set-up'));
  }, []);

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/mfa/enrol/confirm', { code });
      await completeEnrolment();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'that code was not accepted');
    } finally {
      setBusy(false);
    }
  };

  // The secret in groups of four, so it can be read and typed without mistakes.
  const grouped = setup ? setup.secret.match(/.{1,4}/g)?.join(' ') : '';

  return (
    <div className="login">
      <div className="login-main">
        <section className="login-side" style={{ gridColumn: '1 / -1' }}>
          <form className="login-card" onSubmit={confirm} aria-label="Set up a second factor">
            <div className="login-mobile-mark" aria-hidden="true">
              <Lockup size={30} />
            </div>
            <h1>Set up two-step sign-in</h1>
            <p>
              {user?.displayName}, the {user?.role} role needs a second factor. In an authenticator app, add a time-based account
              with this key, then enter the six-digit code it shows.
            </p>
            {setup && (
              <div className="note" style={{ marginTop: 12 }}>
                <div>Key</div>
                <div className="mono" style={{ fontSize: 'var(--fs-body)', letterSpacing: '0.04em', userSelect: 'all' }} data-testid="mfa-secret">
                  {grouped}
                </div>
                <div style={{ marginTop: 8, fontSize: 'var(--fs-caption)' }}>Time-based · SHA-1 · 6 digits · 30 seconds</div>
              </div>
            )}
            <div className="login-fields" style={{ marginTop: 14 }}>
              <Input id="mfa-code" label="Six-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" autoFocus />
            </div>
            {error && (
              <div style={{ marginTop: 12 }}>
                <Alert tone="danger" title="Not set up yet">
                  {error.charAt(0).toUpperCase() + error.slice(1)}
                </Alert>
              </div>
            )}
            <button className="btn primary" disabled={busy || code.length !== 6 || !setup}>
              {busy ? 'Checking…' : 'Confirm and continue'}
            </button>
            <div className="login-foot">
              <button type="button" className="btn ghost" onClick={() => void logout()}>
                Sign out
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
