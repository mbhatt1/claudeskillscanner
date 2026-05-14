/**
 * tests/factories/ecs-event.ts
 *
 * Factory functions for EventBridge ECS task state-change event payloads.
 *
 * Per SPEC-23 Fix 1, the `startedBy` field carries the full jobId UUID
 * (replacing the old `skills-svc-${jobId.slice(0,8)}` prefix). Tests that
 * exercise ResultsProcessorLambda must use these factories to produce correct
 * event shapes.
 *
 * Reference event shape:
 *   https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_cwe_events.html
 */

import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EcsContainerDetail {
  containerArn: string;
  lastStatus: string;
  name: string;
  taskArn: string;
  exitCode?: number;
  reason?: string;
}

/**
 * The `detail` object inside an EventBridge ECS task state change event.
 * This is what ResultsProcessorLambda receives as `event.detail`.
 */
export interface EcsTaskDetail {
  taskArn: string;
  clusterArn: string;
  taskDefinitionArn: string;
  lastStatus: string;
  desiredStatus: string;
  startedBy: string;        // SPEC-23 Fix 1: full jobId UUID
  stoppedReason?: string;
  stopCode?: string;
  containers: EcsContainerDetail[];
  tags?: Array<{ key: string; value: string }>;
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
  pullStartedAt?: string;
  pullStoppedAt?: string;
  executionStoppedAt?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLUSTER_ARN = 'arn:aws:ecs:us-east-1:123456789012:cluster/skills-svc-cluster';
const TASK_DEF_ARN = 'arn:aws:ecs:us-east-1:123456789012:task-definition/skills-svc-runner:42';

function makeTaskArn(): string {
  return `arn:aws:ecs:us-east-1:123456789012:task/skills-svc-cluster/${randomUUID()}`;
}

function makeContainerArn(taskArn: string, containerName: string): string {
  return `${taskArn}/container/${containerName}`;
}

// ---------------------------------------------------------------------------
// makeEcsTaskStoppedEvent
//
// A generic ECS STOPPED event. `startedBy` is set to the jobId UUID as
// required by SPEC-23 Fix 1 so that ResultsProcessorLambda can parse it.
// ---------------------------------------------------------------------------

export function makeEcsTaskStoppedEvent(jobId: string, exitCode: number): EcsTaskDetail {
  const taskArn = makeTaskArn();
  const now = new Date().toISOString();
  const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const succeeded = exitCode === 0;

  return {
    taskArn,
    clusterArn: CLUSTER_ARN,
    taskDefinitionArn: TASK_DEF_ARN,
    lastStatus: 'STOPPED',
    desiredStatus: 'STOPPED',
    startedBy: jobId,           // SPEC-23 Fix 1 — full UUID, not a prefix
    stoppedReason: succeeded ? 'Essential container in task exited' : `Exit code ${exitCode}`,
    stopCode: succeeded ? 'EssentialContainerExited' : 'TaskFailedToStart',
    containers: [
      {
        containerArn: makeContainerArn(taskArn, 'runner'),
        lastStatus: 'STOPPED',
        name: 'runner',
        taskArn,
        exitCode,
        reason: succeeded ? undefined : `Container exited with non-zero code ${exitCode}`,
      },
    ],
    tags: [
      { key: 'job-id', value: jobId },
      { key: 'service', value: 'skills-svc' },
    ],
    createdAt: now,
    startedAt,
    stoppedAt: now,
    pullStartedAt: startedAt,
    pullStoppedAt: startedAt,
  };
}

// ---------------------------------------------------------------------------
// makeEcsOomEvent
//
// An ECS STOPPED event caused by an out-of-memory kill (exit code 137,
// stoppedReason contains 'OutOfMemoryError').
// ---------------------------------------------------------------------------

export function makeEcsOomEvent(jobId: string): EcsTaskDetail {
  const taskArn = makeTaskArn();
  const now = new Date().toISOString();
  const startedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();

  return {
    taskArn,
    clusterArn: CLUSTER_ARN,
    taskDefinitionArn: TASK_DEF_ARN,
    lastStatus: 'STOPPED',
    desiredStatus: 'STOPPED',
    startedBy: jobId,
    stoppedReason: 'OutOfMemoryError: Container killed due to memory limit',
    stopCode: 'OutOfMemoryError',
    containers: [
      {
        containerArn: makeContainerArn(taskArn, 'runner'),
        lastStatus: 'STOPPED',
        name: 'runner',
        taskArn,
        exitCode: 137,           // SIGKILL from OOM killer
        reason: 'OOMKilled',
      },
    ],
    tags: [
      { key: 'job-id', value: jobId },
      { key: 'service', value: 'skills-svc' },
    ],
    createdAt: now,
    startedAt,
    stoppedAt: now,
    pullStartedAt: startedAt,
    pullStoppedAt: startedAt,
  };
}

// ---------------------------------------------------------------------------
// makeEcsPreStartFailureEvent
//
// An ECS STOPPED event where the task never started because the container
// image could not be pulled (CannotPullContainerError). The containers array
// is empty and there is no startedAt timestamp.
// ---------------------------------------------------------------------------

export function makeEcsPreStartFailureEvent(jobId: string): EcsTaskDetail {
  const taskArn = makeTaskArn();
  const now = new Date().toISOString();

  return {
    taskArn,
    clusterArn: CLUSTER_ARN,
    taskDefinitionArn: TASK_DEF_ARN,
    lastStatus: 'STOPPED',
    desiredStatus: 'STOPPED',
    startedBy: jobId,
    stoppedReason: 'CannotPullContainerError: inspect image has been retried 1 time(s)',
    stopCode: 'CannotPullContainerError',
    containers: [],             // task never started — no container records
    tags: [
      { key: 'job-id', value: jobId },
      { key: 'service', value: 'skills-svc' },
    ],
    createdAt: now,
    // startedAt intentionally absent — task never reached RUNNING
    stoppedAt: now,
    executionStoppedAt: now,
  };
}
