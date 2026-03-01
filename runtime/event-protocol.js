export const STEP_EVENT = Object.freeze({
  STARTED: 'step.started',
  PROGRESS: 'step.progress',
  COMPLETED: 'step.completed',
  ERROR: 'step.error'
});

export const RUN_EVENT = Object.freeze({
  STARTED: 'run.started',
  COMPLETED: 'run.completed',
  ERROR: 'run.error'
});

export function createStepEvent({ type, runId, stepId, stepType, payload = {} }) {
  return {
    type,
    runId,
    stepId,
    stepType,
    timestamp: new Date().toISOString(),
    payload
  };
}

export function createRunEvent({ type, runId, payload = {} }) {
  return {
    type,
    runId,
    timestamp: new Date().toISOString(),
    payload
  };
}
