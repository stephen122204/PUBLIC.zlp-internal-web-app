const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    // OAuth accounts have googleId; dummy student accounts do not (field absent, not null).
    googleId: { type: String, unique: true, sparse: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    name: { type: String, required: true },
    role: { type: String, enum: ['developer', 'admin', 'student'], required: true },
    cohortId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort', default: null },
    lastLoginAt: { type: Date },
    // Dummy student fields (developer-created test accounts)
    isDummy:         { type: Boolean, default: false },
    dummyCreatedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    dummyCreatedAt:  { type: Date, default: null },
    // Demo student fields (admin-owned demo accounts for Demo Student View)
    isDemoStudent:   { type: Boolean, default: false },
    demoForAdmin:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    demoCreatedAt:   { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
