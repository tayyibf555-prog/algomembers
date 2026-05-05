// Vercel function entry — re-exports the Express app from server.js.
// vercel.json rewrites /api/(.*) and / through this file.
module.exports = require('../server');
