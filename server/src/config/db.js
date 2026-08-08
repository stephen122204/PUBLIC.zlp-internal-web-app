const mongoose = require('mongoose');

// Serverless-safe connection: cache the connection (and the in-flight promise)
// on the global object so it is reused across function invocations and never
// opened more than once per instance. Throws instead of process.exit() so a
// failure surfaces as a request error rather than killing the instance.
let cached = global._mongoose;
if (!cached) cached = global._mongoose = { conn: null, promise: null };

async function connectDB() {
  if (cached.conn) return cached.conn;

  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error(
      'MONGO_URI is not set. Copy server/.env.example to server/.env (local) or set it in the Vercel dashboard.'
    );
  }

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(uri, { maxPoolSize: 10 })
      .then((m) => {
        console.log(`✅  MongoDB connected: ${m.connection.host}`);
        return m.connection;
      })
      .catch((err) => {
        cached.promise = null; // allow a retry on the next request
        throw err;
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

module.exports = connectDB;
