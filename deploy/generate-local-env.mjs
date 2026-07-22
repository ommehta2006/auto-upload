import crypto from 'node:crypto';
import fs from 'node:fs';
const path = '.env.local';
if (fs.existsSync(path)) { console.log('.env.local already exists.'); process.exit(0); }
const text = `SESSION_SECRET=${crypto.randomBytes(64).toString('base64url')}\nSESSION_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')}\nSIGNUP_INVITE_CODE=${crypto.randomBytes(12).toString('base64url')}\nMAX_VIDEO_MB=1000\nMAX_STORAGE_MB_PER_USER=4096\n`;
fs.writeFileSync(path,text,{ mode:0o600 });
console.log(`Created ${path}. Invitation code: ${text.match(/SIGNUP_INVITE_CODE=(.+)/)[1]}`);
