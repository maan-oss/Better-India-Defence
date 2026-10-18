/**
 * Client entry for the web app. Same exports as src/index.ts, except the zod-backed schema modules: they are
 * re-exported as types only, so the browser bundle does not include zod. The server imports the full entry.
 */
export * from './math/vec.ts';
export * from './geo/geodesy.ts';
export * from './random.ts';
export * from './provenance.ts';
export * from './rbac.ts';
export * from './facility/types.ts';
export * from './facility/terrain.ts';
export * from './facility/layout.ts';
export * from './geometry/box.ts';
export * from './geometry/polygon.ts';
export * from './geometry/camera.ts';
export * from './geometry/scene.ts';
export type * from './schemas/ingest.ts';
export type * from './schemas/assets.ts';
export * from './assets/model.ts';
export * from './assets/views.ts';
export * from './schemas/model.ts';
export * from './fusion/kalman.ts';
export * from './fusion/engine.ts';
export * from './coverage/patches.ts';
export * from './coverage/model.ts';
export * from './imaging/raster.ts';
export * from './imaging/font.ts';
export * from './imaging/superres.ts';
export * from './imaging/change.ts';
export * from './lidar/scan.ts';
export * from './lidar/change.ts';
export * from './handoff/handoff.ts';
export * from './diff/diff.ts';
export * from './copilot/intent.ts';
export * from './geo/mgrs.ts';
export * from './ops/threat.ts';
export * from './ops/sop.ts';
export type * from './facility/site.ts';
export * from './interop/cot.ts';
