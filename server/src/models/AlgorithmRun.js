'use strict';
const mongoose = require('mongoose');

const parametersSchema = new mongoose.Schema({
  blockLengthMinutes: { type: Number, default: 100 },
  stepMinutes:        { type: Number, default: 5 },
  gridStartMinutes:   { type: Number, default: 480 },  // 8:00 AM
  gridEndMinutes:     { type: Number, default: 970 },  // 4:10 PM latest start
  weekdays:           { type: [String], default: ['M', 'T', 'W', 'R', 'F'] },
  timezone:           { type: String, default: 'America/Chicago' },
  includeDraftSubmissions: { type: Boolean, default: false },
  legacyMode:              { type: Boolean, default: false },
  solverVersion:           { type: String,  default: null },
  maxSearchNodes:          { type: Number,  default: null },
  maxSearchMs:             { type: Number,  default: null },
  termCode:                { type: String,  default: null },
}, { _id: false });

const summarySchema = new mongoose.Schema({
  totalStudents:         { type: Number, default: 0 },
  totalCourseRequests:   { type: Number, default: 0 },
  totalUniqueCourses:    { type: Number, default: 0 },
  bestConflictRequests:  { type: Number, default: null },
  bestAffectedStudents:  { type: Number, default: null },
  bestSelfConflictStudents: { type: Number, default: null },
  bestBlockedRequests:   { type: Number, default: null },
  bestWindowsCount:      { type: Number, default: 0 },
}, { _id: false });

const schema = new mongoose.Schema({
  cohortId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort',          required: true },
  schedulingCycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchedulingCycle', required: true },
  mode: {
    type: String,
    enum: ['required_only', 'preferred', 'required_plus_preferred'],
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'running', 'completed', 'failed'],
    default: 'pending',
  },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  startedAt:   { type: Date },
  completedAt: { type: Date },
  parameters:  { type: parametersSchema, default: () => ({}) },
  summary:     { type: summarySchema,    default: () => ({}) },
  warnings:    { type: [String], default: [] },
  errorMessage: { type: String, default: null },
  // Full results stored inline (split into separate collection if too large)
  results: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
}, { timestamps: true });

schema.index({ cohortId: 1, schedulingCycleId: 1, createdAt: -1 });

module.exports = mongoose.model('AlgorithmRun', schema);
