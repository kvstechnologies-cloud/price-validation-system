const express = require('express');
const ProductValidator = require('../models/ProductValidator');

const router = express.Router();
const validator = new ProductValidator();

// Main product validation endpoint
router.post('/validate', async (req, res) => {
  try {
    const { 
      product, 
      minPrice, 
      maxPrice, 
      operator = 'between' 
    } = req.body;

    // Validation
    if (!product || product.trim().length === 0) {
      return res.status(400).json({
        error: 'Product description is required',
        example: 'iPhone 15 Pro 128GB'
      });
    }

    if (minPrice && isNaN(parseFloat(minPrice))) {
      return res.status(400).json({
        error: 'minPrice must be a valid number'
      });
    }

    if (maxPrice && isNaN(parseFloat(maxPrice))) {
      return res.status(400).json({
        error: 'maxPrice must be a valid number'
      });
    }

    const results = await validator.validateProduct(
      product.trim(),
      minPrice ? parseFloat(minPrice) : null,
      maxPrice ? parseFloat(maxPrice) : null,
      operator
    );

    res.json(results);

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Get supported retailers
router.get('/retailers', (req, res) => {
  res.json({
    trustedRetailers: validator.trustedRetailers,
    total: validator.trustedRetailers.length
  });
});

// Test endpoint
router.get('/test', (req, res) => {
  res.json({
    message: 'API is working',
    timestamp: new Date().toISOString(),
    endpoints: {
      validate: 'POST /api/validate',
      retailers: 'GET /api/retailers',
      test: 'GET /api/test'
    }
  });
});

module.exports = router;