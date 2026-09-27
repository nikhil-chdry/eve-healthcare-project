# EVE Healthcare - Diagnostic Booking API

A JavaScript backend service for booking diagnostic tests and processing simulated payments. It was built for the EVE Healthcare SDE Intern backend assignment.

The project focuses on the parts that matter most in a real booking system: safe authentication, correct booking state changes, ownership checks, payment idempotency, and a reproducible local setup.

## What I built

- User signup and login with JWT authentication.
- Read-only diagnostic-centre and test catalogue APIs, populated by a seed script.
- Authenticated test bookings with a future appointment-time check and price snapshot.
- Booking retrieval, listing, and cancellation for the booking owner only.
- A mock payment endpoint that produces either `SUCCESS` or `FAILED`.
- An idempotent payment webhook that cannot apply the same provider event twice.
- PostgreSQL schema, Prisma migration, Docker Compose database setup, seed data, and automated webhook tests.

## Technology choices and why they were used

| Tool | Why it is used |
| --- | --- |
| Node.js + Express | A lightweight JavaScript HTTP server for clean REST APIs. |
| PostgreSQL | A relational database with transactions and unique constraints, essential for bookings and payment events. |
| Prisma | Defines the schema, generates the database client, and manages migrations. |
| Docker Desktop + Docker Compose | Runs the same PostgreSQL version and configuration on any developer machine. |
| JWT (`jsonwebtoken`) | Gives the authenticated user a signed access token after signup or login. |
| bcrypt | Hashes passwords before storage; passwords are never saved as plain text. |
| Zod | Validates request bodies and returns `422` before malformed data reaches business logic. |
| Node test runner | Runs focused automated tests without another test framework. |
| dotenv | Loads local database and JWT settings from `.env`. |

## Project structure

```text
backend/
├── prisma/
│   ├── migrations/          # Versioned PostgreSQL schema changes
│   ├── schema.prisma        # Data models and database constraints
│   └── seed.js              # Demo diagnostic centre and tests
├── src/
│   ├── app.js               # Routes, validation, auth, and business logic
│   ├── server.js            # HTTP server entry point
│   └── webhook-processor.js # Transactional, reusable webhook logic
├── test/
│   └── webhook-processor.test.js
├── docker-compose.yml       # Local PostgreSQL service
└── .env.example             # Safe template for local configuration
```

## How to run it locally

### Prerequisites

- Node.js 20 or newer
- Docker Desktop running

### Setup

From the `backend` directory, run:

```powershell
Copy-Item .env.example .env
npm install
docker compose up -d db
npx prisma generate
npx prisma migrate deploy
npm run db:seed
npm run dev
```

The API starts at `http://localhost:3000`.

To stop the database:

```powershell
docker compose down
```

To run automated tests:

```powershell
npm test
```

## How the implementation works

### Authentication

`POST /auth/signup` validates the input, hashes the password with bcrypt, saves the user, and returns a JWT. `POST /auth/login` verifies the email and password before returning a new JWT.

Protected endpoints expect this header:

```text
Authorization: Bearer <JWT_TOKEN>
```

The `requireAuth` middleware verifies the token and stores the authenticated user on `req.user`.

### Centres and tests

Centres and tests are seeded because the assignment does not require an admin dashboard. A `Test` belongs to exactly one `Centre`, and each test has its own price.

### Bookings

When a user creates a booking, the API checks that:

- the centre exists;
- the test exists;
- the test belongs to the selected centre;
- the appointment is in the future.

The price is copied from the test into `Booking.amount`. This means a later price change does not alter an existing booking.

Every booking route checks `booking.userId === req.user.id`; this prevents a user from accessing, paying for, or cancelling another user's booking.

### Payments and booking states

```text
PENDING -> CONFIRMED  (successful payment)
PENDING -> FAILED     (failed payment)
PENDING -> CANCELLED  (user cancellation)
```

Only a `PENDING` booking can be paid for or cancelled. A unique database constraint on `Payment.bookingId` prevents two simultaneous payment attempts for the same booking.

### Idempotent payment webhook

The mock `POST /payments` endpoint creates a pending payment and simulates a `SUCCESS` or `FAILED` provider result. It then calls the same webhook processor used by `POST /payments/webhook`.

The webhook processor runs inside a PostgreSQL transaction:

1. It attempts to insert the provider `eventId` into `WebhookEvent`.
2. `WebhookEvent.eventId` is unique at the database level.
3. If the insert is a duplicate, the event was already handled, so the endpoint returns `200` with no payment or booking change.
4. Otherwise it updates the payment and related booking together in the same transaction.

This is safer than checking only in application code because the unique database constraint resolves concurrent requests correctly.

## API reference

| Method | Endpoint | Authentication | Description |
| --- | --- | --- | --- |
| POST | `/auth/signup` | No | Create an account and receive a JWT. |
| POST | `/auth/login` | No | Log in and receive a JWT. |
| GET | `/centres` | No | List diagnostic centres and their tests. |
| GET | `/centres/:id` | No | Get one centre and its tests. |
| GET | `/centres/:id/tests` | No | List tests offered by a centre. |
| POST | `/bookings` | Yes | Create a pending booking. |
| GET | `/bookings` | Yes | List only the caller's bookings. |
| GET | `/bookings/:id` | Yes | Get one caller-owned booking. |
| PATCH | `/bookings/:id/cancel` | Yes | Cancel a pending booking. |
| POST | `/payments` | Yes | Simulate payment for a pending, caller-owned booking. |
| POST | `/payments/webhook` | No | Apply a provider status event idempotently. |

### Example requests

Sign up:

```bash
curl -X POST http://localhost:3000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"sam@example.com","password":"password123","name":"Sam"}'
```

Create a booking after replacing `TOKEN` with the returned JWT:

```bash
curl -X POST http://localhost:3000/bookings \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"centreId":"eve-central","testId":"cbc","appointmentAt":"2030-01-02T10:00:00+05:30"}'
```

Simulate a payment:

```bash
curl -X POST http://localhost:3000/payments \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bookingId":"BOOKING_ID"}'
```

## Data model

```text
User 1 --- * Booking * --- 1 Centre
                  |
                  * --- 1 Test (which belongs to one Centre)
                  |
                  1 --- 0..1 Payment

WebhookEvent(eventId UNIQUE) records successfully processed provider events.
Payment(bookingId UNIQUE, providerPaymentId UNIQUE) prevents duplicate payments.
```

## Error handling

| Status | When it is returned |
| --- | --- |
| `401` | JWT is missing, invalid, or expired. |
| `403` | A user attempts to access another user's booking. |
| `404` | A centre, test, booking, or payment does not exist. |
| `409` | Duplicate email, invalid booking state, or duplicate payment attempt. |
| `422` | Request body is invalid or appointment time is not in the future. |

## Verification completed

The implementation was verified locally with Docker PostgreSQL:

- Prisma migration applied successfully.
- Seeded `EVE Central Diagnostics` with CBC and thyroid tests.
- Signup, authenticated booking creation, and simulated payment completed successfully.
- Repeating the same webhook event returned a duplicate no-op response.
- The automated webhook test suite passed: 3 tests, 0 failures.

## Assumptions and future improvements

### Assumptions

- Cancellation is only allowed before payment while a booking is `PENDING`.
- Confirmed-booking refunds are outside the assignment scope.
- The payment provider supplies a stable unique event ID.
- The mock payment outcome is intentionally random to demonstrate both success and failure paths.

### Improvements with more time

- Add full HTTP integration tests using an isolated PostgreSQL test database.
- Verify provider webhook signatures and add retry/backoff handling.
- Add a refund workflow for confirmed bookings.
- Add OpenAPI/Swagger documentation, rate limiting, pagination, structured logging, and monitoring.
