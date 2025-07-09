require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Import routes
const csvProcessingRoutes = require('./routes/csvProcessingRoutes');

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware - CSP disabled for development
app.use(helmet({
  contentSecurityPolicy: false  // Disable CSP completely for development
}));

app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: process.env.MAX_REQUESTS_PER_MINUTE || 30
});
app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files
app.use(express.static('public'));

// Routes
app.use('/', csvProcessingRoutes);  // This handles both /api/* and /* routes

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Handle favicon requests
app.get('/favicon.ico', (req, res) => {
  res.status(204).send(); // No content
});

// Start server
app.listen(PORT, () => {
  console.log('🏠 Insurance Item Pricing System');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Web Interface: http://localhost:${PORT}`);
  console.log(`💊 Health Check: http://localhost:${PORT}/health`);
  console.log('📊 Ready to process insurance inventory CSV files!');
  console.log('⚠️  CSP disabled for development');
});