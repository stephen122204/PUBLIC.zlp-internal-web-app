'use strict';
// One-time cleanup: physically remove the retired `passed` and `needsRetake`
// fields from every StudentPlannedCourse document. These are no longer part of
// the schema — a course is now implicitly "passed" simply by being in the
// database, and all pass/retake handling lives in code. Removing a field from a
// Mongoose schema does NOT strip it from already-saved documents, so this script
// $unsets them directly on the collection.
process.chdir('/Users/Stephen/Desktop/ZLP_APP/server');
require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB.');

  const col = mongoose.connection.db.collection('studentplannedcourses');

  const before = await col.countDocuments({ $or: [{ passed: { $exists: true } }, { needsRetake: { $exists: true } }] });
  console.log(`Documents still carrying passed/needsRetake: ${before}`);

  if (before === 0) {
    console.log('ℹ️  Nothing to clean up.');
  } else {
    const res = await col.updateMany({}, { $unset: { passed: '', needsRetake: '' } });
    console.log(`✅ Updated ${res.modifiedCount} document(s); removed passed/needsRetake.`);
    const after = await col.countDocuments({ $or: [{ passed: { $exists: true } }, { needsRetake: { $exists: true } }] });
    console.log(`Remaining documents with either field: ${after}`);
  }

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => { console.error(err); process.exit(1); });
