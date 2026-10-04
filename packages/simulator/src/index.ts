export { SimulatorEngine } from './engine.ts';
export { TruthWorld } from './truth/world.ts';
export { SCENARIO_INFO, SCENARIO_KEYS, DEFAULT_RECORDING, buildScenario } from './truth/scenarios.ts';
export type { ScenarioKey, ScenarioInfo } from './truth/scenarios.ts';
export { FailureInjector } from './failures.ts';
export { renderFrame } from './render/frame.ts';
export { renderOrtho } from './render/ortho.ts';
export { cameraPoseAt } from './sensors/models.ts';
