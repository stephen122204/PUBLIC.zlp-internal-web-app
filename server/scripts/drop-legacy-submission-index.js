'use strict';
process.chdir('/Users/Stephen/Desktop/ZLP_APP/server');
require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB.');

  const db = mongoose.connection.db;
  const col = db.collection('studentsubmissions');

  const indexes = await col.indexes();
  console.log('Current indexes on studentsubmissions:');
  indexes.forEach((idx) => console.log(' -', idx.name, JSON.stringify(idx.key)));

  const legacy = indexes.find((idx) => idx.name === 'userId_1_cohortId_1');
  if (legacy) {
    await col.dropIndex('userId_1_cohortId_1');
    console.log('✅ Dropped legacy index userId_1_cohortId_1');
  } else {
    console.log('ℹ️  Legacy index not found — nothing to drop.');
  }

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => { console.error(err); process.exit(1); });
