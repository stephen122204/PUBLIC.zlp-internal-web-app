const mongoose = require('mongoose');

const cohortInviteLinkSchema = new mongoose.Schema(
  {
    cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort', required: true },
    tokenHash: { type: String, required: true },
    rawToken: { type: String },
    status: { type: String, enum: ['active', 'expired', 'revoked'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CohortInviteLink', cohortInviteLinkSchema);
