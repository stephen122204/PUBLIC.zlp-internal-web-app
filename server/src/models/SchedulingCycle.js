'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    cohortId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort', required: true },
    name:               { type: String },
    term:               { type: String, required: true },
    termCode:           { type: String, required: true },
    submissionOpenAt:   { type: Date },
    submissionDeadline: { type: Date },
    status:             { type: String, enum: ['draft', 'open', 'closed', 'archived'], default: 'draft' },
    archived:           { type: Boolean, default: false },
    activeForStudents:  { type: Boolean, default: false },
    createdBy:          { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // System demo cycle (hidden from normal admin views, used only for Demo Student View)
    isSystemDemo:       { type: Boolean, default: false },
  },
  { timestamps: true }
);

schema.index({ cohortId: 1, status: 1 });
schema.index({ cohortId: 1, archived: 1 });
schema.index({ cohortId: 1, activeForStudents: 1 });

module.exports = mongoose.model('SchedulingCycle', schema);
