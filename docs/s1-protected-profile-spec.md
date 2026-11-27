# S1 Protected Profile

Baseline `b8f400d25e65168383142bc31a585cde9299822e`, Issue #26. Provider contract is read from PR #27 at `eec5fffa044c840703fa452f4c890477e81816a9`.

`GET /api/protected/profile` accepts one opaque Bearer Access Token in the Authorization header. Resolve it using the current Provider's `AccessToken.find()`. Require unexpired Bearer token, client `app04-react-demo`, exact audience `${issuer}/api`, existing unexpired Grant bound to the same client/account, and existing account. A missing, malformed, expired, revoked, wrong-client/audience token, ID Token, missing Grant or missing account returns 401. A valid token lacking the exact `api:read` scope returns 403. The Grant must still authorize that scope. Lookup failures return a generic 500.

Success returns only `{ "sub": "<account UUID>" }`. Email is omitted because `api:read` does not grant the OIDC email scope. Responses use `Cache-Control: no-store`. Errors contain only fixed OAuth error codes and a fixed Bearer challenge. Cross-origin access permits only the configured React origin and the Authorization header, without credentials.

Tests use real Provider model storage and isolated PostgreSQL account fixtures. HTTP issuance and revocation against PR #27 require a separate temporary integration snapshot. Baseline main does not issue the M3 API resource token. Model tests alone do not prove PR #27 HTTP revocation behavior. Logout alone is not revocation. No shared database, schema, Provider configuration, MFA, React or audit change belongs to S1.

Sequence is spec, failing tests, implementation, isolated verification, then review. Diagnostic output excludes raw tokens, authorization codes, verifiers, credentials and fixture identities.
