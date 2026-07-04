const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('./models/User');

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const DEV_EMAILS = (process.env.DEV_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

passport.serializeUser((user, done) => {
  done(null, user._id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${process.env.SERVER_BASE_URL || 'http://localhost:3001'}/api/auth/google/callback`,
      passReqToCallback: true,
    },
    async (req, accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value?.toLowerCase();
        if (!email) return done(null, false, { message: 'No email from Google.' });

        const isDev   = DEV_EMAILS.length > 0 && DEV_EMAILS.includes(email);
        const isAdmin = isDev || ADMIN_EMAILS.includes(email);
        const isTamu  = email.endsWith('@tamu.edu');

        // Non-admin must be @tamu.edu
        if (!isAdmin && !isTamu) {
          return done(null, false, { message: 'non_tamu_email' });
        }

        let user = await User.findOne({ googleId: profile.id });

        if (user) {
          // Update last login and promote role if email lists have changed
          user.lastLoginAt = new Date();
          if (isDev && user.role !== 'developer') user.role = 'developer';
          else if (isAdmin && user.role === 'student') user.role = 'admin';
          await user.save();
          return done(null, user);
        }

        // New user — create account; students will join a cohort via join code after login
        user = await User.create({
          googleId:    profile.id,
          email,
          name:        profile.displayName,
          role:        isDev ? 'developer' : (isAdmin ? 'admin' : 'student'),
          lastLoginAt: new Date(),
        });

        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  )
);
