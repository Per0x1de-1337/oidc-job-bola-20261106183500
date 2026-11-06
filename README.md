# Owned GitHub Actions OIDC job-binding validation

This reversible fixture asks whether the OIDC request bearer issued to one
running job can be replayed against another concurrent job identifier. It
prints only HTTP status codes and selected non-secret JWT claims. It never
prints or persists either request bearer or a complete JWT.

Expected secure behavior:

- own job identifier: HTTP 200;
- random job identifier: rejected;
- other concurrent job identifier: rejected.

Both jobs, environments, repository, artifact, and all marker data are owned by
the tester. No third-party resource is addressed.
