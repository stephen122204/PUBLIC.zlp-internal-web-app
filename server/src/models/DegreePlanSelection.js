'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
    cohortId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort', required: true },
    planId:    { type: String, required: true },
    planTitle: { type: String },
    catalog:   { type: String },
  },
  { timestamps: true }
);

schema.index({ userId: 1, cohortId: 1 }, { unique: true });

module.exports = mongoose.model('DegreePlanSelection', schema);
