# Skills as a Service

A fully serverless AWS system that runs Claude Code skills on uploaded packages, indexes results into a searchable knowledge store, and automates security code review for hundreds of packages.

## What it does

Upload a zip of Claude skill files → ECS Fargate runs them using AWS Bedrock → results are embedded and indexed in OpenSearch Serverless → query past results with natural language.

Extended for **automated security code review**: point it at a git repo or tarball, get structured findings (severity, CWE ID, file, line) in SARIF format, with GitHub PR status checks and Code Scanning integration.

## Architecture

```
User uploads zip / git URL
        ↓
   S3 uploads bucket
        ↓
   SQS ingestion queue
        ↓
   IngestionLambda → ECS Fargate (runs claude via Bedrock)
        ↓
   ResultsProcessorLambda
        ↓
   ┌─────────────────────────────────┐
   │  OpenSearch Serverless          │  ← semantic search
   │  DynamoDB (job records)         │  ← status tracking
   │  S3 results bucket (encrypted)  │  ← full output
   └─────────────────────────────────┘
        ↓
   SNS notification → user
```

## CLI

```bash
npm install -g @skills-svc/cli

# One-time setup
skills-svc configure --region us-east-1 --account 123456789012
skills-svc assume-role

# Run skills on a zip
skills-svc upload ./my-skills.zip --job-name "q3-analysis"
skills-svc status <job-id>
skills-svc results <job-id>

# Query the knowledge store
skills-svc query "summarize Q3 financial analysis"

# Skill registry
skills-svc skill push my-skill.zip --name my-skill --version 1.0.0
skills-svc run --skill my-skill@1.0.0 input.txt

# Schedule recurring runs
skills-svc schedule create --cron "0 9 ? * MON *" --zip ./weekly.zip

# Security code review
skills-svc review submit "git+https://github.com/org/repo@abc123" \
  --package-name my-service --package-version 2.1.0

skills-svc review batch --manifest packages.json --concurrency 20

skills-svc review wait my-service --version 2.1.0 \
  --timeout 30 --fail-on-severity high && echo "Security gate passed"

skills-svc review findings my-service --severity critical
skills-svc review report my-service --format sarif > report.sarif
skills-svc review diff my-service --from 2.0.0 --to 2.1.0
```

## Infrastructure (AWS CDK)

12 CDK stacks, all TypeScript:

| Stack | What it creates |
|-------|----------------|
| `NetworkStack` | VPC, private subnets, VPC endpoints (no NAT, no public subnets) |
| `SecurityStack` | 10 KMS keys, all IAM roles, permission boundaries |
| `StorageStack` | S3 buckets (versioned, ObjectLock), DynamoDB (5 GSIs, PITR) |
| `MessagingStack` | SQS + DLQ, SNS topics, EventBridge Scheduler group |
| `LambdaStack` | All Lambda functions with encrypted log groups |
| `ECSStack` | Fargate cluster, ECR repo (immutable tags), task definition |
| `KnowledgeStoreStack` | AOSS collection, index bootstrap, VPC endpoint |
| `SkillRegistryStack` | Skill S3 bucket (ObjectLock COMPLIANCE), skills DynamoDB |
| `BatchStack` | Step Functions Standard workflow for bulk processing |
| `MCPStack` | API Gateway HTTP API + MCP Lambda (IAM auth) |
| `MonitoringStack` | CloudWatch alarms, dashboard, failure-rate metrics |
| `ComplianceStack` | CloudTrail (ObjectLock), SCPs, break-glass role |
| `CodeReviewStack` | Findings DynamoDB, webhook Lambda, GitHubStatusQueue |

### Deploy

```bash
npm install
npm run build

# Bootstrap CDK (first time only)
npx cdk bootstrap aws://ACCOUNT/REGION \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess

# Deploy all stacks
cd infra && npx cdk deploy --all --require-approval never

# Configure CLI
skills-svc configure --region us-east-1 --account ACCOUNT
```

## Security model

- **Envelope encryption** — each job's result encrypted with a unique KMS data key bound to `{jobId, userArn}`. Only the owning user can decrypt.
- **Row-level isolation** — every DynamoDB query and OpenSearch search filters by `userArn`. Multi-tenant by default.
- **No secrets in env vars** — API keys read from SSM `SecureString` at runtime inside ECS.
- **No NAT gateways** — all AWS API calls go through VPC endpoints.
- **SCPs** — org-level guardrails deny KMS key deletion, audit log tampering, and non-approved regions.
- **IAM permission boundaries** — UserRole is capped; cannot create IAM entities.
- **ECR CVE gate** — CI blocks on any HIGH or CRITICAL CVE in the container image.

## Code review extension

Runs Claude security reviews on source code packages:

```json
[
  { "name": "auth-lib",    "version": "3.2.1", "source": "git+https://github.com/org/auth-lib@abc123" },
  { "name": "api-gateway", "version": "1.5.0", "source": "./archives/api-gateway-1.5.0.tar.gz" },
  { "name": "data-layer",  "version": "2.0.0", "source": "git+https://github.com/org/data@def456",
    "subpath": "packages/data-layer" }
]
```

```bash
skills-svc review batch --manifest packages.json
```

Features:
- Structured findings: severity, CWE ID, file, line, recommendation
- SARIF 2.1.0 output with `partialFingerprints` for GitHub Code Scanning deduplication
- GitHub PR status checks and automated Code Scanning uploads
- GitLab webhook support
- Scoped review: only changed files in a PR (full repo for tag pushes)
- Monorepo subpath support with git sparse-checkout
- Private repo authentication via SSM-stored tokens
- Findings suppression with global suppression rules
- Cross-package duplicate detection (`review duplicates`)
- CI exit-code gate: `review wait --fail-on-severity high`

## Testing

```bash
# Unit tests
npm test

# Specific package
npm test --workspace=packages/lambda
npm test --workspace=packages/ecs-runner
npm test --workspace=packages/cli

# CDK assertion tests (100 checks)
npm test --workspace=infra

# Performance tests
npx jest tests/performance/ --testTimeout=60000 --runInBand

# Load test (requires k6)
k6 run --vus 50 --duration 60s scripts/load-test-webhook.js

# Generate test fixtures
npx ts-node tests/fixtures/generate.ts
```

## Monorepo structure

```
.
├── infra/                      # CDK infrastructure (TypeScript)
│   ├── bin/app.ts
│   ├── lib/                    # 13 stack files
│   └── test/                   # 100 CDK assertion tests
├── packages/
│   ├── shared/                 # Types, crypto, retry utilities
│   ├── lambda/                 # All Lambda handlers
│   │   └── src/
│   │       ├── ingestion/
│   │       ├── results-processor/
│   │       ├── query/
│   │       ├── webhook/
│   │       ├── github-status/
│   │       └── mcp/
│   ├── ecs-runner/             # Fargate container code
│   │   └── src/
│   │       ├── chunker.ts      # Large codebase chunking
│   │       ├── ignorer.ts      # .skillsignore support
│   │       ├── git-cloner.ts   # Private repo auth + sparse-checkout
│   │       └── runner.ts
│   ├── knowledge-store/        # OpenSearch indexing + search
│   └── cli/                    # skills-svc CLI (23+ commands)
├── packages/skills/
│   └── code-review/            # Built-in security review skill
├── tests/
│   ├── factories/              # Test data factories
│   ├── fixtures/               # Binary test fixtures
│   └── performance/            # Load and performance tests
└── scripts/
    ├── build-push-ecs.sh
    ├── load-test-webhook.js    # k6 load test
    └── smoke-test.sh
```

## Specs

The system is fully specified across 27 SPEC files before implementation:

- `SPEC-01` — Architecture overview, VPC, SSM parameters
- `SPEC-02` — Lambda handlers, ECS task definition
- `SPEC-03` — Knowledge store, CLI commands
- `SPEC-04/05` — 100 CDK QA assertion tests
- `SPEC-06` — Security hardening (envelope encryption, DLP, SCPs)
- `SPEC-07/08` — CLI features (watch, stream, schedule, batch, audit)
- `SPEC-09` — MCP server (API Gateway + Lambda)
- `SPEC-10` — Skill registry (S3 ObjectLock, SemVer)
- `SPEC-11–14` — Errata and authoritative definitions
- `SPEC-15–24` — 6 rounds of E2E audit fixes (150+ issues found and resolved)
- `SPEC-25` — Code review extension
- `SPEC-26` — Code review gap fixes (20 gaps)
- `SPEC-27` — Complete test suite

## License

MIT — see [LICENSE](LICENSE)
