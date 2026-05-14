/**
 * schedule.test.ts
 *
 * Unit tests for `skills-svc schedule` sub-commands as specified in
 * SPEC-07-cli-features.md (Feature 4: Scheduled Jobs).
 *
 * Mocked AWS clients:
 *   - SchedulerClient  (CreateScheduleCommand, UpdateScheduleCommand, DeleteScheduleCommand,
 *                       GetScheduleCommand, ListSchedulesCommand)
 *   - S3Client         (PutObjectCommand, DeleteObjectCommand)
 *   - DynamoDBDocumentClient (GetCommand, PutCommand, DeleteCommand, QueryCommand)
 *   - STSClient        (GetCallerIdentityCommand)
 *   - SSMClient        (GetParameterCommand)
 *   - loadConfig       (returns a minimal CliConfig)
 */

import {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ListSchedulesCommand,
  FlexibleTimeWindowMode,
} from '@aws-sdk/client-scheduler';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';

// ── Mock loadConfig ────────────────────────────────────────────────────────────

jest.mock('../../utils/config', () => ({
  loadConfig: jest.fn().mockResolvedValue({
    region: 'us-east-1',
    envName: 'test',
    uploadsBucket: 'test-uploads-bucket',
    uploadsKmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/test-key',
    dynamodbTableName: 'test-jobs-table',
    accountId: '123456789012',
  }),
}));

// Mock aws-clients so getCredentialProvider resolves immediately
jest.mock('../../utils/aws-clients', () => ({
  getCredentialProvider: jest.fn().mockResolvedValue(undefined),
  makeDDBClient: jest.fn().mockReturnValue(new (require('@aws-sdk/client-dynamodb').DynamoDBClient)({})),
  makeSSMClient: jest.fn().mockReturnValue(new (require('@aws-sdk/client-ssm').SSMClient)({})),
}));

// ── AWS SDK client mocks ───────────────────────────────────────────────────────

const schedulerMock = mockClient(SchedulerClient);
const s3Mock        = mockClient(S3Client);
const stsMock       = mockClient(STSClient);
const ddbMock       = mockClient(DynamoDBDocumentClient);
const ssmMock       = mockClient(SSMClient);

// ── Constants shared across tests ─────────────────────────────────────────────

const CALLER_IDENTITY = {
  Account: '123456789012',
  Arn:     'arn:aws:iam::123456789012:user/alice',
  UserId:  'AIDAEXAMPLE',
};

const GROUP_NAME      = 'skills-svc-test';
const SCHEDULER_ROLE  = 'arn:aws:iam::123456789012:role/skills-svc-scheduler-test';

// ── Helper: register the two SSM params that schedule commands always fetch ────

function mockSsmParams(): void {
  ssmMock
    .on(GetParameterCommand, {
      Name: '/skills-svc/test/scheduler/role-arn',
    })
    .resolves({ Parameter: { Value: SCHEDULER_ROLE } });

  ssmMock
    .on(GetParameterCommand, {
      Name: '/skills-svc/test/scheduler/group-name',
    })
    .resolves({ Parameter: { Value: GROUP_NAME } });
}

// ── Helper: create a fake zip Buffer with proper PK magic bytes ────────────────

function makeFakeZip(): Buffer {
  const buf = Buffer.alloc(22);
  // ZIP local file header magic: PK\x03\x04
  buf[0] = 0x50; buf[1] = 0x4b; buf[2] = 0x03; buf[3] = 0x04;
  return buf;
}

// ── Helper: write a temp zip to a predictable path and return it ───────────────

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

function writeTmpZip(name = 'test-skills.zip'): string {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, makeFakeZip());
  return p;
}

// ── Helpers to invoke schedule sub-commands programmatically ───────────────────
// We import the command builder and parse argv arrays directly so we can test
// the business logic without spawning child processes.

import { scheduleCommand } from '../../commands/schedule';

async function runSchedule(args: string[]): Promise<void> {
  const cmd = scheduleCommand();
  // Commander v10+: parseAsync throws on error, so we propagate it.
  await cmd.parseAsync(['node', 'skills-svc', ...args]);
}

// ── Test suite ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  schedulerMock.reset();
  s3Mock.reset();
  stsMock.reset();
  ddbMock.reset();
  ssmMock.reset();

  // Default happy-path setup
  stsMock.on(GetCallerIdentityCommand).resolves(CALLER_IDENTITY);
  s3Mock.on(PutObjectCommand).resolves({ ETag: '"abc123"' });
  schedulerMock.on(CreateScheduleCommand).resolves({ ScheduleArn: 'arn:aws:scheduler:us-east-1:123:schedule/test' });
  schedulerMock.on(UpdateScheduleCommand).resolves({});
  schedulerMock.on(DeleteScheduleCommand).resolves({});
  mockSsmParams();
});

afterEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// schedule create — valid 6-field EventBridge cron
// ─────────────────────────────────────────────────────────────────────────────

describe('schedule create', () => {
  test('valid 6-field EventBridge cron calls CreateScheduleCommand with cron() expression', async () => {
    const zipPath = writeTmpZip('valid-cron.zip');
    const cron    = '0 6 ? * MON *';   // 6 fields — EventBridge format

    await runSchedule([
      'create', zipPath,
      '--job-name', 'weekly-review',
      '--cron', cron,
    ]);

    expect(schedulerMock).toHaveReceivedCommandWith(CreateScheduleCommand, {
      ScheduleExpression: `cron(${cron})`,
    });
    // Must also carry the schedule group
    expect(schedulerMock).toHaveReceivedCommandWith(CreateScheduleCommand, {
      GroupName: GROUP_NAME,
    });
  });

  test('CreateScheduleCommand includes ScheduleExpressionTimezone', async () => {
    const zipPath = writeTmpZip('tz-test.zip');

    await runSchedule([
      'create', zipPath,
      '--job-name', 'daily-job',
      '--cron', '0 9 * * ? *',
      '--timezone', 'America/New_York',
    ]);

    expect(schedulerMock).toHaveReceivedCommandWith(CreateScheduleCommand, {
      ScheduleExpressionTimezone: 'America/New_York',
    });
  });

  test('creates schedule in DISABLED state when --disabled flag is passed', async () => {
    const zipPath = writeTmpZip('disabled.zip');

    await runSchedule([
      'create', zipPath,
      '--job-name', 'lazy-job',
      '--cron', '0 0 1 * ? *',
      '--disabled',
    ]);

    expect(schedulerMock).toHaveReceivedCommandWith(CreateScheduleCommand, {
      State: 'DISABLED',
    });
  });

  // ── 5-field Unix cron rejection ──────────────────────────────────────────────

  test('5-field Unix cron (0 9 * * MON) throws with helpful message about 6-field syntax', async () => {
    const zipPath = writeTmpZip('unix-cron.zip');

    await expect(
      runSchedule([
        'create', zipPath,
        '--job-name', 'bad-cron',
        '--cron', '0 9 * * MON',   // 5 fields — Unix style; EventBridge needs 6
      ]),
    ).rejects.toThrow(/6.field|EventBridge|six.field|minutes? hours? day.of.month|cron.*format/i);
  });

  // ── day-of-month AND day-of-week both non-'?' ────────────────────────────────

  test('both day-of-month and day-of-week non-"?" throws validation error', async () => {
    const zipPath = writeTmpZip('dom-dow.zip');

    // EventBridge rule: exactly one of DOM or DOW must be '?'
    await expect(
      runSchedule([
        'create', zipPath,
        '--job-name', 'bad-dom-dow',
        '--cron', '0 9 15 * MON *',  // field[2]=15 (DOM), field[4]=MON (DOW) — both non-?
      ]),
    ).rejects.toThrow(/day.of.month|day.of.week|\?|cannot both be specified/i);
  });

  // ── Invalid IANA timezone ────────────────────────────────────────────────────

  test('invalid IANA timezone throws with example valid timezones', async () => {
    const zipPath = writeTmpZip('bad-tz.zip');

    await expect(
      runSchedule([
        'create', zipPath,
        '--job-name', 'bad-tz-job',
        '--cron', '0 9 ? * MON *',
        '--timezone', 'Fake/Nowhere',
      ]),
    ).rejects.toThrow(/America\/New_York|UTC|Europe\/London|valid.*timezone|timezone.*invalid/i);
  });

  // ── Ownership DDB record written on create ──────────────────────────────────

  test('create stores ownership DDB record with PK=SCHEDULE#{name}, SK=METADATA, ownerArn', async () => {
    const zipPath  = writeTmpZip('ownership.zip');
    const jobName  = 'ownership-test';

    // Allow PutCommand so the command succeeds
    ddbMock.on(PutCommand).resolves({});

    await runSchedule([
      'create', zipPath,
      '--job-name', jobName,
      '--cron', '0 6 ? * MON *',
    ]);

    // The DDB PutCommand must have been called with the ownership record
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);

    const ownershipCall = putCalls.find(call => {
      const item = call.args[0].input.Item as Record<string, unknown> | undefined;
      return typeof item?.PK === 'string' && (item.PK as string).startsWith('SCHEDULE#');
    });

    expect(ownershipCall).toBeDefined();

    const item = ownershipCall!.args[0].input.Item as Record<string, unknown>;
    expect(item['SK']).toBe('METADATA');
    expect(item['ownerArn']).toBe(CALLER_IDENTITY.Arn);
  });

  test('PutObjectCommand is called to upload zip to S3 before creating schedule', async () => {
    const zipPath = writeTmpZip('s3-upload.zip');

    await runSchedule([
      'create', zipPath,
      '--job-name', 's3-test',
      '--cron', '0 12 ? * * *',
    ]);

    expect(s3Mock).toHaveReceivedCommand(PutObjectCommand);

    const putCall = s3Mock.commandCalls(PutObjectCommand)[0];
    expect(putCall.args[0].input.Bucket).toBe('test-uploads-bucket');
    expect(putCall.args[0].input.Key).toMatch(/uploads\/scheduled\//);
    expect(putCall.args[0].input.ServerSideEncryption).toBe('aws:kms');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// schedule delete
// ─────────────────────────────────────────────────────────────────────────────

describe('schedule delete', () => {
  const SCHEDULE_NAME = 'weekly-review-abc12345';
  const OWNER_ARN     = CALLER_IDENTITY.Arn;
  const SCHEDULE_S3_KEY = 'uploads/scheduled/abc12345/skills.zip';

  function mockOwnershipRecord(ownerArn: string): void {
    ddbMock.on(GetCommand, {
      Key: { PK: `SCHEDULE#${SCHEDULE_NAME}`, SK: 'METADATA' },
    }).resolves({
      Item: {
        PK:          `SCHEDULE#${SCHEDULE_NAME}`,
        SK:          'METADATA',
        ownerArn,
        scheduleName: SCHEDULE_NAME,
        s3Key:       SCHEDULE_S3_KEY,
      },
    });
  }

  test('delete by owner calls DeleteScheduleCommand and deletes S3 zip and DDB metadata', async () => {
    mockOwnershipRecord(OWNER_ARN);
    s3Mock.on(DeleteObjectCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    await runSchedule(['delete', SCHEDULE_NAME, '--force']);

    // DeleteScheduleCommand must have been sent
    expect(schedulerMock).toHaveReceivedCommandWith(DeleteScheduleCommand, {
      Name: SCHEDULE_NAME,
      GroupName: GROUP_NAME,
    });

    // S3 zip deleted
    expect(s3Mock).toHaveReceivedCommandWith(DeleteObjectCommand, {
      Bucket: 'test-uploads-bucket',
      Key: SCHEDULE_S3_KEY,
    });

    // DDB metadata record deleted
    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    const metaDelete = deleteCalls.find(c => {
      const k = c.args[0].input.Key as Record<string, unknown> | undefined;
      return k?.PK === `SCHEDULE#${SCHEDULE_NAME}` && k?.SK === 'METADATA';
    });
    expect(metaDelete).toBeDefined();
  });

  test('delete by non-owner (ownerArn mismatch) throws Access denied', async () => {
    // The stored owner is a different user
    mockOwnershipRecord('arn:aws:iam::123456789012:user/other-user');

    await expect(
      runSchedule(['delete', SCHEDULE_NAME, '--force']),
    ).rejects.toThrow(/access denied|not the owner|forbidden|unauthorized/i);

    // Must NOT have sent the delete command to EventBridge
    expect(schedulerMock).not.toHaveReceivedCommand(DeleteScheduleCommand);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// schedule enable / disable
// ─────────────────────────────────────────────────────────────────────────────

describe('schedule enable / disable', () => {
  const SCHEDULE_NAME = 'my-schedule-abc12345';

  // Simulate GetScheduleCommand returning an existing schedule
  const EXISTING_SCHEDULE = {
    Name:                       SCHEDULE_NAME,
    GroupName:                  GROUP_NAME,
    ScheduleExpression:         'cron(0 6 ? * MON *)',
    ScheduleExpressionTimezone: 'America/Chicago',
    State:                      'ENABLED',
    FlexibleTimeWindow:         { Mode: FlexibleTimeWindowMode.OFF },
    Target: {
      Arn:     'arn:aws:lambda:us-east-1:123:function:skills-svc-schedule-trigger-123456789012',
      RoleArn: SCHEDULER_ROLE,
      Input:   '{}',
    },
  };

  beforeEach(() => {
    schedulerMock.on(GetScheduleCommand).resolves(EXISTING_SCHEDULE);
  });

  test('enable sends UpdateScheduleCommand with State=ENABLED', async () => {
    schedulerMock.on(UpdateScheduleCommand).resolves({});

    await runSchedule(['enable', SCHEDULE_NAME]);

    expect(schedulerMock).toHaveReceivedCommandWith(UpdateScheduleCommand, {
      Name:  SCHEDULE_NAME,
      State: 'ENABLED',
    });
  });

  test('disable sends UpdateScheduleCommand with State=DISABLED', async () => {
    schedulerMock.on(UpdateScheduleCommand).resolves({});

    await runSchedule(['disable', SCHEDULE_NAME]);

    expect(schedulerMock).toHaveReceivedCommandWith(UpdateScheduleCommand, {
      Name:  SCHEDULE_NAME,
      State: 'DISABLED',
    });
  });

  test('enable/disable includes ScheduleExpressionTimezone (not dropped)', async () => {
    schedulerMock.on(UpdateScheduleCommand).resolves({});

    await runSchedule(['enable', SCHEDULE_NAME]);

    // The timezone from the existing schedule must be preserved in the update
    expect(schedulerMock).toHaveReceivedCommandWith(UpdateScheduleCommand, {
      ScheduleExpressionTimezone: 'America/Chicago',
    });
  });

  test('enable/disable preserves ScheduleExpression from existing schedule', async () => {
    schedulerMock.on(UpdateScheduleCommand).resolves({});

    await runSchedule(['disable', SCHEDULE_NAME]);

    expect(schedulerMock).toHaveReceivedCommandWith(UpdateScheduleCommand, {
      ScheduleExpression: 'cron(0 6 ? * MON *)',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// schedule list — filtered by ownerArn via DDB
// ─────────────────────────────────────────────────────────────────────────────

describe('schedule list', () => {
  const ALL_SCHEDULES = [
    { Name: 'alice-job-aaa11111', State: 'ENABLED',  ScheduleExpression: 'cron(0 6 ? * MON *)' },
    { Name: 'bob-job-bbb22222',   State: 'ENABLED',  ScheduleExpression: 'cron(0 9 ? * FRI *)' },
    { Name: 'alice-job-ccc33333', State: 'DISABLED', ScheduleExpression: 'cron(0 12 ? * * *)' },
  ];

  // DDB ownership records — only alice's schedules belong to the caller
  const DDB_ITEMS = [
    { PK: 'SCHEDULE#alice-job-aaa11111', SK: 'METADATA', ownerArn: CALLER_IDENTITY.Arn },
    { PK: 'SCHEDULE#alice-job-ccc33333', SK: 'METADATA', ownerArn: CALLER_IDENTITY.Arn },
    // bob's schedule intentionally absent — different owner
  ];

  beforeEach(() => {
    schedulerMock.on(ListSchedulesCommand).resolves({ Schedules: ALL_SCHEDULES });

    // GetCommand for each schedule name to check ownership
    for (const item of DDB_ITEMS) {
      ddbMock.on(GetCommand, {
        Key: { PK: item.PK, SK: 'METADATA' },
      }).resolves({ Item: item });
    }

    // bob's schedule returns ownerArn mismatch
    ddbMock.on(GetCommand, {
      Key: { PK: 'SCHEDULE#bob-job-bbb22222', SK: 'METADATA' },
    }).resolves({
      Item: {
        PK: 'SCHEDULE#bob-job-bbb22222',
        SK: 'METADATA',
        ownerArn: 'arn:aws:iam::123456789012:user/bob',
      },
    });
  });

  test('list returns only schedules owned by the calling user (filters by DDB ownerArn)', async () => {
    // Capture console.log output
    const logLines: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.join(' '));
    });

    await runSchedule(['list']);

    spy.mockRestore();

    const output = logLines.join('\n');

    // Alice's schedules must appear
    expect(output).toContain('alice-job-aaa11111');
    expect(output).toContain('alice-job-ccc33333');

    // Bob's schedule must NOT appear
    expect(output).not.toContain('bob-job-bbb22222');
  });

  test('list with --status enabled shows only ENABLED schedules owned by caller', async () => {
    schedulerMock.on(ListSchedulesCommand).resolves({
      Schedules: ALL_SCHEDULES.filter(s => s.State === 'ENABLED'),
    });

    const logLines: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.join(' '));
    });

    await runSchedule(['list', '--status', 'enabled']);

    spy.mockRestore();

    expect(schedulerMock).toHaveReceivedCommandWith(ListSchedulesCommand, {
      State: 'ENABLED',
    });
  });
});
