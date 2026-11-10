// Turns off two-factor sign-in for one account (for someone who lost their phone and their backup codes).
// Usage: DATA_DIR=/data node scripts/reset-2fa.js person@example.com
const { db, q } = require('../server.js');
const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) { console.error('Usage: node scripts/reset-2fa.js person@example.com'); process.exit(1); }
const u = q.userByEmail.get(email);
if (!u) { console.error('No account with that email.'); process.exit(1); }
db.prepare('UPDATE users SET totp_on = 0, totp_secret = NULL, totp_pending = NULL, totp_last = -1, backup_codes = NULL WHERE id = ?').run(u.id);
console.log(`Two-factor sign-in is now off for ${email}. They sign in with their password and can set it up again under Security.`);
