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

function endpointIdsFrom(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/\/idtoken\/([^/]+)\/([^/?]+)$/i);
  if (!match) throw new Error('OIDC URL did not contain the current endpoint identifier pair');
  return { first: match[1], second: match[2] };
}

function urlForIds(ids) {
  const own = endpointIdsFrom(ownRequestUrl);
  const url = new URL(ownRequestUrl);
  url.pathname = url.pathname.replace(
    `/idtoken/${own.first}/${own.second}`,
    `/idtoken/${ids.first}/${ids.second}`,
  );
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

async function oidcProbe(label, ids) {
  const response = await fetch(urlForIds(ids), {
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
  return JSON.parse(fs.readFileSync('downloaded-target/endpoint-identifiers.json', 'utf8'));
}

async function main() {
  const ownIds = endpointIdsFrom(ownRequestUrl);
  const targetIds = await downloadTargetArtifact();
  if (!targetIds.first || !targetIds.second) throw new Error('Target endpoint identifiers were invalid');

  const randomIds = { first: crypto.randomUUID(), second: crypto.randomUUID() };
  const own = await oidcProbe('own-pair-positive-control', ownIds);
  const random = await oidcProbe('random-pair-negative-control', randomIds);
  const targetFirst = await oidcProbe('target-first-own-second', {
    first: targetIds.first,
    second: ownIds.second,
  });
  const targetSecond = await oidcProbe('own-first-target-second', {
    first: ownIds.first,
    second: targetIds.second,
  });
  const cross = await oidcProbe('target-pair-other-concurrent-job-test', targetIds);

  const summary = {
    own_control_succeeded: own.status === 200,
    random_control_rejected: random.status !== 200,
    first_identifier_substitution_accepted: targetFirst.status === 200,
    second_identifier_substitution_accepted: targetSecond.status === 200,
    cross_job_accepted: cross.status === 200,
    cross_job_environment: cross.claims?.environment,
  };
  console.log(`SUMMARY ${JSON.stringify(summary)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
