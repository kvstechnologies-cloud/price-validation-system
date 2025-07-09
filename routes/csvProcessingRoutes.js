// routes/csvProcessingRoutes.js
const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const XLSX = require('xlsx');
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

// Helper function to detect flexible column names
function detectColumns(headers) {
  const columnMap = {};
  
  headers.forEach(header => {
    const normalizedHeader = header.trim().toLowerCase();
    
    // Check for Description/Desc column (handles both variants)
    if (normalizedHeader === 'description' || normalizedHeader === 'desc') {
      columnMap.description = header;
    }
    
    // Other required columns
    if (normalizedHeader.includes('item') && normalizedHeader.includes('#')) {
      columnMap.itemNumber = header;
    }
    if (normalizedHeader.includes('item') && normalizedHeader.includes('description')) {
      columnMap.itemDescription = header;
    }
    if (normalizedHeader.includes('brand') || normalizedHeader.includes('manufacturer')) {
      columnMap.brand = header;
    }
    if (normalizedHeader.includes('cost') && normalizedHeader.includes('replace')) {
      columnMap.costToReplace = header;
    }
  });
  
  return columnMap;
}

// Helper function to parse different file types
function parseFileData(file) {
  if (file.originalname.endsWith('.xlsx') || file.originalname.endsWith('.xls')) {
    // Parse Excel file
    const workbook = XLSX.read(file.buffer, {
      cellStyles: true,
      cellFormulas: true,
      cellDates: true,
      cellNF: true,
      sheetStubs: true
    });
    
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    
    // Convert to JSON
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { 
      header: 1, 
      defval: "",
      raw: false 
    });
    
    if (jsonData.length < 2) {
      throw new Error('Excel file must contain at least a header row and one data row');
    }
    
    // Convert to object format with headers
    const headers = jsonData[0];
    const csvData = jsonData.slice(1).map(row => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] || '';
      });
      return obj;
    });
    
    return csvData;
  } else {
    // Parse CSV file
    const csvText = file.buffer.toString('utf-8');
    const parseResult = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true
    });
    
    if (parseResult.errors.length > 0) {
      console.error('CSV parsing errors:', parseResult.errors);
    }
    
    return parseResult.data;
  }
}

// CHANGE: Add delay helper function to avoid rate limiting
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// CSV Processing Route - Process ALL rows with better error handling
router.post('/api/process-csv', upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded' });
    }

    // Check if pricer is available
    if (!insuranceItemPricer) {
      return res.status(500).json({ error: 'Pricing service not available. Check SERPAPI_KEY configuration.' });
    }

    const tolerance = parseInt(req.body.tolerance) || 10;
    const startTime = Date.now();

    // Parse file data
    const csvData = parseFileData(req.file);
    console.log(`📊 Processing ${csvData.length} rows from ${req.file.originalname}`);

    // Detect column mappings flexibly
    const headers = Object.keys(csvData[0] || {});
    const columnMap = detectColumns(headers);
    console.log('🔧 Detected columns:', columnMap);

    let successfulFinds = 0;
    let totalItems = 0;
    let errorCount = 0;

    // CHANGE: Process rows sequentially to avoid rate limiting and ensure all rows are processed
    const processedRows = [];
    
    for (let index = 0; index < csvData.length; index++) {
      const row = csvData[index];
      
      try {
        // Skip empty rows
        if (!row['Item #']) {
          console.log(`⏭️ Skipping empty row ${index + 1}`);
          continue;
        }

        totalItems++;
        console.log(`📍 Processing item ${totalItems}/${csvData.length}: ${row['Item #']}`);

        // Build search query using detected columns
        const searchParts = [
          row[columnMap.description] || row['Description'] || row['Desc'],
          row['Item Description'],      
          row['Brand or Manufacturer']  
        ].filter(part => 
          part && 
          part.trim() !== '' && 
          part !== 'No Brand' &&       
          part !== '�'                 
        );

        const combinedQuery = searchParts.join(' ').trim();

        // Skip if no meaningful search terms
        if (!combinedQuery) {
          console.log(`⚠️ No search terms for row ${row['Item #']}`);
          processedRows.push({
            ...row,
            'Price': '',
            'Cat': '',
            'Sub Cat': '',
            'Source': '',
            'URL': '',
            'Pricer': 'Manual Validation Required',
            'Search Status': 'No Search Terms',
            'Search Query Used': combinedQuery || 'No valid search terms'
          });
          continue;
        }

       // Get target price for price tolerance calculations
       const targetPrice = parseFloat(row['Cost to Replace Pre-Tax (each)']) || null;

        // ADD DEBUGGING HERE - INSERT THESE LINES:
        if (row['Item #'] == 1) { // Debug first item specifically
          console.log(`🔧 DEBUG - Item #1 (Toilet Brush):`);
          console.log(`   Description: "${row['Item Description']}"`);
          console.log(`   Target Price: ${targetPrice}`);
          console.log(`   Tolerance: ${tolerance}%`);
          console.log(`   Search Query: "${combinedQuery}"`);
          console.log(`   Expected Range: $${targetPrice ? (targetPrice * (1 - tolerance/100)).toFixed(2) : 'N/A'} - $${targetPrice ? (targetPrice * (1 + tolerance/100)).toFixed(2) : 'N/A'}`);
        }

        // Call the pricing service
        const result = await insuranceItemPricer.findBestPrice(combinedQuery, targetPrice, tolerance);

        // ADD MORE DEBUGGING HERE:
        if (row['Item #'] == 1) { // Debug first item specifically
          console.log(`   Result Found: ${result ? result.found : 'null'}`);
          console.log(`   Result Price: ${result && result.found ? result.price : 'N/A'}`);
          console.log(`   ========================================`);
        }

        if (result && result.found) {
          successfulFinds++;
          processedRows.push({
            ...row,
            'Price': result.price,
            'Cat': result.category || 'HSW',
            'Sub Cat': result.subcategory || 'General',
            'Source': result.source,
            'URL': result.url,
            'Pricer': 'AI-Enhanced',
            'Search Status': 'Found',
            'Search Query Used': combinedQuery,
            'Description': result.description || row[columnMap.description] || row['Description'] || row['Desc'] || row['Item Description']
          });
        } else {
          processedRows.push({
            ...row,
            'Price': '',
            'Cat': '',
            'Sub Cat': '',
            'Source': '',
            'URL': '',
            'Pricer': 'Manual Validation Required',
            'Search Status': 'No Results Found',
            'Search Query Used': combinedQuery
          });
        }
        // CHANGE: Add delay between requests to avoid rate limiting
        if (index < csvData.length - 1) {
          await delay(300); // 300ms delay between requests
        }

      } catch (error) {
        console.error(`❌ Error processing row ${index + 1}:`, error.message);
        errorCount++;
        
        processedRows.push({
          ...row,
          'Price': '',
          'Cat': '',
          'Sub Cat': '',
          'Source': '',
          'URL': '',
          'Pricer': 'Error - Manual Review Required',
          'Search Status': 'Processing Error',
          'Search Query Used': 'Error during processing'
        });

        // Continue processing even if one item fails
        continue;
      }
    }

    // Calculate processing time and success rate
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    const successRate = totalItems > 0 ? Math.round((successfulFinds / totalItems) * 100) : 0;

    // Convert back to CSV
    const outputCsv = Papa.unparse(processedRows);

    // CHANGE: Enhanced response with more detailed statistics
    const response = {
      success: true,
      message: 'CSV processed successfully',
      summary: {
        totalItems,
        successfulFinds,
        errorCount,
        successRate: `${successRate}%`,
        processingTime: `${processingTime}s`,
        tolerance: `±${tolerance}%`,
        columnMappingUsed: columnMap,
        totalRowsProcessed: processedRows.length // CHANGE: Add total processed count
      },
      results: processedRows,
      outputCsv: outputCsv
    };

    console.log(`✅ Successfully processed ${totalItems} items (${successfulFinds} found, ${errorCount} errors, ${successRate}% success rate)`);

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
    const toleranceValue = tolerance ? parseInt(tolerance) : 10;

    console.log(`🔍 Single item test: "${combinedQuery}"`);
    
    const result = await insuranceItemPricer.findBestPrice(combinedQuery, targetPrice, toleranceValue);
    
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

    const csvData = parseFileData(req.file);
    console.log(`📊 Processing ${csvData.length} rows from CSV`);

    const headers = Object.keys(csvData[0] || {});
    const columnMap = detectColumns(headers);

    // CHANGE: Process sequentially for backward compatibility route too
    const processedRows = [];
    
    for (let index = 0; index < csvData.length; index++) {
      const row = csvData[index];
      
      try {
        if (!row['Item #']) {
          continue;
        }

        const searchParts = [
          row[columnMap.description] || row['Description'] || row['Desc'],
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
          processedRows.push({
            ...row,
            'Price': '',
            'Cat': '',
            'Sub Cat': '',
            'Source': '',
            'URL': '',
            'Pricer': 'Manual Validation Required',
            'Search Status': 'No Search Terms'
          });
          continue;
        }

        const targetPrice = parseFloat(row['Cost to Replace Pre-Tax (each)']) || null;
        const result = await insuranceItemPricer.findBestPrice(combinedQuery, targetPrice, 10);

        if (result && result.found) {
          processedRows.push({
            ...row,
            'Price': result.price,
            'Cat': result.category || 'HSW',
            'Sub Cat': result.subcategory || 'General',
            'Source': result.source,
            'URL': result.url,
            'Pricer': 'AI-Enhanced',
            'Search Status': 'Found'
          });
        } else {
          processedRows.push({
            ...row,
            'Price': '',
            'Cat': '',
            'Sub Cat': '',
            'Source': '',
            'URL': '',
            'Pricer': 'Manual Validation Required',
            'Search Status': 'No Results Found'
          });
        }

        // Add delay to avoid rate limiting
        if (index < csvData.length - 1) {
          await delay(300);
        }

      } catch (error) {
        processedRows.push({
          ...row,
          'Price': '',
          'Cat': '',
          'Sub Cat': '',
          'Source': '',
          'URL': '',
          'Pricer': 'Error - Manual Review Required',
          'Search Status': 'Processing Error'
        });
      }
    }

    const outputCsv = Papa.unparse(processedRows);

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
    
    const result = await insuranceItemPricer.findBestPrice(query, targetPrice, 10);
    
    res.json(result);
  } catch (error) {
    console.error('❌ Single item test error:', error);
    res.status(500).json({ error: 'Failed to process item: ' + error.message });
  }
});

module.exports = router;