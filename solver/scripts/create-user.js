// Usage: node scripts/create-user.js email "Full Name" admin|member|viewer|guest "password" [--boards=boardId1,boardId2]
// A guest only sees the boards listed with --boards (their email is added to each board's access list).
const { createUser, setGuestBoards } = require('../server.js');
const args = process.argv.slice(2), opts = args.filter(a => a.startsWith('--')), [email, name, role, password] = args.filter(a => !a.startsWith('--'));
const usage = 'Usage: node scripts/create-user.js email "Full Name" admin|member|viewer|guest "password" [--boards=boardId1,boardId2]';
if (!email || !name || !role || !password) { console.error(usage); process.exit(1); }
const boards = ((opts.find(o => o.startsWith('--boards=')) || '').slice(9)).split(',').map(s => s.trim()).filter(Boolean);
try {
  const u = createUser({ email, name, role, password });
  if (role === 'guest' && boards.length) setGuestBoards(u.email, boards, 'script');
  console.log(`Created ${u.role} account for ${u.name} <${u.email}>${role === 'guest' ? ` on ${boards.length} board(s)` : ''}`);
} catch (e) { console.error(e.message); process.exit(1); }
