# Performance Tests — Code Review Extension

This directory contains performance regression tests for the
500-package batch code review scenario described in SPEC-25 and SPEC-24.

---

## Running the Tests

### Unit-level performance tests (Jest)

```bash
# From the monorepo root:
npx jest tests/performance/ --testTimeout=60000 --runInBand --verbose
```

`--runInBand` runs tests serially so heap measurements in the 500-package
test are not contaminated by sibling workers allocating memory concurrently.

`--testTimeout=60000` gives the 500-package heap test up to 60 s.

To expose the V8 GC (for accurate heap measurements) add `--expose-gc`:

```bash
NODE_OPTIONS=--expose-gc npx jest tests/performance/ --testTimeout=60000 --runInBand
```

### Expected baseline timings (CI reference)

These baselines were established on a 2-vCPU / 4 GB runner
(GitHub Actions `ubuntu-latest`, Node 20).  Fail the build if any test
consistently exceeds 2× the baseline.

| Test | Baseline | Hard limit |
|------|----------|------------|
| 50 packages submitted | ~1.5 s | 30 s |
| concurrency=10 peak uploads | ≤ 10 | 10 (exact) |
| 500 packages heap | ~60 MB delta | 512 MB total heap |
| Step Functions input (50 pkgs) | ~18 KB | 256 KB |
| 50 concurrent DDB writes | ~600 ms | 30 s |
| collectSourceFiles (10 000 files) | ~1.5 s | 5 s |
| chunkFiles (100 × 800 tokens) | < 10 ms | — |
| renderChunk (50 files × 1k tokens) | ~5 ms | 1 s |

Baselines are approximate.  The tests assert on the hard limits only.

---

## Full 500-Package E2E Scenario Against a Real AWS Account

Pre-requisites:

- `skills-svc configure` has been run for your target environment.
- The `code-review` skill has been registered:
  `bash scripts/register-code-review-skill.sh`
- You have a manifest file `500-packages.json` with real package sources.

### Step 1 — Generate a sample manifest

```bash
# Generate a 500-entry manifest of public GitHub repos (example)
python3 - <<'EOF'
import json, random, string

packages = [
    {
        "name": f"pkg-{i:04d}",
        "version": f"1.{i // 100}.{i % 100}",
        "source": f"git+https://github.com/example/repo-{i}@{'a' * 40}",
        "language": random.choice(["typescript", "python", "go"])
    }
    for i in range(1, 501)
]
print(json.dumps(packages, indent=2))
EOF > 500-packages.json
```

### Step 2 — Submit the batch

```bash
time skills-svc review batch \
  --manifest 500-packages.json \
  --concurrency 10

# Expected output:
# Batch review: 500 package(s) from 500-packages.json
# ..................................................
# Batch complete: 500 submitted, 0 failed
# real  ~45s   (≈ 500 jobs × 50ms S3 upload / 10 concurrent)
```

### Step 3 — Poll for completion

```bash
# Poll until all 500 jobs reach COMPLETE or FAILED:
watch -n 30 "skills-svc review status pkg-0001 --version 1.0.0"

# Or poll programmatically:
for i in $(seq -w 1 500); do
  skills-svc review status "pkg-$(printf '%04d' $i)" --version "1.0.0" \
    | grep -E '(COMPLETE|FAILED)'
done | sort | uniq -c
```

### Step 4 — Collect findings

```bash
# Aggregate findings across all packages:
for i in $(seq -w 1 500); do
  skills-svc review findings "pkg-$(printf '%04d' $i)" --output json
done | jq -s 'add' > all-findings.json

wc -l all-findings.json   # rough finding count
jq 'group_by(.severity) | map({severity: .[0].severity, count: length})' all-findings.json
```

### Step 5 — Generate SARIF report for a single package

```bash
skills-svc review report pkg-0001 \
  --format sarif \
  --version 1.0.0 \
  --output-file pkg-0001.sarif.json

# Upload to GitHub Code Scanning:
gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  /repos/OWNER/REPO/code-scanning/sarifs \
  --field commit_sha=<sha> \
  --field ref=refs/heads/main \
  --field sarif=@pkg-0001.sarif.json
```

---

## k6 Load Test — Webhook Endpoint

The k6 script at `scripts/load-test-webhook.js` simulates 50 concurrent
GitHub webhook deliveries per second against the deployed webhook endpoint.

### Install k6

```bash
# macOS
brew install k6

# Linux
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

### Run the load test

```bash
export WEBHOOK_URL="$(aws ssm get-parameter \
  --name /skills-svc/prod/webhook/api-url \
  --query Parameter.Value --output text)/webhook/github"

export GITHUB_SECRET="$(aws ssm get-parameter \
  --name /skills-svc/prod/webhook/github-secret \
  --with-decryption --query Parameter.Value --output text)"

k6 run \
  --vus 50 \
  --duration 60s \
  --env WEBHOOK_URL="$WEBHOOK_URL" \
  --env GITHUB_SECRET="$GITHUB_SECRET" \
  scripts/load-test-webhook.js
```

### Expected results (production baseline)

```
✓ status is 202 or 200
✓ response time p95 < 2000ms
✓ error rate < 1%

checks.........................: 99.8%  ✓ 2994   ✗ 6
data_received..................: 1.2 MB 20 kB/s
data_sent......................: 4.8 MB 80 kB/s
http_req_duration..............: avg=350ms   p(95)=890ms   max=1800ms
http_reqs......................: 3000   50/s
vus............................: 50     min=50  max=50
```

If p95 exceeds 2 000 ms, check:
1. Lambda cold starts — consider provisioned concurrency for the webhook Lambda.
2. SSM parameter cache — the in-memory `paramCache` has a 5-minute TTL; cold starts
   always fetch from SSM which adds ~50–150 ms.
3. S3 PutObject latency — large batches of concurrent webhook deliveries compete for
   the same S3 prefix; consider adding a random UUID sub-prefix.
