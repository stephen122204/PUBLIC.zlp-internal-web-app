const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    console.error(
      '❌  MONGO_URI is not set.\n' +
        '    Copy server/.env.example to server/.env and fill in your MongoDB Atlas connection string.'
    );
    process.exit(1);
  }

  try {
    await mongoose.connect(uri);
    console.log(`✅  MongoDB connected: ${mongoose.connection.host}`);
  } catch (err) {
    console.error('❌  MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

module.exports = connectDB;
