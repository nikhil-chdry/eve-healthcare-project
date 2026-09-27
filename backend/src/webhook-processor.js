/**
 * Applies a provider event atomically. The unique WebhookEvent.eventId index is
 * the source of truth for idempotency; application checks alone are race-prone.
 */
function createWebhookProcessor(db) {
  return async function processWebhook(payload) {
    return db.$transaction(async (tx) => {
      try {
        await tx.webhookEvent.create({ data: { eventId: payload.eventId, payload } });
      } catch (error) {
        if (error.code === 'P2002') return { duplicate: true };
        throw error;
      }

      const payment = await tx.payment.findUnique({ where: { providerPaymentId: payload.providerPaymentId } });
      // Throwing rolls back the event record too, so a corrected provider retry
      // is not accidentally treated as a duplicate.
      if (!payment) {
        const error = new Error('Payment not found');
        error.code = 'PAYMENT_NOT_FOUND';
        throw error;
      }
      if (payment.status !== 'PENDING' && payment.status !== payload.status) {
        throw new Error(`Payment already processed with status ${payment.status}, cannot change to ${payload.status}`);
      }

      await tx.payment.update({ where: { id: payment.id }, data: { status: payload.status } });
      const booking = await tx.booking.update({
        where: { id: payment.bookingId },
        data: { status: payload.status === 'SUCCESS' ? 'CONFIRMED' : 'FAILED' },
      });
      return { duplicate: false, booking };
    });
  };
}

module.exports = { createWebhookProcessor };
