/**
 * tests/factories/job-record.ts
 *
 * Factory functions for DynamoDB JobRecord test data.
 * A JobRecord is the item stored in the jobs table (PK=JOB#{jobId}, SK=METADATA).
 */

import { randomUUID } from 'crypto';
import { JobStatus } from '../../packages/shared/src/types';

// ---------------------------------------------------------------------------
// Type definition (mirrors the DDB item shape from SPEC-02 + SPEC-10 additions)
// ---------------------------------------------------------------------------

export interface JobRecord {
  // DDB keys
  PK: string;            // JOB#{jobId}
  SK: 'METADATA';
  GSI1PK: string;        // STATUS#{status}
  GSI1SK: string;        // CREATED_AT#{iso}
  GSI2PK: string;        // USER#{userArn}
  GSI2SK: string;        // CREATED_AT#{iso}

  // Core fields
  jobId: string;
  jobName: string;
  userArn: string;
  status: JobStatus;
  s3Bucket: string;
  s3Key: string;
  s3ETag: string;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
  version: number;
  ttl: number;

  // ECS fields (set after task is launched)
  ecsTaskArn?: string;
  ecsClusterArn?: string;

  // Result fields (set when complete)
  s3ResultKey?: string;
  resultSummary?: string;

  // Failure fields
  failureReason?: string;

  // Skill registry fields (SPEC-10, optional)
  skillName?: string;
  skillVersion?: string;
  GSI5PK?: string;       // SKILL#{name}#{version}
  GSI5SK?: string;       // CREATED_AT#{iso}
}

// ---------------------------------------------------------------------------
// Base factory
// ---------------------------------------------------------------------------

const BASE_USER_ARN = 'arn:aws:iam::123456789012:user/test-user';
const BASE_CLUSTER_ARN = 'arn:aws:ecs:us-east-1:123456789012:cluster/skills-svc-cluster';
const BASE_TASK_DEF_ARN = 'arn:aws:ecs:us-east-1:123456789012:task-definition/skills-svc-runner:42';

export function makeJobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  const jobId = overrides.jobId ?? randomUUID();
  const createdAt = overrides.createdAt ?? new Date('2026-01-15T10:00:00.000Z').toISOString();
  const updatedAt = overrides.updatedAt ?? createdAt;
  const status = overrides.status ?? JobStatus.PENDING;
  const userArn = overrides.userArn ?? BASE_USER_ARN;
  const s3ETag = overrides.s3ETag ?? `"${randomUUID().replace(/-/g, '')}"`;

  const base: JobRecord = {
    PK: `JOB#${jobId}`,
    SK: 'METADATA',
    GSI1PK: `STATUS#${status}`,
    GSI1SK: `CREATED_AT#${createdAt}`,
    GSI2PK: `USER#${userArn}`,
    GSI2SK: `CREATED_AT#${createdAt}`,

    jobId,
    jobName: 'test-job',
    userArn,
    status,
    s3Bucket: 'skills-svc-uploads-123456789012-us-east-1',
    s3Key: `uploads/${jobId}/skill.zip`,
    s3ETag,
    createdAt,
    updatedAt,
    idempotencyKey: `ETAG#${s3ETag}`,
    version: 0,
    ttl: Math.floor(new Date(createdAt).getTime() / 1000) + 90 * 24 * 60 * 60,
  };

  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Status-specific factories
// ---------------------------------------------------------------------------

export function makePendingJobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return makeJobRecord({ ...overrides, status: JobStatus.QUEUED });
}

export function makeRunningJobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  const jobId = overrides.jobId ?? randomUUID();
  return makeJobRecord({
    jobId,
    ecsTaskArn: `arn:aws:ecs:us-east-1:123456789012:task/skills-svc-cluster/${randomUUID()}`,
    ecsClusterArn: BASE_CLUSTER_ARN,
    ...overrides,
    status: JobStatus.RUNNING,
  });
}

export function makeCompleteJobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  const jobId = overrides.jobId ?? randomUUID();
  const createdAt = overrides.createdAt ?? new Date('2026-01-15T10:00:00.000Z').toISOString();
  const updatedAt = new Date(new Date(createdAt).getTime() + 5 * 60 * 1000).toISOString(); // +5 min
  return makeJobRecord({
    jobId,
    createdAt,
    updatedAt,
    ecsTaskArn: `arn:aws:ecs:us-east-1:123456789012:task/skills-svc-cluster/${randomUUID()}`,
    ecsClusterArn: BASE_CLUSTER_ARN,
    s3ResultKey: `results/${jobId}/result.json`,
    resultSummary: 'Job completed successfully with 3 findings.',
    ...overrides,
    status: JobStatus.COMPLETE,
  });
}

export function makeFailedJobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  const jobId = overrides.jobId ?? randomUUID();
  const createdAt = overrides.createdAt ?? new Date('2026-01-15T10:00:00.000Z').toISOString();
  const updatedAt = new Date(new Date(createdAt).getTime() + 2 * 60 * 1000).toISOString(); // +2 min
  return makeJobRecord({
    jobId,
    createdAt,
    updatedAt,
    ecsTaskArn: `arn:aws:ecs:us-east-1:123456789012:task/skills-svc-cluster/${randomUUID()}`,
    ecsClusterArn: BASE_CLUSTER_ARN,
    failureReason: 'ECS task exited with code 1',
    ...overrides,
    status: JobStatus.FAILED,
  });
}
