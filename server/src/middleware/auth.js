function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'admin' && req.user.role !== 'developer') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

function requireStudent(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Forbidden' });
  next();
}

function requireDeveloper(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'developer') return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ---------------------------------------------------------------------------
// resolveStudentContext
//
// Sets req.studentUser to the effective student identity:
//   - Real student            → req.studentUser = req.user
//   - Admin + demo header     → req.studentUser = admin's demo student
//   - Developer (any mode)    → req.studentUser = req.user (dev uses their own id)
//
// Must be used on student-facing routes that need identity-scoped data.
// Callers should use req.studentUser._id instead of req.user._id.
// ---------------------------------------------------------------------------
async function resolveStudentContext(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

  const role = req.user.role;

  // Real student — use as-is.
  if (role === 'student') {
    req.studentUser = req.user;
    return next();
  }

  // Developer in student-view preview — use their own identity (existing behavior).
  if (role === 'developer') {
    req.studentUser = req.user;
    return next();
  }

  // Admin in Demo Student View — resolve their dedicated demo student.
  if (role === 'admin' && req.headers['x-student-context'] === 'demo') {
    try {
      const User = require('../models/User');
      const demo = await User.findOne({ isDemoStudent: true, demoForAdmin: req.user._id }).lean();
      if (!demo) {
        return res.status(404).json({ error: 'Demo student not found. Please initialize Demo Student View first.' });
      }
      req.studentUser = demo;
      return next();
    } catch (err) {
      return res.status(500).json({ error: 'Failed to resolve demo student context.' });
    }
  }

  // All other cases (admin without demo header, etc.) are forbidden on student routes.
  return res.status(403).json({ error: 'Forbidden' });
}

module.exports = { requireAuth, requireAdmin, requireStudent, requireDeveloper, resolveStudentContext };

