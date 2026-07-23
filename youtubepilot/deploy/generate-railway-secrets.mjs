import crypto from 'node:crypto';

const sessionSecret = crypto.randomBytes(64).toString('base64url');
const encryptionKey = crypto.randomBytes(32).toString('base64');
const inviteCode = crypto.randomBytes(18).toString('base64url');

console.log(`SESSION_SECRET=${sessionSecret}`);
console.log(`SESSION_ENCRYPTION_KEY=${encryptionKey}`);
console.log(`SIGNUP_INVITE_CODE=${inviteCode}`);
