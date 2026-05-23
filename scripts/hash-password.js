import { pbkdf2Sync, randomBytes } from 'node:crypto';

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run hash-password -- "your password"');
  process.exit(1);
}

const digest = 'sha256';
const iterations = 210000;
const salt = randomBytes(16).toString('base64url');
const hash = pbkdf2Sync(password, salt, iterations, 32, digest).toString('base64url');
console.log(`pbkdf2$${digest}$${iterations}$${salt}$${hash}`);
