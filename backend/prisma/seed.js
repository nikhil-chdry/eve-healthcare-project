const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const centre = await prisma.centre.upsert({ where: { id: 'eve-central' }, update: {}, create: { id: 'eve-central', name: 'EVE Central Diagnostics', location: 'Bengaluru' } });
  for (const test of [{ id: 'cbc', name: 'Complete Blood Count', price: 450 }, { id: 'thyroid', name: 'Thyroid Profile', price: 850 }]) {
    await prisma.test.upsert({ where: { id: test.id }, update: {}, create: { ...test, centreId: centre.id } });
  }
}
main().finally(() => prisma.$disconnect());
