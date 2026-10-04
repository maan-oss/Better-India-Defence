/** Brand book: the STRATA identity as it is built in the product (mark, type, colour, motif, illustrations). */
import { Mark, Wordmark, Lockup } from '../brand/Mark';
import { StrataField } from '../brand/StrataField';
import { Illustration, type ArtName } from '../brand/Illustration';
import '../brand/brand.css';

const ART: ArtName[] = ['empty', 'site', 'cameras', 'incidents', 'evidence', 'identity', 'tasks', 'sensors', 'search', 'offline', 'audit', 'reconstructions'];
const SWATCHES = [
  ['Graphite 950', '#171717', 'Chrome: rail, top bar, panels'],
  ['Graphite 900', '#212121', 'Surfaces: pages'],
  ['Graphite 800', '#2a2a2a', 'Raised: cards, inputs'],
  ['Cream', '#f0eee6', 'The one accent: mark, primary action, focus'],
  ['Cream text', '#c9c6bd', 'Secondary text'],
  ['Ash', '#9b988f', 'Labels, captions'],
];

export function Brand() {
  return (
    <div className="page brandbook scroll">
      <header className="bb-hero">
        <StrataField className="bb-hero-art" width={1600} height={620} lines={30} seed={11} animate observations={2} />
        <div className="bb-hero-copy">
          <Lockup size={44} />
          <h1>The installation, layer by layer — and the record under every layer.</h1>
          <p>
            Strata is named for the layers of ground a geologist reads in a cut. The console reads an installation the same way: what is happening now on top, and beneath it the
            recorded evidence for everything that happened. The identity draws only that.
          </p>
        </div>
      </header>

      <section className="bb-sec">
        <h2>The Core mark</h2>
        <p className="bb-lead">A core sample cut through stratified ground. The top stratum is the terrain profile with one observation on its ridge; the strata below relax with depth.</p>
        <div className="bb-marks">
          <figure>
            <Mark size={160} />
            <figcaption>Solid · primary</figcaption>
          </figure>
          <figure>
            <Mark size={160} variant="line" />
            <figcaption>Line · on busy surfaces</figcaption>
          </figure>
          <figure className="bb-cream">
            <Mark size={160} className="bb-on-cream" />
            <figcaption>On cream</figcaption>
          </figure>
          <figure>
            <div className="bb-sizes">
              {[64, 40, 28, 20, 16].map((s) => (
                <Mark key={s} size={s} />
              ))}
            </div>
            <figcaption>Holds to 16 px (strokes thicken below 32 px)</figcaption>
          </figure>
        </div>
        <div className="bb-rules">
          <div>
            <b>Clear space</b>
            <span>One stratum gap (⅛ of the mark) on every side.</span>
          </div>
          <div>
            <b>Never</b>
            <span>Recolour the strata, add effects, rotate, or put the mark on imagery without the tile.</span>
          </div>
          <div>
            <b>Night display</b>
            <span>The mark follows the theme ink, so it turns red-on-black with the console.</span>
          </div>
        </div>
      </section>

      <section className="bb-sec">
        <h2>Wordmark and type</h2>
        <div className="bb-type">
          <div className="bb-wm">
            <Wordmark size={56} />
            <span className="muted">Geist Semibold · tracking 0.32em · always capitals</span>
          </div>
          <div className="bb-specimen">
            <div>
              <span className="bb-k">Interface</span>
              <b className="bb-geist">Geist</b>
              <span className="muted">Every label, heading and body line. Neutral, compact, legible at 12 px on a dark console.</span>
            </div>
            <div>
              <span className="bb-k">Data</span>
              <b className="mono bb-geistmono">43R GM 30415 77880</b>
              <span className="muted">Geist Mono for grid references, IDs, times and hashes — anything read character by character.</span>
            </div>
          </div>
        </div>
      </section>

      <section className="bb-sec">
        <h2>Colour</h2>
        <p className="bb-lead">Graphite and cream only. Colour beyond that belongs to meaning — status, affiliation, provenance — never to the brand.</p>
        <div className="bb-swatches">
          {SWATCHES.map(([n, hex, use]) => (
            <div key={n} className="bb-sw">
              <i style={{ background: hex }} />
              <b>{n}</b>
              <span className="mono">{hex}</span>
              <span className="muted">{use}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="bb-sec">
        <h2>The section</h2>
        <p className="bb-lead">The motif: hairline strata over a terrain profile, a time ruler on the right, observations on the ridge. Generated from a seed, so every console draws the same art.</p>
        <div className="bb-motif">
          <StrataField width={1400} height={520} lines={40} seed={7} relief={0.75} observations={3} />
        </div>
      </section>

      <section className="bb-sec">
        <h2>Illustrations</h2>
        <p className="bb-lead">One block of ground, cut to show its strata, with one object on it. Used for empty states only.</p>
        <div className="bb-art">
          {ART.map((a) => (
            <figure key={a}>
              <Illustration name={a} size={150} />
              <figcaption>{a}</figcaption>
            </figure>
          ))}
        </div>
      </section>
    </div>
  );
}
