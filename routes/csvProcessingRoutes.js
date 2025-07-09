// routes/csvProcessingRoutes.js
const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const router = express.Router();

// Import your InsuranceItemPricer
const InsuranceItemPricer = require('../models/InsuranceItemPricer');

// Initialize the pricer instance
let insuranceItemPricer;
try {
  insuranceItemPricer = new InsuranceItemPricer();
  console.log('✅ InsuranceItemPricer initialized successfully');
} catch (error) {
  console.error('❌ Failed to initialize InsuranceItemPricer:', error.message);
  console.error('🚨 Make sure SERPAPI_KEY is set in your .env file');
}

// Configure multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// CSV Processing Route - matches your interface expectations
router.post('/api/process-csv', upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded' });
    }

    // Check if pricer is available
    if (!insuranceItemPricer) {
      return res.status(500).json({ error: 'Pricing service not available. Check SERPAPI_KEY configuration.' });
    }

    const tolerance = req.body.tolerance || 10; // Default 10% tolerance
    const startTime = Date.now();

    // Parse CSV file
    const csvText = req.file.buffer.toString('utf-8');
    const parseResult = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true
    });

    if (parseResult.errors.length > 0) {
      console.error('CSV parsing errors:', parseResult.errors);
    }

    const csvData = parseResult.data;
    console.log(`📊 Processing ${csvData.length} rows from CSV`);

    let successfulFinds = 0;
    let totalItems = 0;

    // Process each row in the CSV
    const processedRows = await Promise.all(
      csvData.map(async (row, index) => {
        try {
          // Skip empty rows
          if (!row['Item #']) {
            console.log(`⏭️ Skipping empty row ${index + 1}`);
            return null;
          }

          totalItems++;

          // Build comprehensive search query by combining multiple fields
          const searchParts = [
            row['Description'],           // Detailed product description
            row['Item Description'],      // Generic description  
            row['Brand or Manufacturer']  // Brand info
          ].filter(part => 
            part && 
            part.trim() !== '' && 
            part !== 'No Brand' &&       // Skip "No Brand" entries
            part !== '�'                 // Skip placeholder characters
          );

          const combinedQuery = searchParts.join(' ').trim();
          
          console.log(`🔧 DEBUG - Row ${row['Item #']} Search parts:`, searchParts);
          console.log(`🚀 Fast search for: "${combinedQuery}"`);

          // Skip if no meaningful search terms
          if (!combinedQuery) {
            console.log(`⚠️ No search terms for row ${row['Item #']}`);
            return {
              ...row,
              'Price': '',
              'Cat': '',
              'Sub Cat': '',
              'Source': '',
              'URL': '',
              'Pricer': 'Manual Validation Required',
              'Search Status': 'No Search Terms',
              'Search Query Used': combinedQuery || 'No valid search terms'
            };
          }

          // Get target price for price tolerance calculations
          const targetPrice = parseFloat(row['Cost to Replace Pre-Tax (each)']) || null;

          // Call the pricing service with the combined query
          const result = await insuranceItemPricer.findBestPrice(combinedQuery, targetPrice);

          if (result && result.found) {
            successfulFinds++;
            return {
              ...row,
              'Price': result.price,
              'Cat': result.category || 'HSW',
              'Sub Cat': result.subcategory || 'General',
              'Source': result.source,
              'URL': result.url,
              'Pricer': 'AI-Enhanced',
              'Search Status': 'Found',
              'Search Query Used': combinedQuery,
              'Description': result.description || row['Description'] || row['Item Description']
            };
          } else {
            return {
              ...row,
              'Price': '',
              'Cat': '',
              'Sub Cat': '',
              'Source': '',
              'URL': '',
              'Pricer': 'Manual Validation Required',
              'Search Status': 'No Results Found',
              'Search Query Used': combinedQuery
            };
          }
        } catch (error) {
          console.error(`❌ Error processing row ${index + 1}:`, error.message);
          return {
            ...row,
            'Price': '',
            'Cat': '',
            'Sub Cat': '',
            'Source': '',
            'URL': '',
            'Pricer': 'Error - Manual Review Required',
            'Search Status': 'Processing Error',
            'Search Query Used': 'Error during processing'
          };
        }
      })
    );

    // Filter out null entries (empty rows)
    const validProcessedRows = processedRows.filter(row => row !== null);

    // Calculate processing time and success rate
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    const successRate = totalItems > 0 ? Math.round((successfulFinds / totalItems) * 100) : 0;

    // Convert back to CSV
    const outputCsv = Papa.unparse(validProcessedRows);

    // Prepare response matching your interface expectations
    const response = {
      success: true,
      message: 'CSV processed successfully',
      summary: {
        totalItems,
        successfulFinds,
        successRate: `${successRate}%`,
        processingTime: `${processingTime}s`
      },
      results: validProcessedRows,
      outputCsv: outputCsv
    };

    console.log(`✅ Successfully processed ${totalItems} items (${successfulFinds} found, ${successRate}% success rate)`);

    res.json(response);

  } catch (error) {
    console.error('❌ CSV processing error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to process CSV file',
      message: error.message 
    });
  }
});

// Single item processing route - matches your interface
router.post('/api/process-item', async (req, res) => {
  try {
    const { itemDescription, brand, model, costToReplace, tolerance } = req.body;
    
    if (!itemDescription) {
      return res.status(400).json({ error: 'Item description is required' });
    }

    // Check if pricer is available
    if (!insuranceItemPricer) {
      return res.status(500).json({ error: 'Pricing service not available. Check SERPAPI_KEY configuration.' });
    }

    // Build search query combining all fields
    const searchParts = [
      itemDescription,
      brand,
      model
    ].filter(part => part && part.trim() !== '');

    const combinedQuery = searchParts.join(' ').trim();
    const targetPrice = costToReplace ? parseFloat(costToReplace) : null;

    console.log(`🔍 Single item test: "${combinedQuery}"`);
    
    const result = await insuranceItemPricer.findBestPrice(combinedQuery, targetPrice);
    
    let responseResult;
    
    if (result && result.found) {
      responseResult = {
        'Price': `$${result.price}`,
        'Cat': result.category || 'HSW',
        'Sub Cat': result.subcategory || 'General',
        'Source': result.source,
        'URL': result.url,
        'Pricer': 'AI-Enhanced',
        'Search Status': 'Found',
        'Search Query Used': combinedQuery,
        'Description': result.description,
        'Item Description': itemDescription
      };
    } else {
      responseResult = {
        'Price': '',
        'Cat': '',
        'Sub Cat': '',
        'Source': '',
        'URL': '',
        'Pricer': 'Manual Validation Required',
        'Search Status': 'No Results Found',
        'Search Query Used': combinedQuery,
        'Item Description': itemDescription
      };
    }

    res.json({
      success: result && result.found,
      result: responseResult
    });

  } catch (error) {
    console.error('❌ Single item test error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to process item: ' + error.message 
    });
  }
});

// Keep the original routes for backward compatibility
router.post('/process-csv', upload.single('csvFile'), async (req, res) => {
  // This is for the original Insurance system that expects CSV download
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded' });
    }

    if (!insuranceItemPricer) {
      return res.status(500).json({ error: 'Pricing service not available. Check SERPAPI_KEY configuration.' });
    }

    // Parse CSV file
    const csvText = req.file.buffer.toString('utf-8');
    const parseResult = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true
    });

    const csvData = parseResult.data;
    console.log(`📊 Processing ${csvData.length} rows from CSV`);

    // Process each row
    const processedRows = await Promise.all(
      csvData.map(async (row, index) => {
        try {
          if (!row['Item #']) {
            return null;
          }

          const searchParts = [
            row['Description'],
            row['Item Description'],
            row['Brand or Manufacturer']
          ].filter(part => 
            part && 
            part.trim() !== '' && 
            part !== 'No Brand' &&
            part !== '�'
          );

          const combinedQuery = searchParts.join(' ').trim();
          
          if (!combinedQuery) {
            return {
              ...row,
              'Price': '',
              'Cat': '',
              'Sub Cat': '',
              'Source': '',
              'URL': '',
              'Pricer': 'Manual Validation Required',
              'Search Status': 'No Search Terms'
            };
          }

          const targetPrice = parseFloat(row['Cost to Replace Pre-Tax (each)']) || null;
          const result = await insuranceItemPricer.findBestPrice(combinedQuery, targetPrice);

          if (result && result.found) {
            return {
              ...row,
              'Price': result.price,
              'Cat': result.category || 'HSW',
              'Sub Cat': result.subcategory || 'General',
              'Source': result.source,
              'URL': result.url,
              'Pricer': 'AI-Enhanced',
              'Search Status': 'Found'
            };
          } else {
            return {
              ...row,
              'Price': '',
              'Cat': '',
              'Sub Cat': '',
              'Source': '',
              'URL': '',
              'Pricer': 'Manual Validation Required',
              'Search Status': 'No Results Found'
            };
          }
        } catch (error) {
          return {
            ...row,
            'Price': '',
            'Cat': '',
            'Sub Cat': '',
            'Source': '',
            'URL': '',
            'Pricer': 'Error - Manual Review Required',
            'Search Status': 'Processing Error'
          };
        }
      })
    );

    const validProcessedRows = processedRows.filter(row => row !== null);
    const outputCsv = Papa.unparse(validProcessedRows);

    // Send CSV file for download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=processed_inventory.csv');
    res.send(outputCsv);

  } catch (error) {
    console.error('❌ CSV processing error:', error);
    res.status(500).json({ error: 'Failed to process CSV file' });
  }
});

// Single item test route (original)
router.post('/single-item-test', async (req, res) => {
  try {
    const { query, targetPrice } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    if (!insuranceItemPricer) {
      return res.status(500).json({ error: 'Pricing service not available. Check SERPAPI_KEY configuration.' });
    }

    console.log(`🔍 Single item test: "${query}"`);
    
    const result = await insuranceItemPricer.findBestPrice(query, targetPrice);
    
    res.json(result);
  } catch (error) {
    console.error('❌ Single item test error:', error);
    res.status(500).json({ error: 'Failed to process item: ' + error.message });
  }
});

module.exports = router;