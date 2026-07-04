'use strict';
/**
 * Prune AlgorithmRun documents to the latest 12 globally.
 *
 * Usage:
 *   node scripts/prune-old-algorithm-runs.js          # dry run (default)
 *   DRY_RUN=false node scripts/prune-old-algorithm-runs.js  # live delete
 *
 * Retention rule: keep the 12 most-recent AlgorithmRun docs (by createdAt, _id).
 * Since each algorithm invocation produces 2 docs (required_only +
 * required_plus_preferred), 12 docs ≈ the last 6 full run attempts.
 */
process.chdir('/Users/Stephen/Desktop/ZLP_APP/server');
require('dotenv').config();
const mongoose = require('mongoose');

const RETENTION_LIMIT = 12;
const DRY_RUN         = process.env.DRY_RUN !== 'false';

const AlgorithmRunSchema = new mongoose.Schema({
  cohortId:          mongoose.Schema.Types.ObjectId,
  schedulingCycleId: mongoose.Schema.Types.ObjectId,
  mode:              String,
  createdAt:         Date,
}, { collection: 'algorithmruns', timestamps: true });

const AlgorithmRun = mongoose.model('AlgorithmRunPrune', AlgorithmRunSchema);

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const dbName = mongoose.connection.name;
  console.log(`Connected to MongoDB — database: "${dbName}"`);
  console.log(`Retention limit: ${RETENTION_LIMIT} docs globally (collection: algorithmruns)`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no deletes)' : 'LIVE (will delete)'}\n`);

  const totalBefore = await AlgorithmRun.countDocuments();
  console.log(`Total AlgorithmRun documents (before): ${totalBefore}`);

  // Use deterministic sort so paired runs (same createdAt ms) always order consistently
  const runsToDelete = await AlgorithmRun.find({})
    .sort({ createdAt: -1, _id: -1 })
    .skip(RETENTION_LIMIT)
    .select('_id mode cohortId schedulingCycleId createdAt')
    .lean();

  const willKeep = totalBefore - runsToDelete.length;
  console.log(`Kept:   ${willKeep}`);
  console.log(`Delete: ${runsToDelete.length}\n`);

  if (runsToDelete.length > 0) {
    console.log('Runs to delete (oldest first):');
    for (const r of [...runsToDelete].reverse()) {
      console.log(
        `  id=${r._id}  mode=${r.mode ?? 'null'}  cohort=${r.cohortId}  cycle=${r.schedulingCycleId}  createdAt=${r.createdAt}`
      );
    }
    console.log('');
  }

  if (runsToDelete.length === 0) {
    console.log('Nothing to delete — already within retention limit.');
  } else if (DRY_RUN) {
    console.log(`[DRY RUN] Would delete ${runsToDelete.length} run(s). Set DRY_RUN=false to apply.`);
  } else {
    const result = await AlgorithmRun.deleteMany({
      _id: { $in: runsToDelete.map((r) => r._id) },
    });
    console.log(`Deleted ${result.deletedCount} run(s).`);
    const totalAfter = await AlgorithmRun.countDocuments();
    console.log(`Total AlgorithmRun documents (after): ${totalAfter}`);
  }

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => { console.error(err); process.exit(1); });
