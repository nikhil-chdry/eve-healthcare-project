# EVE Healthcare API

A backend service for diagnostic-test bookings and simulated payments. It uses Express, PostgreSQL through Prisma, JWT authentication, and a transaction-backed payment webhook.

## Run locally

Prerequisites: Node.js 20+ and Docker Desktop (for PostgreSQL).

```powershell
Copy-Item .env.example .env
npm install
docker compose up -d db
npx prisma migrate dev --name init
npx prisma generate
npm run db:seed
npm run dev
```

The API starts on `http://localhost:3000`. Run the focused webhook tests with `npm test`.

## Endpoints

| Method | Endpoint | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/signup` | No | Create account and receive JWT |
| POST | `/auth/login` | No | Receive JWT |
| GET | `/centres` | No | List centres and available tests |
| GET | `/centres/:id` | No | Get one centre and tests |
| GET | `/centres/:id/tests` | No | List tests at a centre |
| POST | `/bookings` | Yes | Create a pending booking |
| GET | `/bookings` | Yes | List caller's bookings |
| GET | `/bookings/:id` | Yes | Get a caller-owned booking |
| PATCH | `/bookings/:id/cancel` | Yes | Cancel a pending booking |
| POST | `/payments` | Yes | Simulate payment for a pending booking |
| POST | `/payments/webhook` | No | Accept an idempotent provider update |

Create a user:

```bash
curl -X POST http://localhost:3000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"sam@example.com","password":"password123","name":"Sam"}'
```

Create a booking (replace `TOKEN` with the returned JWT):

```bash
curl -X POST http://localhost:3000/bookings \
  -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \
  -d '{"centreId":"eve-central","testId":"cbc","appointmentAt":"2030-01-02T10:00:00+05:30"}'
```

Example provider webhook. Repeating this exact request returns `200` without another state transition:

```bash
curl -X POST http://localhost:3000/payments/webhook \
  -H "Content-Type: application/json" \
  -d '{"eventId":"provider-event-001","providerPaymentId":"provider-payment-id","status":"SUCCESS"}'
```

## Data model

```text
User 1 --- * Booking * --- 1 Centre
                  |
                  * --- 1 Test (which belongs to one Centre)
                  |
                  1 --- 0..1 Payment

WebhookEvent(eventId UNIQUE) records processed provider events.
Payment(bookingId UNIQUE, providerPaymentId UNIQUE) prevents duplicate payments.
```

## Important assumptions

- A test belongs to exactly one diagnostic centre.
- A booking snapshots the test price when it is created, so later price changes do not alter existing bookings.
- A booking starts `PENDING`; payment changes it to `CONFIRMED` or `FAILED`. A user may cancel only a `PENDING` booking.
- One simulated payment is allowed per booking. The database's unique `bookingId` constraint is the race-safe protection.
- Webhook idempotency uses the provider's `eventId`, protected by a unique database constraint and processed in the same transaction as payment and booking updates.
- The mock payment endpoint creates an internal provider event and routes it through the same webhook processor used by external webhooks.

## Error behaviour

- `401`: missing, invalid, or expired token
- `403`: another user's booking
- `404`: missing centre, test, booking, or payment
- `409`: duplicate email, payment attempt for a non-pending booking, second payment, or invalid cancellation state
- `422`: invalid JSON body or an appointment that is not in the future

## With more time

- Add integration tests against an ephemeral PostgreSQL database.
- Add webhook signature verification, retry/backoff and an outbox queue.
- Implement refunds for confirmed bookings, pagination, rate limiting, structured logging, and OpenAPI documentation.
