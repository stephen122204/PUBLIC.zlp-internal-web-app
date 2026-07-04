'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    courseRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StudentCourseRequest',
      required: true,
    },
    userId:            { type: mongoose.Schema.Types.ObjectId, ref: 'User',            required: true },
    cohortId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort',          required: true },
    schedulingCycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchedulingCycle' },
    termCode:          { type: String },
    crn:            { type: String, required: true },
    section:        { type: String },
    instructorLabel:{ type: String },
    meetings:       { type: Array, default: [] },
  },
  { timestamps: true }
);

schema.index({ courseRequestId: 1, crn: 1 }, { unique: true });

module.exports = mongoose.model('SectionPreference', schema);
