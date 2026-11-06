const fs = require('node:fs');

const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL || '';
const parsed = new URL(requestUrl);
const match = parsed.pathname.match(/\/idtoken\/([^/]+)\/([^/?]+)$/i);

if (!match) {
  console.log(JSON.stringify({
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    query_keys: [...parsed.searchParams.keys()].sort(),
  }));
  throw new Error('The current opaque OIDC endpoint exposes no substitutable job identifier');
}

fs.mkdirSync('oidc-target', { recursive: true });
fs.writeFileSync(
  'oidc-target/endpoint-identifiers.json',
  `${JSON.stringify({ first: match[1], second: match[2] })}\n`,
  { mode: 0o600 },
);
console.log('Exported only the two non-secret target endpoint identifiers.');
