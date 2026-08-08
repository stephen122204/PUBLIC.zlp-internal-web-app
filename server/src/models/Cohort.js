const mongoose = require('mongoose');

const cohortSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    // Legacy fields — kept for backward compat with old test data
    term: { type: String },
    termCode: { type: String },
    submissionDeadline: { type: Date },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    archivedAt: { type: Date },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    notes: { type: String },
    catalogYear: { type: String, default: null },
    // Manual display order on the admin cohort page. 0 = unordered (sorts by
    // createdAt within the 0-group); reordering assigns 1..N in the chosen order.
    sortIndex: { type: Number, default: 0 },
    // Join code fields
    joinCode:          { type: String, uppercase: true, trim: true, minlength: 6, maxlength: 6, default: null },
    joinCodeEnabled:   { type: Boolean, default: false },
    // How long the code stays active after enabling. 'never' = no expiry.
    joinCodeDuration:  { type: String, enum: ['1d', '3d', '7d', '30d', 'never'], default: '3d' },
    joinCodeExpiresAt: { type: Date, default: null },
    joinCodeUpdatedAt: { type: Date, default: null },
    joinCodeUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // System demo cohort (hidden from normal admin views, used only for Demo Student View)
    isSystemDemo:      { type: Boolean, default: false },
    hidden:            { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Sparse unique index — allows multiple cohorts with null joinCode
cohortSchema.index({ joinCode: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Cohort', cohortSchema);
