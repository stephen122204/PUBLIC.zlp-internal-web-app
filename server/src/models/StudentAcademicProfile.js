'use strict';
const mongoose = require('mongoose');

/** Reusable sub-schema for a major/minor entry */
const programEntrySchema = new mongoose.Schema(
  {
    programId:       { type: String, required: true },
    title:           { type: String, default: null },
    catalog:         { type: String, default: null },
    college:         { type: String, default: null },
    department:      { type: String, default: null },
    degreePlanId:    { type: String, default: null },
    hasDetailedPlan: { type: Boolean, default: false },
    // For single-page multi-track majors (e.g. BMEN), the track the student selected.
    // Matches an id in the program graph's availableTracks[]. null for single-track majors.
    selectedTrackId: { type: String, default: null },
  },
  { _id: false }
);

/** Pending student selections (not yet submitted) */
const studentDraftSchema = new mongoose.Schema(
  {
    primaryMajor:     { type: programEntrySchema, default: null },
    additionalMajors: { type: [programEntrySchema], default: [] },
    minors:           { type: [programEntrySchema], default: [] },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
    cohortId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort', required: true },
    catalogYear: { type: String, default: null },

    primaryMajor:     { type: programEntrySchema, default: null },
    additionalMajors: { type: [programEntrySchema], default: [] },
    minors:           { type: [programEntrySchema], default: [] },

    /**
     * Student's uncommitted draft selections. Written by student PUT; read by
     * student GET (overrides canonical). Cleared by admin PUT (when major/minor
     * changes) and promoted to canonical on course submission.
     */
    studentDraft: { type: studentDraftSchema, default: null },

    /** Admin-controlled flag: allows the student to enroll in a secondary program (double major, dual degree, etc.) */
    secondaryProgramEnabled: { type: Boolean, default: false },

    /**
     * Admin-controlled override: when true the student may submit even if
     * Required + Preferred credit hours exceed the 17-hour cap.
     * Only bypasses the credit-hour limit — all other submission guards still apply.
     */
    allowOverCreditSubmission: { type: Boolean, default: false },
    allowOverCreditSubmissionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    allowOverCreditSubmissionAt: { type: Date, default: null },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

schema.index({ userId: 1, cohortId: 1 }, { unique: true });

module.exports = mongoose.model('StudentAcademicProfile', schema);
