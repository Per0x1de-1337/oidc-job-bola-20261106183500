const fs = require('node:fs');

const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL || '';
const match = requestUrl.match(/\/jobs\/([^/?]+)\/idtoken(?:[/?]|$)/i);

if (!match) {
  const parsed = new URL(requestUrl);
  console.log(JSON.stringify({
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    query_keys: [...parsed.searchParams.keys()].sort(),
  }));
  throw new Error('The current opaque OIDC endpoint exposes no substitutable job identifier');
}

fs.mkdirSync('oidc-target', { recursive: true });
fs.writeFileSync('oidc-target/job-id.txt', `${match[1]}\n`, { mode: 0o600 });
console.log('Exported only the non-secret target job identifier.');
