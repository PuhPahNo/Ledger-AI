import { eq } from 'drizzle-orm';
import { hashPassword } from '../auth/password.js';
import { getEnv } from '../config/env.js';
import { closeDb, db } from '../db/client.js';
import { users } from '../db/schema.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const env = getEnv();
  const username = arg('username') ?? env.LEDGER_ADMIN_USERNAME;
  const password = arg('password') ?? env.LEDGER_ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('Admin password must be at least 12 characters');
  }
  const existing = await db.query.users.findFirst({ where: eq(users.username, username) });
  if (existing) {
    await db.update(users).set({
      passwordHash: await hashPassword(password),
      active: true,
      updatedAt: new Date(),
    }).where(eq(users.id, existing.id));
    console.log(`Reset password for ${username}`);
  } else {
    await db.insert(users).values({
      username,
      displayName: 'Ledger Admin',
      passwordHash: await hashPassword(password),
    });
    console.log(`Created admin user ${username}`);
  }
}

main()
  .then(() => closeDb())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
