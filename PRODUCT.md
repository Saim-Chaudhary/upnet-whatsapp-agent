# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

UpNet support staff use the dashboard during active customer-support work to
review, triage, and update persistent support tickets.

## Product Purpose

The UpNet support agent follows a deterministic WhatsApp troubleshooting
workflow, persists qualified complaints as PostgreSQL tickets, and gives staff
a same-origin dashboard for queue triage and ticket updates.

## Operating Context

Staff work from a dense ticket queue and open individual tickets to inspect
customer identifiers, complaint details, status, priority, timestamps, and
audit history. Customer messages may contain Urdu or mixed Urdu and English.

## Capabilities and Constraints

- Tickets are created only after the existing deterministic escalation workflow.
- PostgreSQL is the source of truth for tickets, conversations, sessions, and
  audit records.
- The dashboard is served by the existing Fastify application at
  `/dashboard/`.
- Staff routes use database-backed sessions, roles, and CSRF checks.
- The interface must not fabricate tickets, statistics, activity, customer
  details, or operational claims.
- Existing complaint workflow, ticket idempotency, conversation locking,
  authentication, and API behavior must remain intact.

## Brand Commitments

The product name is UpNet. The dashboard brief specifies a light-first,
cool blue-teal operational direction with restrained blue-gray surfaces,
Public Sans typography, real Lucide icons, compact density, and a focused
ticket audit timeline.

## Evidence on Hand

- PostgreSQL-backed ticket and audit records
- Existing dashboard API responses
- Local support knowledge files under `src/knowledge/`
- Existing UpNet support workflow and ticket persistence tests

No real customer testimonials, metrics, marketing content, or production
activity feed is available; the dashboard must not invent any.

## Product Principles

- Operational clarity before decoration.
- Database truth before convenience.
- Preserve customer context without exposing unnecessary secrets.
- Make every rendered action real and recoverable.

## Accessibility & Inclusion

Use semantic controls, visible keyboard focus, responsive layouts from narrow
mobile widths through desktop, and `dir="auto"` for customer-authored text.
Status must never be conveyed by color alone.
