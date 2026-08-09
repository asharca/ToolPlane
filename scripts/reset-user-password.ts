import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth/password';

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || process.argv.length > 3) {
    throw new Error('Usage: pnpm account:reset-password -- user@example.com');
  }

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`No ToolPlane account exists for ${email}`);

  const password = randomBytes(18).toString('base64url');
  const passwordHash = await hashPassword(password);
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, sessionVersion: { increment: 1 } },
    });
    await tx.passwordResetToken.deleteMany({ where: { userId: user.id } });
  });

  console.log(`Password reset for ${user.email}`);
  console.log(`Temporary password (shown once): ${password}`);
  console.log('Ask the user to sign in and change it immediately.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
