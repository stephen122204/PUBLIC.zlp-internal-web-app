'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User',               required: true },
    cohortId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort',             required: true },
    semesterPlanId:   { type: mongoose.Schema.Types.ObjectId, ref: 'StudentSemesterPlan', required: true },
    subject:          { type: String, required: true },       // e.g. "CSCE"
    number:           { type: String, required: true },       // e.g. "221"
    code:             { type: String, required: true },       // e.g. "CSCE 221"
    title:            { type: String, default: '' },
    creditHours:      { type: Number, default: null },
    status:           { type: String, enum: ['completed', 'in_progress', 'planned'], required: true },
    transfer:         { type: Boolean, default: false },
    honors:           { type: Boolean, default: false },
    writingRequirement: { type: String, default: '' },
    source:           { type: String, enum: ['manual', 'screenshot_import', 'transcript_import', 'admin_edit', 'developer_edit'], default: 'manual' },
    notes:            { type: String, default: '' },
    updatedBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

schema.index({ userId: 1, cohortId: 1, semesterPlanId: 1 });
schema.index({ userId: 1, code: 1 });

module.exports = mongoose.model('StudentPlannedCourse', schema);
