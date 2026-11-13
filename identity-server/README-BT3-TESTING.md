# BT3 - Bulk Import test instructions

Use a dedicated PostgreSQL test database whose name ends in `_test` (for example, `app04_bt3_test`). Set `DATABASE_URL` in the current shell to that database before running the integration suite. Do not point the tests at the development database or an M2 database.

```powershell
npm ci
npm run db:status
npm test
node --test --experimental-test-coverage .\dist\test\*.test.js
```

The integration tests create test users and the persistence-failure case adds a temporary PostgreSQL `CHECK` constraint. The test removes that constraint in a `finally` block. Run the suite against an isolated test database; do not run database-reset commands against shared environments.

The 150-request performance harness used for VT-112 was a local one-off script and is not part of the committed test suite. Its recorded result is in `BT3-load-test-150.log`.
