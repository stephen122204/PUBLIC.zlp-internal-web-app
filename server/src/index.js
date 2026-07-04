require('dotenv').config();
const express = require('express');
const session = require('express-session');
const connectMongo = require('connect-mongo');
const MongoStore = connectMongo.MongoStore || connectMongo.default || connectMongo;
const passport = require('passport');
const cors = require('cors');
const mongoose = require('mongoose');

const connectDB = require('./config/db');
require('./passport');

const authRoutes = require('./routes/auth');
const adminCohortRoutes = require('./routes/admin/cohorts');
const adminInviteRoutes = require('./routes/admin/inviteLinks');
const adminJoinCodeRoutes = require('./routes/admin/joinCode');
const adminMemberRoutes = require('./routes/admin/members');
const adminSubmissionRoutes = require('./routes/admin/submissions');
const adminCycleRoutes = require('./routes/admin/cycles');
const adminTermOptionsRoutes = require('./routes/admin/termOptions');
const adminStudentReviewRoutes = require('./routes/admin/studentReview');
const adminAcademicProfileRoutes = require('./routes/admin/academicProfile');
const adminStudentDegreePlanRoutes = require('./routes/admin/studentDegreePlan');
const adminAlgorithmRoutes         = require('./routes/admin/algorithm');
const adminDemoStudentRoutes       = require('./routes/admin/demoStudent');

const developerRoutes = require('./routes/developer/index');

const studentCourseRoutes = require('./routes/student/courses');
const studentDegreePlanRoutes = require('./routes/student/degreePlans');
const studentCohortRoutes = require('./routes/student/cohort');
const studentJoinCohortRoutes = require('./routes/student/joinCohort');
const studentDegreePlanSelectionRoutes = require('./routes/student/degreePlanSelection');
const studentCourseRequestRoutes = require('./routes/student/courseRequests');
const studentSubmissionRoutes = require('./routes/student/submission');
const studentAcademicProfileRoutes = require('./routes/student/academicProfile');
const studentSemesterPlanRoutes = require('./routes/student/semesterPlan');
const studentHowdyImportRoutes = require('./routes/student/howdyImport');
const academicProgramsRoutes = require('./routes/academicPrograms');
const degreeGraphRoutes = require('./routes/degreeGraph');

const app = express();
const PORT = process.env.PORT || 3001;

// Connect MongoDB
connectDB();

// CORS
app.use(
  cors({
    origin: process.env.CLIENT_BASE_URL || 'http://localhost:5173',
    credentials: true,
    exposedHeaders: ['Content-Disposition'],
  })
);

app.use(express.json());

// Session
app.use(
  session({
    secret: process.env.SESSION_SECRET || process.env.JWT_SECRET || 'zlp-secret',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminCohortRoutes);
app.use('/api/admin', adminInviteRoutes);
app.use('/api/admin', adminJoinCodeRoutes);
app.use('/api/admin', adminMemberRoutes);
app.use('/api/admin', adminSubmissionRoutes);
app.use('/api/admin', adminCycleRoutes);
app.use('/api/admin', adminTermOptionsRoutes);
app.use('/api/admin', adminStudentReviewRoutes);
app.use('/api/admin', adminAcademicProfileRoutes);
app.use('/api/admin', adminStudentDegreePlanRoutes);
app.use('/api/admin', adminAlgorithmRoutes);
app.use('/api/admin', adminDemoStudentRoutes);

// Developer routes
app.use('/api/developer', developerRoutes);

// Student routes
app.use('/api/student/courses', studentCourseRoutes);
app.use('/api/student/degree-plans', studentDegreePlanRoutes);
app.use('/api/student/cohort', studentCohortRoutes);
app.use('/api/student', studentJoinCohortRoutes);
app.use('/api/student/degree-plan-selection', studentDegreePlanSelectionRoutes);
app.use('/api/student/course-requests', studentCourseRequestRoutes);
app.use('/api/student/submission', studentSubmissionRoutes);
app.use('/api/student/academic-profile', studentAcademicProfileRoutes);
app.use('/api/student/degree-plan', studentSemesterPlanRoutes);
app.use('/api/student/howdy-import', studentHowdyImportRoutes);
app.use('/api/academic-programs', academicProgramsRoutes);
app.use('/api/degree-graph', degreeGraphRoutes);

app.get('/api/health', (_req, res) => {
  const state = mongoose.connection.readyState;
  // 0=disconnected 1=connected 2=connecting 3=disconnecting
  const stateMap = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  res.json({
    status: state === 1 ? 'ok' : 'degraded',
    database: stateMap[state] ?? 'unknown',
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
