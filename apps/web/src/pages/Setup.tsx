import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { fromMgrs, toMgrs } from '@strata/domain';
import { api, post } from '../api/client';
import { useSession } from '../state/session';
import { Icon } from '../components/Icons';
import { Alert, Button, Input, PasswordStrength, RadioCards, SegmentedControl, Slider, Stepper, TextShimmer } from '../components/kit';
import { OtpInput } from '../components/patterns/OtpInput';
import '../styles/setup.css';

export interface SetupStatus {
  mode: 'operational' | 'demo';
  needsSetup: boolean;
  needsAdmin: boolean;
  needsSite: boolean;
  site: { id: string; name: string; origin: { lat: number; lon: number; alt: number } } | null;
}

type Step = 'code' | 'admin' | 'site' | 'imagery' | 'review';
const LEVELS = ['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET'] as const;
const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
    .replace(/^([^a-z0-9])/, 's$1') || 'site';

/** Web-mercator tile containing a point. */
function tileOf(lat: number, lon: number, z: number) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x, y };
}

/**
 * First-run setup for an operational installation: prove control of the server with the one-time code from
 * its log, create the first administrator, define the site from a real location, choose ground imagery and
 * restart into it. Nothing here creates sample data.
 */
export function Setup({ status }: { status: SetupStatus }) {
  const signedIn = useSession((s) => s.status === 'authenticated');
  const steps: Step[] = status.needsAdmin ? ['code', 'admin', 'site', 'imagery', 'review'] : ['site', 'imagery', 'review'];
  const [step, setStep] = useState<Step>(steps[0]!);
  const idx = steps.indexOf(step);
  const [dir, setDir] = useState(1);
  const go = (s: Step) => {
    setDir(steps.indexOf(s) >= idx ? 1 : -1);
    setStep(s);
  };

  // Code
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Administrator
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [strength, setStrength] = useState(0);
  const [adminErr, setAdminErr] = useState<string | null>(null);
  // Site
  const [siteName, setSiteName] = useState('');
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('RESTRICTED');
  const [loc, setLoc] = useState<{ lat: number; lon: number; alt: number; acc?: number; source: string } | null>(null);
  const [locMode, setLocMode] = useState<'device' | 'coords' | 'mgrs'>('device');
  const [latText, setLatText] = useState('');
  const [lonText, setLonText] = useState('');
  const [mgrsText, setMgrsText] = useState('');
  const [locErr, setLocErr] = useState<string | null>(null);
  const [radius, setRadius] = useState(2000);
  // Imagery
  const [imagery, setImagery] = useState<'none' | 'osm' | 'custom'>('none');
  const [tileUrl, setTileUrl] = useState('');
  const [attribution, setAttribution] = useState('');
  // Finish
  const [finishErr, setFinishErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'saving' | 'restarting'>('idle');

  const verify = async (c = code) => {
    setBusy(true);
    setCodeErr(null);
    try {
      await post('/api/setup/verify', { code: c });
      go('admin');
    } catch (e) {
      setCodeErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createAdmin = async () => {
    setBusy(true);
    setAdminErr(null);
    try {
      await post('/api/setup/admin', { code, username, displayName, password });
      await useSession.getState().login(username, password);
      go('site');
    } catch (e) {
      setAdminErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const useDevice = () => {
    setLocErr(null);
    if (!('geolocation' in navigator)) return setLocErr('This browser cannot report its location. Enter coordinates instead.');
    navigator.geolocation.getCurrentPosition(
      (p) => setLoc({ lat: p.coords.latitude, lon: p.coords.longitude, alt: p.coords.altitude ?? 0, acc: p.coords.accuracy, source: 'this device' }),
      (e) => setLocErr(e.code === e.PERMISSION_DENIED ? 'Location permission was refused. Enter coordinates instead.' : `Could not get a position (${e.message}). Location needs HTTPS or localhost.`),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  useEffect(() => {
    if (locMode === 'coords') {
      const lat = Number(latText);
      const lon = Number(lonText);
      if (latText && lonText && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 80 && Math.abs(lon) <= 180) setLoc({ lat, lon, alt: 0, source: 'entered coordinates' });
      else setLoc(null);
    } else if (locMode === 'mgrs') {
      try {
        const g = mgrsText.trim() ? fromMgrs(mgrsText) : null;
        setLoc(g ? { lat: g.lat, lon: g.lon, alt: 0, source: 'MGRS grid reference' } : null);
      } catch {
        setLoc(null);
      }
    }
  }, [locMode, latText, lonText, mgrsText]);

  const template = imagery === 'osm' ? OSM : imagery === 'custom' ? tileUrl.trim() : '';
  const templateOk = !template || /^https?:\/\/\S*\{z\}\S*\{x\}\S*\{y\}/.test(template);
  const preview = useMemo(() => {
    if (!loc || !template || !templateOk) return null;
    const z = 15;
    const t = tileOf(loc.lat, loc.lon, z);
    const cx = Math.floor(t.x);
    const cy = Math.floor(t.y);
    const tiles = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tiles.push({ key: `${dx},${dy}`, dx, dy, url: template.replace('{z}', String(z)).replace('{x}', String(cx + dx)).replace('{y}', String(cy + dy)).replace('{s}', 'a') });
    return { tiles, fx: t.x - cx, fy: t.y - cy };
  }, [loc, template, templateOk]);

  const finish = async () => {
    if (!loc) return;
    setFinishErr(null);
    setPhase('saving');
    try {
      const id = slug(siteName) === 'site-kestrel' ? 'site-main' : slug(siteName);
      await api('/api/site', {
        method: 'PUT',
        body: JSON.stringify({
          id,
          name: siteName.trim(),
          origin: { lat: loc.lat, lon: loc.lon, alt: Math.round(loc.alt) },
          halfExtentM: radius,
          zones: [],
          buildings: [],
          perimeter: [],
          gates: [],
          feeds: [{ id: 'GPS1', kind: 'gps', name: 'Field team positions' }],
          orthophoto: null,
          basemap: template ? { url: template, attribution: imagery === 'osm' ? '© OpenStreetMap contributors' : attribution.trim(), maxZoom: 19 } : null,
        }),
      });
      await api('/api/admin/config/ui.classification', { method: 'PUT', body: JSON.stringify({ value: { level, caveat: '' } }) });
      setPhase('restarting');
      await post('/api/system/restart', {});
      // Wait for the service to come back with the new site, then reload into it.
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const h = await fetch('/api/health')
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        if (h && h.site === id) {
          location.assign('/operations');
          return;
        }
      }
      throw new Error('The service did not come back within two minutes. Check that it runs under npm start, docker compose or another supervisor.');
    } catch (e) {
      setPhase('idle');
      setFinishErr(e instanceof Error ? e.message : String(e));
    }
  };

  const labels: Record<Step, { label: string; description: string }> = {
    code: { label: 'Verify', description: 'Setup code' },
    admin: { label: 'Administrator', description: 'First account' },
    site: { label: 'Site', description: 'Name and location' },
    imagery: { label: 'Imagery', description: 'Ground map' },
    review: { label: 'Start', description: 'Review' },
  };

  return (
    <div className="setup">
      <div className="cls-banner">{level}</div>
      <main className="setup-main">
        <header className="setup-brand">
          <Icon.Logo size={28} />
          <b>STRATA</b>
          <span className="setup-tag">First-run setup</span>
        </header>
        <div className="setup-card">
          <Stepper steps={steps.map((s) => ({ id: s, ...labels[s] }))} current={idx} details="current" compact label="Setup progress" />
          <AnimatePresence mode="wait" custom={dir} initial={false}>
            <motion.section
              key={step}
              custom={dir}
              className="setup-step"
              initial={{ opacity: 0, x: dir * 24, filter: 'blur(4px)' }}
              animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, x: dir * -24, filter: 'blur(4px)' }}
              transition={{ type: 'spring', visualDuration: 0.32, bounce: 0 }}
            >
              {step === 'code' && (
                <>
                  <h1>Verify you control this server</h1>
                  <p className="setup-lead">
                    The service printed a one-time setup code when it started. Find it in the service log, or in <code>data/setup-code.txt</code> on the server.
                  </p>
                  <OtpInput value={code} onChange={(v) => (setCode(v), setCodeErr(null))} onComplete={(v) => void verify(v)} invalid={Boolean(codeErr)} disabled={busy} />
                  {codeErr && <p className="setup-err">{codeErr}</p>}
                  <div className="setup-actions">
                    <span />
                    <Button variant="primary" loading={busy} disabled={code.length < 8} onClick={() => void verify()}>
                      Continue
                    </Button>
                  </div>
                </>
              )}

              {step === 'admin' && (
                <>
                  <h1>Create the administrator</h1>
                  <p className="setup-lead">This account configures the site, users and sensors. Create named accounts for operators afterwards — never share this one.</p>
                  <div className="setup-fields">
                    <Input label="Full name and rank" placeholder="e.g. Maj R. Sharma" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoFocus />
                    <Input label="Username" placeholder="e.g. rsharma" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))} description="Lower-case letters, digits, dot, dash or underscore." />
                    <PasswordStrength label="Password" value={password} onValueChange={(v, s) => (setPassword(v), setStrength(s.level))} />
                  </div>
                  {adminErr && <p className="setup-err">{adminErr}</p>}
                  <div className="setup-actions">
                    <span />
                    <Button variant="primary" loading={busy} disabled={displayName.trim().length < 2 || username.length < 3 || password.length < 12 || strength < 2} onClick={() => void createAdmin()}>
                      Create administrator
                    </Button>
                  </div>
                </>
              )}

              {step === 'site' && (
                <>
                  <h1>Where is the installation?</h1>
                  <p className="setup-lead">The anchor point is the origin of every grid reference and 3-D position. Stand at the operations centre and use this device, or enter a surveyed point.</p>
                  {!signedIn && <Alert tone="warning" title="Sign in as an administrator to continue" />}
                  <div className="setup-fields">
                    <Input label="Site name" placeholder="e.g. Air Force Station Hindan" value={siteName} onChange={(e) => setSiteName(e.target.value)} autoFocus />
                    <div className="setup-field">
                      <span className="setup-label">Classification banner</span>
                      <SegmentedControl label="Classification" value={level} onValueChange={(v: string) => setLevel(v as (typeof LEVELS)[number])} options={LEVELS.map((l) => ({ value: l, label: l.charAt(0) + l.slice(1).toLowerCase() }))} />
                    </div>
                    <div className="setup-field">
                      <span className="setup-label">Anchor point</span>
                      <SegmentedControl
                        label="Location source"
                        value={locMode}
                        onValueChange={(v: string) => {
                          setLocMode(v as typeof locMode);
                          setLoc(null);
                          setLocErr(null);
                        }}
                        options={[
                          { value: 'device', label: 'This device' },
                          { value: 'coords', label: 'Lat / lon' },
                          { value: 'mgrs', label: 'MGRS' },
                        ]}
                      />
                    </div>
                    {locMode === 'device' && (
                      <Button variant="secondary" onClick={useDevice}>
                        <Icon.Target /> Use this device's location
                      </Button>
                    )}
                    {locMode === 'coords' && (
                      <div className="setup-row">
                        <Input label="Latitude" placeholder="28.6139" inputMode="decimal" value={latText} onChange={(e) => setLatText(e.target.value)} />
                        <Input label="Longitude" placeholder="77.2090" inputMode="decimal" value={lonText} onChange={(e) => setLonText(e.target.value)} />
                      </div>
                    )}
                    {locMode === 'mgrs' && <Input label="Grid reference" placeholder="43R GM 12345 67890" value={mgrsText} onChange={(e) => setMgrsText(e.target.value)} />}
                    {locErr && <p className="setup-err">{locErr}</p>}
                    {loc && (
                      <div className="setup-loc">
                        <Icon.Target />
                        <div>
                          <b className="mono">{toMgrs(loc.lat, loc.lon, 5, true)}</b>
                          <span>
                            {loc.lat.toFixed(5)}, {loc.lon.toFixed(5)} · from {loc.source}
                            {loc.acc ? ` · ±${Math.round(loc.acc)} m` : ''}
                          </span>
                        </div>
                      </div>
                    )}
                    <Slider label="Area covered" min={500} max={10000} step={250} value={radius} onValueChange={(v) => setRadius(v)} format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 2 : 0)} km` : `${v} m`) + ' radius'} />
                  </div>
                  <div className="setup-actions">
                    {status.needsAdmin ? <span /> : <span />}
                    <Button variant="primary" disabled={!signedIn || siteName.trim().length < 3 || !loc} onClick={() => go('imagery')}>
                      Continue
                    </Button>
                  </div>
                </>
              )}

              {step === 'imagery' && (
                <>
                  <h1>Ground imagery</h1>
                  <p className="setup-lead">Shown under the 3-D picture and the site editor. You can also upload a georeferenced orthophoto from your survey cell later in Site setup.</p>
                  <RadioCards
                    value={imagery}
                    onValueChange={(v) => setImagery(v as typeof imagery)}
                    layout="list"
                    options={[
                      { value: 'none', label: 'None for now', description: 'Flat ground with the grid. Nothing leaves this network.' },
                      { value: 'custom', label: 'Our tile server', description: 'An XYZ map service on your own network, e.g. https://maps.unit.local/{z}/{x}/{y}.png' },
                      { value: 'osm', label: 'OpenStreetMap (public internet)', description: 'Each console fetches map tiles from openstreetmap.org — this reveals the site location to that service.' },
                    ]}
                  />
                  {imagery === 'custom' && (
                    <div className="setup-fields">
                      <Input label="Tile URL template" placeholder="https://maps.unit.local/{z}/{x}/{y}.png" value={tileUrl} onChange={(e) => setTileUrl(e.target.value)} error={tileUrl && !templateOk ? 'Must be http(s) and contain {z}, {x} and {y}' : undefined} />
                      <Input label="Attribution" placeholder="© Survey of India" value={attribution} onChange={(e) => setAttribution(e.target.value)} />
                    </div>
                  )}
                  {imagery === 'osm' && <Alert tone="warning" title="Operational security">Use a public map service only for an unclassified, internet-connected deployment. For any other site, run your own tile server.</Alert>}
                  {preview && (
                    <div className="setup-preview" aria-label="Imagery preview around the anchor point">
                      <div className="tiles" style={{ transform: `translate(${(-preview.fx * 100) / 3}%, ${(-preview.fy * 100) / 3}%)` }}>
                        {preview.tiles.map((t) => (
                          <img key={t.key} src={t.url} alt="" crossOrigin="anonymous" style={{ gridColumn: t.dx + 2, gridRow: t.dy + 2 }} />
                        ))}
                      </div>
                      <span className="pin" />
                    </div>
                  )}
                  <div className="setup-actions">
                    <Button variant="ghost" onClick={() => go('site')}>
                      Back
                    </Button>
                    <Button variant="primary" disabled={!templateOk || (imagery === 'custom' && !tileUrl)} onClick={() => go('review')}>
                      Continue
                    </Button>
                  </div>
                </>
              )}

              {step === 'review' && loc && (
                <>
                  <h1>Ready to start</h1>
                  <p className="setup-lead">The service restarts into the new site. There is no sample data: the picture fills as you connect cameras, field devices and data feeds.</p>
                  <dl className="setup-review">
                    <dt>Site</dt>
                    <dd>{siteName}</dd>
                    <dt>Anchor</dt>
                    <dd className="mono">{toMgrs(loc.lat, loc.lon, 5, true)}</dd>
                    <dt>Area</dt>
                    <dd>{radius >= 1000 ? `${radius / 1000} km` : `${radius} m`} radius</dd>
                    <dt>Classification</dt>
                    <dd>{level}</dd>
                    <dt>Imagery</dt>
                    <dd>{imagery === 'none' ? 'None' : imagery === 'osm' ? 'OpenStreetMap' : tileUrl}</dd>
                  </dl>
                  <div className="setup-next">
                    <b>Next, from the console</b>
                    <span>Add cameras (network streams, or this device's camera) · open Field view on a phone to share a team's position · draw zones and the perimeter in Site setup · create operator accounts.</span>
                  </div>
                  {finishErr && <p className="setup-err">{finishErr}</p>}
                  <div className="setup-actions">
                    <Button variant="ghost" disabled={phase !== 'idle'} onClick={() => go('imagery')}>
                      Back
                    </Button>
                    <Button variant="primary" loading={phase !== 'idle'} onClick={() => void finish()}>
                      Create site and start
                    </Button>
                  </div>
                  {phase === 'restarting' && <TextShimmer className="setup-wait">{`Restarting the service into ${siteName}…`}</TextShimmer>}
                </>
              )}
            </motion.section>
          </AnimatePresence>
        </div>
        <footer className="setup-foot">Operational mode · no demonstration data · every step is recorded in the audit log</footer>
      </main>
      <div className="cls-banner">{level}</div>
    </div>
  );
}
