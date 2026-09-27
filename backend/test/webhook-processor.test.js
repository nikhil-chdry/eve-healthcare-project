const test = require('node:test');
const assert = require('node:assert/strict');
const { createWebhookProcessor } = require('../src/webhook-processor');

function database({ duplicate = false, payment = { id: 'payment-1', bookingId: 'booking-1', status: 'PENDING' } } = {}) {
  const calls = { paymentUpdates: 0, bookingUpdates: 0 };
  const tx = {
    webhookEvent: { create: async () => { if (duplicate) { const error = new Error('duplicate'); error.code = 'P2002'; throw error; } } },
    payment: {
      findUnique: async () => payment,
      update: async () => { calls.paymentUpdates += 1; },
    },
    booking: { update: async ({ data }) => { calls.bookingUpdates += 1; return { id: 'booking-1', ...data }; } },
  };
  return { calls, $transaction: (work) => work(tx) };
}

test('a new successful webhook confirms the related booking once', async () => {
  const db = database();
  const result = await createWebhookProcessor(db)({ eventId: 'event-1', providerPaymentId: 'provider-1', status: 'SUCCESS' });
  assert.equal(result.duplicate, false);
  assert.equal(result.booking.status, 'CONFIRMED');
  assert.deepEqual(db.calls, { paymentUpdates: 1, bookingUpdates: 1 });
});

test('a duplicate webhook is a no-op', async () => {
  const db = database({ duplicate: true });
  const result = await createWebhookProcessor(db)({ eventId: 'event-1', providerPaymentId: 'provider-1', status: 'SUCCESS' });
  assert.deepEqual(result, { duplicate: true });
  assert.deepEqual(db.calls, { paymentUpdates: 0, bookingUpdates: 0 });
});

test('an unknown provider payment causes no booking transition', async () => {
  const db = database({ payment: null });
  await assert.rejects(
    createWebhookProcessor(db)({ eventId: 'event-2', providerPaymentId: 'missing', status: 'FAILED' }),
    { code: 'PAYMENT_NOT_FOUND' },
  );
  assert.deepEqual(db.calls, { paymentUpdates: 0, bookingUpdates: 0 });
});
