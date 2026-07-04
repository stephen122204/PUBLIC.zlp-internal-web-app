'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    userId:             { type: mongoose.Schema.Types.ObjectId, ref: 'User',            required: true },
    cohortId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort',          required: true },
    schedulingCycleId:  { type: mongoose.Schema.Types.ObjectId, ref: 'SchedulingCycle' },
    termCode:           { type: String },
    campus:             { type: String, default: 'college-station' },
    subject:  { type: String, required: true },
    number:   { type: String, required: true },
    code:     { type: String, required: true }, // e.g. "CSCE 121"
    title:    { type: String },
    college:  { type: String },
    systemClassification: {
      type: String,
      enum: ['unclassified', 'required', 'preferred', 'not_applied'],
      default: 'unclassified',
    },
    finalClassification: {
      type: String,
      enum: ['unclassified', 'required', 'preferred', 'not_applied'],
      default: 'unclassified',
    },
    classificationReason: { type: String, default: 'Classification pending.' },
    classificationWarnings: { type: [String], default: [] },
    classificationEvidence: { type: mongoose.Schema.Types.Mixed, default: null },
    classifiedAt: { type: Date, default: null },
    classifierVersion: { type: String, default: null },
    // Admin override fields
    finalClassificationReason: { type: String, default: null },
    overrideStatus: {
      type: String,
      enum: ['none', 'manual_override'],
      default: 'none',
    },
    overrideUpdatedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    overrideUpdatedAt:  { type: Date, default: null },
    offeredInSnapshot:  { type: Boolean, default: null },
    creditHours:        { type: Number, default: null },
  },
  { timestamps: true }
);

// Unique per student per cycle per course code.
// Note: if schedulingCycleId is null (legacy), uniqueness is per (userId, cohortId, null, code).
schema.index({ userId: 1, cohortId: 1, schedulingCycleId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('StudentCourseRequest', schema);
