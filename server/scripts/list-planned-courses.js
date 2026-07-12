'use strict';
// List student planned courses (the `studentplannedcourses` collection), grouped
// by student, with their status and transfer/honors flags.
//
// Usage:
//   node scripts/list-planned-courses.js            --> every student
//   node scripts/list-planned-courses.js smith      --> only students whose name/email contains "smith"
process.chdir('/Users/Stephen/Desktop/ZLP_APP/server');
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const StudentPlannedCourse = require('../src/models/StudentPlannedCourse');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const filter = (process.argv[2] ?? '').trim().toLowerCase();

  const courses = await StudentPlannedCourse.find({}).lean();
  if (courses.length === 0) {
    console.log('No planned courses found.');
    await mongoose.disconnect();
    return;
  }

  // Group by student
  const byUser = new Map();
  for (const c of courses) {
    const uid = String(c.userId);
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(c);
  }

  const users = await User.find({ _id: { $in: [...byUser.keys()] } }, { name: 1, email: 1 }).lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  let shown = 0;
  for (const [uid, list] of byUser) {
    const u = userMap.get(uid);
    const label = `${u?.name ?? '(unknown)'} <${u?.email ?? uid}>`;
    if (filter && !label.toLowerCase().includes(filter)) continue;
    shown++;
    console.log(`\n=== ${label} — ${list.length} course(s) ===`);
    list.sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
    for (const c of list) {
      const flags = [c.transfer ? 'TRANSFER' : '', c.honors ? 'HON' : ''].filter(Boolean).join(',');
      console.log(`  ${String(c.code).padEnd(10)} ${String(c.status).padEnd(12)} ${flags.padEnd(14)} ${c.title ?? ''}`);
    }
  }
  if (shown === 0) console.log(filter ? `\nNo students matched "${filter}".` : '\nNo students.');

  await mongoose.disconnect();
  console.log('\nDone.');
}

run().catch((err) => { console.error(err); process.exit(1); });
