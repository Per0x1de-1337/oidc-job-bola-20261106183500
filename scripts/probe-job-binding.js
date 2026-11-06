const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const apiToken = process.env.GITHUB_TOKEN;
const oidcBearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
const ownRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;

for (const [name, value] of Object.entries({ apiToken, oidcBearer, ownRequestUrl, repository, runId })) {
  if (!value) throw new Error(`Missing required environment value: ${name}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jobIdFrom(url) {
  const match = url.match(/\/jobs\/([^/?]+)\/idtoken(?:[/?]|$)/i);
  if (!match) throw new Error('OIDC URL did not contain a job identifier');
  return match[1];
}

function urlForJob(jobId) {
  const ownJobId = jobIdFrom(ownRequestUrl);
  const changed = ownRequestUrl.replace(`/jobs/${ownJobId}/idtoken`, `/jobs/${jobId}/idtoken`);
  const url = new URL(changed);
  url.searchParams.set('audience', 'urn:owned:oidc-job-binding-probe');
  return url.toString();
}

function selectedClaims(jwt) {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('OIDC response was not a JWT');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  return {
    sub: payload.sub,
    environment: payload.environment,
    repository: payload.repository,
    ref: payload.ref,
    job_workflow_ref: payload.job_workflow_ref,
    run_id: payload.run_id,
  };
}

async function oidcProbe(label, jobId) {
  const response = await fetch(urlForJob(jobId), {
    headers: { Authorization: `Bearer ${oidcBearer}` },
    redirect: 'manual',
  });
  const result = { label, status: response.status };
  if (response.status === 200) {
    const body = await response.json();
    result.claims = selectedClaims(body.value);
  }
  console.log(JSON.stringify(result));
  return result;
}

async function downloadTargetArtifact() {
  const listUrl = `https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts?name=oidc-target`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${apiToken}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let artifact;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(listUrl, { headers });
    if (!response.ok) throw new Error(`Artifact list failed with HTTP ${response.status}`);
    const body = await response.json();
    artifact = body.artifacts.find((item) => !item.expired);
    if (artifact) break;
    await sleep(2000);
  }
  if (!artifact) throw new Error('Target artifact was not visible before the timeout');

  const response = await fetch(artifact.archive_download_url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`Artifact download failed with HTTP ${response.status}`);
  fs.writeFileSync('oidc-target.zip', Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  fs.mkdirSync('downloaded-target', { recursive: true });
  execFileSync('unzip', ['-q', '-o', 'oidc-target.zip', '-d', 'downloaded-target']);
  return fs.readFileSync('downloaded-target/job-id.txt', 'utf8').trim();
}

async function main() {
  const ownJobId = jobIdFrom(ownRequestUrl);
  const targetJobId = await downloadTargetArtifact();
  if (!targetJobId || targetJobId === ownJobId) throw new Error('Target job identifier was invalid');

  const own = await oidcProbe('own-job-positive-control', ownJobId);
  const random = await oidcProbe('random-job-negative-control', crypto.randomUUID());
  const cross = await oidcProbe('other-concurrent-job-test', targetJobId);

  const summary = {
    own_control_succeeded: own.status === 200,
    random_control_rejected: random.status !== 200,
    cross_job_accepted: cross.status === 200,
    cross_job_environment: cross.claims?.environment,
  };
  console.log(`SUMMARY ${JSON.stringify(summary)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
