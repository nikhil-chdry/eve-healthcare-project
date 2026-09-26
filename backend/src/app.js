require('dotenv').config();

const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { PrismaClient, Prisma } = require('@prisma/client');
const { createWebhookProcessor } = require('./webhook-processor');

const prisma = new PrismaClient();
const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET must be set');

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const validate = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) return next(new ApiError(422, 'Invalid request body'));
  req.body = result.data;
  next();
};
const requireAuth = (req, _res, next) => {
  const token = req.headers.authorization?.startsWith('Bearer ') && req.headers.authorization.slice(7);
  if (!token) return next(new ApiError(401, 'Authentication is required'));
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { next(new ApiError(401, 'Invalid or expired token')); }
};
const publicUser = ({ id, email, name, createdAt }) => ({ id, email, name, createdAt });

const signupSchema = z.object({ email: z.string().email(), password: z.string().min(8), name: z.string().min(1).max(100) });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const bookingSchema = z.object({ centreId: z.string().min(1), testId: z.string().min(1), appointmentAt: z.string().datetime({ offset: true }) });
const paymentSchema = z.object({ bookingId: z.string().min(1) });
const webhookSchema = z.object({ eventId: z.string().min(1), providerPaymentId: z.string().min(1), status: z.enum(['SUCCESS', 'FAILED']) });

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/auth/signup', validate(signupSchema), asyncRoute(async (req, res) => {
  const passwordHash = await bcrypt.hash(req.body.password, 12);
  try {
    const user = await prisma.user.create({ data: { email: req.body.email.toLowerCase(), passwordHash, name: req.body.name } });
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
    res.status(201).json({ user: publicUser(user), token });
  } catch (error) {
    if (error.code === 'P2002') throw new ApiError(409, 'Email is already registered');
    throw error;
  }
}));

app.post('/auth/login', validate(loginSchema), asyncRoute(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { email: req.body.email.toLowerCase() } });
  if (!user || !(await bcrypt.compare(req.body.password, user.passwordHash))) throw new ApiError(401, 'Invalid email or password');
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ user: publicUser(user), token });
}));

app.get('/centres', asyncRoute(async (_req, res) => {
  res.json(await prisma.centre.findMany({ include: { tests: true }, orderBy: { name: 'asc' } }));
}));
app.get('/centres/:id', asyncRoute(async (req, res) => {
  const centre = await prisma.centre.findUnique({ where: { id: req.params.id }, include: { tests: true } });
  if (!centre) throw new ApiError(404, 'Centre not found');
  res.json(centre);
}));
app.get('/centres/:id/tests', asyncRoute(async (req, res) => {
  const centre = await prisma.centre.findUnique({ where: { id: req.params.id } });
  if (!centre) throw new ApiError(404, 'Centre not found');
  res.json(await prisma.test.findMany({ where: { centreId: centre.id }, orderBy: { name: 'asc' } }));
}));

app.post('/bookings', requireAuth, validate(bookingSchema), asyncRoute(async (req, res) => {
  const appointmentAt = new Date(req.body.appointmentAt);
  if (appointmentAt <= new Date()) throw new ApiError(422, 'appointmentAt must be in the future');
  const [centre, test] = await Promise.all([
    prisma.centre.findUnique({ where: { id: req.body.centreId } }),
    prisma.test.findUnique({ where: { id: req.body.testId } }),
  ]);
  if (!centre || !test) throw new ApiError(404, !centre ? 'Centre not found' : 'Test not found');
  if (test.centreId !== centre.id) throw new ApiError(400, 'Test is not offered by this centre');
  const booking = await prisma.booking.create({ data: { userId: req.user.id, centreId: centre.id, testId: test.id, appointmentAt, amount: test.price } });
  res.status(201).json(booking);
}));

async function ownedBooking(id, userId) {
  const booking = await prisma.booking.findUnique({ where: { id } });
  if (!booking) throw new ApiError(404, 'Booking not found');
  if (booking.userId !== userId) throw new ApiError(403, 'You do not have access to this booking');
  return booking;
}
app.get('/bookings', requireAuth, asyncRoute(async (req, res) => {
  res.json(await prisma.booking.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' } }));
}));
app.get('/bookings/:id', requireAuth, asyncRoute(async (req, res) => res.json(await ownedBooking(req.params.id, req.user.id))));
app.patch('/bookings/:id/cancel', requireAuth, asyncRoute(async (req, res) => {
  const booking = await ownedBooking(req.params.id, req.user.id);
  if (booking.status !== 'PENDING') throw new ApiError(409, 'Only pending bookings can be cancelled');
  res.json(await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } }));
}));

const webhookProcessor = createWebhookProcessor(prisma);
async function processWebhook(payload) {
  try { return await webhookProcessor(payload); }
  catch (error) {
    if (error.code === 'PAYMENT_NOT_FOUND') throw new ApiError(404, 'Payment not found');
    throw error;
  }
}

app.post('/payments', requireAuth, validate(paymentSchema), asyncRoute(async (req, res) => {
  const booking = await ownedBooking(req.body.bookingId, req.user.id);
  if (booking.status !== 'PENDING') throw new ApiError(409, 'Payment can only be attempted for a pending booking');
  const providerPaymentId = crypto.randomUUID();
  try {
    await prisma.payment.create({ data: { bookingId: booking.id, provider: 'EVE-MOCK', providerPaymentId, amount: booking.amount, status: 'PENDING' } });
  } catch (error) {
    if (error.code === 'P2002') throw new ApiError(409, 'A payment already exists for this booking');
    throw error;
  }
  const status = Math.random() < 0.8 ? 'SUCCESS' : 'FAILED';
  const result = await processWebhook({ eventId: crypto.randomUUID(), providerPaymentId, status });
  res.status(201).json({ providerPaymentId, status, booking: result.booking });
}));

app.post('/payments/webhook', validate(webhookSchema), asyncRoute(async (req, res) => {
  const result = await processWebhook(req.body);
  res.status(200).json(result.duplicate ? { received: true, duplicate: true } : { received: true });
}));

app.use((_req, _res, next) => next(new ApiError(404, 'Route not found')));
app.use((error, _req, res, _next) => {
  if (error instanceof ApiError) return res.status(error.status).json({ error: error.message });
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ error: 'Duplicate resource' });
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = { app, processWebhook };
