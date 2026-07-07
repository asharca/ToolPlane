import 'dotenv/config';
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth/password';
import {
  generateToken,
  hashToken,
  tokenPrefix,
} from '@/lib/auth/token-format';

async function main(): Promise<void> {
  const email = 'smoke@example.com';
  await db.user.deleteMany({ where: { email } });

  const user = await db.user.create({
    data: {
      email,
      name: 'Smoke Test',
      passwordHash: await hashPassword('password123'),
    },
  });

  const ws = await db.workspace.create({
    data: {
      slug: 'smoke',
      name: 'Smoke Workspace',
      ownerId: user.id,
    },
  });

  await db.membership.create({
    data: {
      userId: user.id,
      workspaceId: ws.id,
      role: 'owner',
    },
  });

  const token = generateToken();
  await db.apiToken.create({
    data: {
      userId: user.id,
      name: 'smoke',
      prefix: tokenPrefix(token),
      tokenHash: hashToken(token),
    },
  });

  console.log(`TOKEN=${token}`);
  await db.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
