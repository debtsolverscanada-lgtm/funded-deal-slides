// Usage: node scripts/create-user.js email "Full Name" admin|member|viewer "password"
const { createUser } = require('../server.js');
const [email, name, role, password] = process.argv.slice(2);
if (!email || !name || !role || !password) {
  console.error('Usage: node scripts/create-user.js email "Full Name" admin|member|viewer "password"');
  process.exit(1);
}
try { const u = createUser({ email, name, role, password }); console.log(`Created ${u.role} account for ${u.name} <${u.email}>`); }
catch (e) { console.error(e.message); process.exit(1); }
