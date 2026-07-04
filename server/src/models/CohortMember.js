const mongoose = require('mongoose');

const cohortMemberSchema = new mongoose.Schema(
  {
    cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['active', 'removed'], default: 'active' },
    joinedAt: { type: Date, default: Date.now },
    removedAt: { type: Date },
    joinedVia: { type: String, enum: ['invite_link', 'join_code', 'manual', 'demo'], default: 'manual' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CohortMember', cohortMemberSchema);
