# Staff authentication

After setting `DATABASE_URL`, apply the additive schema with `npm run db:migrate`.
The first administrator is created non-interactively:

```powershell
$env:STAFF_ADMIN_EMAIL = "admin@example.com"
$env:STAFF_ADMIN_PASSWORD = "use-a-long-random-password"
$env:STAFF_ADMIN_NAME = "Support Admin" # optional
npm run staff:create-admin
```

Staff login creates an expiring, `HttpOnly`, `SameSite=Lax` cookie. State-changing
requests to `/api/staff` must send the `csrfToken` returned by login or `/me` as
`X-CSRF-Token`. Agent and admin users can manage tickets; administrative user
creation remains CLI-only during bootstrap.
