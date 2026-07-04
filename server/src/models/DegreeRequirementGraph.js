'use strict';
const mongoose = require('mongoose');

const nodeSchema = new mongoose.Schema(
  {
    id:               { type: String, required: true },
    code:             { type: String, default: null },
    subject:          { type: String, default: null },
    number:           { type: String, default: null },
    title:            { type: String, default: '' },
    creditHours:      { type: Number, default: null },
    requirementType:  { type: String, default: 'required' }, // 'required' | 'elective' | 'choice' | 'path_option'
    requirementSubtype: { type: String, default: null },     // e.g. 'exact_compound_choice'
    semesterColumn:   { type: String, default: null },
    rawRequirementText: { type: String, default: '' },
    matches:          { type: [String], default: [] },
    paths:            { type: mongoose.Schema.Types.Mixed, default: null }, // path_option course paths
    alternatives:     { type: mongoose.Schema.Types.Mixed, default: null }, // compound choice alternatives
    pickCount:        { type: Number, default: null }, // for elective pool nodes: how many to pick
    requiredHours:    { type: Number, default: null }, // for hours-based elective pools
    requiredHoursLabel: { type: String, default: null }, // raw hour range string, e.g. "6-9"
    trackId:          { type: String, default: null },  // track-pool nodes: which selectable track they belong to
    isCatchAllPool:   { type: Boolean, default: false }, // track pool that applies to any track
    poolCourses:      { type: mongoose.Schema.Types.Mixed, default: null }, // [{ code, hours }] for area/track pools
    optionPrereqs:    { type: mongoose.Schema.Types.Mixed, default: null }, // choice nodes: { optionCode: [inPlanPrereqCodes] }
    optionCoreqs:     { type: mongoose.Schema.Types.Mixed, default: null }, // choice nodes: { optionCode: [inPlanCoreqCodes] }
    prereqs:          { type: [String], default: [] },
    coreqs:           { type: [String], default: [] },
    prereqGroups:     { type: mongoose.Schema.Types.Mixed, default: null }, // AND-of-OR prereq structure: [[alt,alt],[req]]
  },
  { _id: false }
);

const edgeSchema = new mongoose.Schema(
  {
    from:       { type: String, required: true },
    to:         { type: String, required: true },
    type:       { type: String, enum: ['prerequisite', 'corequisite', 'recommended', 'unknown'], default: 'prerequisite' },
    rawText:    { type: String, default: '' },
    optionCode: { type: String, default: null }, // for choice-node option edges: which option this edge belongs to
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    programId:            { type: String, required: true, unique: true },
    catalog:              { type: String, default: null },
    title:                { type: String, default: '' },
    sourceUrl:            { type: String, default: null },
    generatedAt:          { type: Date, default: Date.now },
    parserVersion:        { type: Number, default: 0 },
    nodes:                { type: [nodeSchema], default: [] },
    edges:                { type: [edgeSchema], default: [] },
    flexibleRequirements: { type: mongoose.Schema.Types.Mixed, default: [] },
    availableTracks:      { type: mongoose.Schema.Types.Mixed, default: null }, // single-page multi-track majors (BMEN)
    warnings:             { type: [String], default: [] },
    source:               { type: String, enum: ['static', 'scraped', 'manual'], default: 'static' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DegreeRequirementGraph', schema);
