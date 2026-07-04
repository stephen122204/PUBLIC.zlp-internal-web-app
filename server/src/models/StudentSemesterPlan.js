'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
    cohortId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort', required: true },
    label:      { type: String, required: true },          // e.g. "2026 Fall"
    year:       { type: Number, default: null },
    term:       { type: String, enum: ['Fall', 'Spring', 'Summer', 'Other'], default: 'Other' },
    termCode:   { type: String, default: null },           // e.g. "202631"
    orderIndex: { type: Number, required: true },          // controls display order
    status:     { type: String, enum: ['completed', 'in_progress', 'planned'], required: true },
    notes:      { type: String, default: '' },
  },
  { timestamps: true }
);

schema.index({ userId: 1, cohortId: 1, orderIndex: 1 });

module.exports = mongoose.model('StudentSemesterPlan', schema);
