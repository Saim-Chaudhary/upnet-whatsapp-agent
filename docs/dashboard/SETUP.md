# Staff dashboard setup

The dashboard is served same-origin at `/dashboard/` after the frontend bundle
has been built.

## Build and run

1. Set `DATABASE_URL` to the application PostgreSQL connection string.
2. Apply the additive migrations with `npm run db:migrate`.
3. Create the first administrator using environment variables:

```powershell
$env:STAFF_ADMIN_EMAIL = "admin@example.com"
$env:STAFF_ADMIN_PASSWORD = "use-a-long-random-password"
$env:STAFF_ADMIN_NAME = "Support Admin"
npm run staff:create-admin
```

4. Build the dashboard with `npm run dashboard:build`.
5. Start the server with `npm run dev`.

The dashboard does not claim to be secure by itself. Staff routes require the
database-backed session and CSRF checks implemented by the backend. Deployment
must still use HTTPS so session cookies are protected in transit; the cookie is
`Secure` when the application is deployed behind HTTPS.
