'use strict';
const mongoose = require('mongoose');

const snapshotCourseSchema = new mongoose.Schema(
  {
    originalCourseRequestId: { type: mongoose.Schema.Types.ObjectId },
    subject:                 { type: String },
    number:                  { type: String },
    code:                    { type: String },
    title:                   { type: String },
    creditHours:             { type: Number },
    systemClassification:    { type: String },
    finalClassification:     { type: String },
    classificationReason:    { type: String },
    classificationWarnings:  { type: [String], default: [] },
    finalClassificationReason: { type: String },
    overrideStatus:          { type: String, default: 'none' },
    preferredSections: [
      {
        crn:            { type: String },
        section:        { type: String },
        instructorLabel:{ type: String },
        meetings:       { type: mongoose.Schema.Types.Mixed },
        termCode:       { type: String },
      },
    ],
    snapshotAt: { type: Date },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    userId:            { type: mongoose.Schema.Types.ObjectId, ref: 'User',            required: true },
    cohortId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort',          required: true },
    schedulingCycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchedulingCycle' },
    status:            { type: String, enum: ['draft', 'submitted', 'locked'], default: 'draft' },
    submittedAt:  { type: Date },
    lastEditedAt: { type: Date },

    // Frozen snapshot captured at submit time
    courseSnapshot:    { type: [snapshotCourseSchema], default: undefined },
    snapshotVersion:   { type: Number, default: 0 },
    lastSubmittedAt:   { type: Date },
    lastSubmittedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Frozen degree plan selection captured at submit time
    degreePlanSnapshot: {
      type: new mongoose.Schema({
        planId:    { type: String, default: null },
        planTitle: { type: String, default: null },
        catalog:   { type: String, default: null },
      }, { _id: false }),
      default: null,
    },

    // Frozen academic profile captured at submit time
    profileSnapshot: {
      type: new mongoose.Schema({
        primaryMajor:            { type: mongoose.Schema.Types.Mixed, default: null },
        additionalMajors:        { type: [mongoose.Schema.Types.Mixed], default: [] },
        minors:                  { type: [mongoose.Schema.Types.Mixed], default: [] },
        catalogYear:             { type: String, default: null },
        secondaryProgramEnabled: { type: Boolean, default: false },
      }, { _id: false }),
      default: null,
    },

    // Set true when student edits the live draft after a successful submit
    draftUpdatedAfterSubmit: { type: Boolean, default: false },
    draftUpdatedAt:          { type: Date },

    // Set true when the course list or academic profile changes and classification
    // has not been refreshed since.  Submit is blocked while this is true.
    classificationStale:     { type: Boolean, default: false },
  },
  { timestamps: true }
);

schema.index({ userId: 1, cohortId: 1, schedulingCycleId: 1 }, { unique: true });

module.exports = mongoose.model('StudentSubmission', schema);
