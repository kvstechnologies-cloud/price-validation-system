// routes/csvProcessingRoutes.js
const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const XLSX = require('xlsx');
const DEBUG_LOGGING = false;

const router = express.Router();

// Import your InsuranceItemPricer
const InsuranceItemPricer = require('../models/OptimizedInsuranceItemPricer');

// Initialize the pricer instance
let insuranceItemPricer;
try {
  insuranceItemPricer = new InsuranceItemPricer();
if (DEBUG_LOGGING) console.log('✅ InsuranceItemPricer initialized successfully');
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

// SAFE-FAST: Smart target price estimation with caching
const priceEstimateCache = new Map();
function getSmartTargetPrice(description, itemDescription) {
  const query = (description || itemDescription || '').toLowerCase();
  const cacheKey = query.substring(0, 30); // Cache by first 30 chars
  
  if (priceEstimateCache.has(cacheKey)) {
    return priceEstimateCache.get(cacheKey);
  }
  
  let price = 30; // Default
  
  // Smart keyword matching
  if (query.includes('toilet') && query.includes('brush')) price = 15;
  else if (query.includes('shower') && query.includes('curtain')) price = 25;
  else if (query.includes('step') && query.includes('stool')) price = 35;
  else if (query.includes('personal care') || query.includes('bulk')) price = 50;
  else if (query.includes('shirt') || query.includes('t-shirt')) price = 20;
  else if (query.includes('shorts') || query.includes('pants')) price = 25;
  else if (query.includes('jacket') || query.includes('coat')) price = 60;
  else if (query.includes('bag') || query.includes('purse')) price = 40;
  else if (query.includes('vacuum')) price = 80;
  else if (query.includes('fan')) price = 50;
  else if (query.includes('mattress') || query.includes('bed')) price = 150;
  
  priceEstimateCache.set(cacheKey, price);
  return price;
}

// SAFE-FAST: Smart query building with priority (BETTER QUALITY)
function buildOptimalQuery(row, columnMap) {
  // Priority 1: Use Desc field if it's detailed and meaningful
  const desc = row['Desc'];
  if (desc && desc.trim() && desc.length > 15 && desc !== '1' && desc !== 'EMPTY' && !desc.includes('�')) {
    return { query: desc.trim(), strategy: 'Desc Field' };
  }
  
  // Priority 2: Use Item Description
  const itemDesc = row['Item Description'];
  if (itemDesc && itemDesc.trim()) {
    return { query: itemDesc.trim(), strategy: 'Item Description' };
  }
  
  // Priority 3: Combine Brand + Item Description if available
  const brand = row['Brand or Manufacturer'];
  if (brand && brand.trim() && brand.trim() !== ' ' && itemDesc) {
    return { query: `${brand.trim()} ${itemDesc.trim()}`, strategy: 'Brand + Item' };
  }
  
  return { query: null, strategy: 'No Valid Terms' };
}

// SAFE-FAST: Should we skip this item to save time?
function shouldSkipItem(row) {
  const desc = (row['Item Description'] || '').toLowerCase();
  const detailedDesc = (row['Desc'] || '').toLowerCase();
  
  // Skip obvious bulk/generic items that are hard to price
  if (desc.includes('bulk personal care') || desc.includes('misc') || desc.includes('various')) {
    return true;
  }
  
  // Skip if no meaningful description at all
  if (!desc && (!detailedDesc || detailedDesc.length < 5)) {
    return true;
  }
  
  return false;
}

// SAFE-FAST: Add delay helper function
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// CSV Processing Route - Process ALL rows with SAFE-FAST optimizations
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
if (DEBUG_LOGGING) console.log(`🚀 SAFE-FAST processing ${csvData.length} rows from ${req.file.originalname}`);

    // Detect column mappings flexibly
    const headers = Object.keys(csvData[0] || {});
    const columnMap = detectColumns(headers);
if (DEBUG_LOGGING) console.log('🔧 Detected columns:', columnMap);

    let successfulFinds = 0;
    let totalItems = 0;
    let errorCount = 0;
    let withinRangeCount = 0;
    let skippedItems = 0; // SAFE-FAST: Track skipped items

    // SAFE-FAST: Process rows with optimizations but maintain quality
    const processedRows = [];
    
    for (let index = 0; index < csvData.length; index++) {
      const row = csvData[index];
      
      try {
        // Skip empty rows
        if (!row['Item #']) {
if (DEBUG_LOGGING) console.log(`⏭️ Skipping empty row ${index + 1}`);
          continue;
        }

        totalItems++;
        
        // SAFE-FAST: Optimized logging frequency
        if (totalItems % 20 === 0 || totalItems <= 3) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = (totalItems / elapsed).toFixed(1);
          const eta = Math.round((csvData.length - totalItems) / parseFloat(rate));
if (DEBUG_LOGGING) console.log(`⚡ ${totalItems}/${csvData.length} | ${rate}/s | ETA: ${eta}s | Success: ${((successfulFinds/totalItems)*100).toFixed(1)}% | Cache: ${insuranceItemPricer.cacheHits}`);
        }

        // SAFE-FAST: Smart target price calculation with caching
        let targetPrice = parseFloat(row['Cost to Replace Pre-Tax (each)']?.toString().replace(/[$,\s]/g, ''));
        
        if (!targetPrice || isNaN(targetPrice)) {
          targetPrice = getSmartTargetPrice(row['Desc'], row['Item Description']);
        }

        // SAFE-FAST: Check if we should skip this item (saves time on impossible items)
        if (shouldSkipItem(row)) {
          skippedItems++;
if (DEBUG_LOGGING) console.log(`⏭️ Skipping difficult item ${row['Item #']}: "${row['Item Description']}"`);
          processedRows.push({
            ...row,
            'Price': '',
            'Cat': '',
            'Sub Cat': '',
            'Source': '',
            'URL': '',
            'Pricer': 'Manual Validation Required',
                                    'Query Strategy': 'Skipped'
          });
          continue;
        }

        // SAFE-FAST: Build optimal search query
        const queryResult = buildOptimalQuery(row, columnMap);

        // Skip if no meaningful search terms
        if (!queryResult.query) {
if (DEBUG_LOGGING) console.log(`⚠️ No search terms for row ${row['Item #']}`);
          processedRows.push({
            ...row,
            'Price': '',
            'Cat': '',
            'Sub Cat': '',
            'Source': '',
            'URL': '',
            'Pricer': 'Manual Validation Required',
                                    'Query Strategy': 'No Valid Terms'
          });
          continue;
        }

       // ADD DEBUGGING HERE - INSERT THESE LINES:
       if (row['Item #'] == 1) { // Debug first item specifically
if (DEBUG_LOGGING) console.log(`🔧 DEBUG - Item #1 (Toilet Brush):`);
if (DEBUG_LOGGING) console.log(`   Description: "${row['Item Description']}"`);
if (DEBUG_LOGGING) console.log(`   Target Price: ${targetPrice}`);
if (DEBUG_LOGGING) console.log(`   Tolerance: ${tolerance}%`);
if (DEBUG_LOGGING) console.log(`   Search Query: "${queryResult.query}"`);
if (DEBUG_LOGGING) console.log(`   Expected Range: ${targetPrice ? (targetPrice * (1 - tolerance/100)).toFixed(2) : 'N/A'} - ${targetPrice ? (targetPrice * (1 + tolerance/100)).toFixed(2) : 'N/A'}`);
       }

        // Call the pricing service
        const result = await insuranceItemPricer.findBestPrice(queryResult.query, targetPrice, tolerance);

        // ADD MORE DEBUGGING HERE:
        if (row['Item #'] == 1) { // Debug first item specifically
if (DEBUG_LOGGING) console.log(`   Result Found: ${result ? result.found : 'null'}`);
if (DEBUG_LOGGING) console.log(`   Result Price: ${result && result.found ? result.price : 'N/A'}`);
if (DEBUG_LOGGING) console.log(`   ========================================`);
        }

        if (result && result.found) {
          successfulFinds++;
          
          // Calculate if result is within price range
          const minPrice = targetPrice * (1 - tolerance/100);
          const maxPrice = targetPrice * (1 + tolerance/100);
          const isWithinRange = result.price >= minPrice && result.price <= maxPrice;
          
          if (isWithinRange) withinRangeCount++;
          
          processedRows.push({
            ...row,
            'Price': result.price,
            'Cat': result.category || 'HSW',
            'Sub Cat': result.subcategory || 'General',
            'Source': result.source,
            'URL': result.url,
            'Pricer': 'AI-Enhanced',
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
                                                'Target Price Used': targetPrice
          });
        }
        
        // SAFE-FAST: Ultra-minimal delays with adaptive scaling
        if (index < csvData.length - 1) {
          const currentSuccessRate = successfulFinds / totalItems;
          const progressPercent = totalItems / csvData.length;
          
          let delayMs = 30; // Ultra-minimal base delay
          
          // Adaptive delay based on performance
          if (currentSuccessRate > 0.9) delayMs = 20;        // Blazing fast when very successful
          else if (currentSuccessRate > 0.8) delayMs = 30;   // Very fast when successful  
          else if (currentSuccessRate > 0.6) delayMs = 50;   // Normal when decent
          else if (currentSuccessRate < 0.5) delayMs = 80;   // Slower when struggling
          
          // Speed up significantly towards the end
          if (progressPercent > 0.9) delayMs = Math.max(15, delayMs * 0.5);
          else if (progressPercent > 0.8) delayMs = Math.max(20, delayMs * 0.7);
          
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
                    'Search Query Used': 'Error during processing'
        });

        // Continue processing even if one item fails
        continue;
      }
    }

    // Calculate processing time and success rate
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    const successRate = totalItems > 0 ? Math.round((successfulFinds / totalItems) * 100) : 0;
    const avgTimePerItem = totalItems > 0 ? (processingTime / totalItems).toFixed(2) : 0;
    const withinRangeRate = successfulFinds > 0 ? Math.round((withinRangeCount / successfulFinds) * 100) : 0;
    const itemsPerSecond = totalItems > 0 ? (totalItems / processingTime).toFixed(1) : 0;
    const cacheHitRate = totalItems > 0 ? Math.round((insuranceItemPricer.cacheHits / totalItems) * 100) : 0; // SAFE-FAST: Cache stats

    // Convert back to CSV
    const outputCsv = Papa.unparse(processedRows);

    // Enhanced response with SAFE-FAST statistics
    const response = {
      success: true,
      message: 'CSV processed successfully with SAFE-FAST optimization (1-2s per item)',
      summary: {
        totalItems,
        successfulFinds,
        errorCount,
        skippedItems, // SAFE-FAST: Report skipped items
        withinRangeCount,
        successRate: `${successRate}%`,
        withinRangeRate: `${withinRangeRate}%`,
        processingTime: `${processingTime}s`,
        averageTimePerItem: `${avgTimePerItem}s`,
        itemsPerSecond: `${itemsPerSecond}`,
        cacheHitRate: `${cacheHitRate}%`, // SAFE-FAST: Cache efficiency
        tolerance: `±${tolerance}%`,
        columnMappingUsed: columnMap,
        totalRowsProcessed: processedRows.length,
        performanceMode: 'SAFE-FAST: 1-2s per item with smart caching and query optimization'
      },
      results: processedRows,
      outputCsv: outputCsv
    };
if (DEBUG_LOGGING) console.log(`🎯 SAFE-FAST PROCESSING COMPLETE:`);
if (DEBUG_LOGGING) console.log(`   ⚡ ${totalItems} items in ${processingTime}s (${avgTimePerItem}s/item)`);
if (DEBUG_LOGGING) console.log(`   ✅ ${successfulFinds} found (${successRate}% success rate)`);
if (DEBUG_LOGGING) console.log(`   🎯 ${withinRangeCount} within range (${withinRangeRate}% accuracy)`);
if (DEBUG_LOGGING) console.log(`   ⏭️ ${skippedItems} skipped (bulk/generic items)`);
if (DEBUG_LOGGING) console.log(`   💨 ${insuranceItemPricer.cacheHits} cache hits (${cacheHitRate}% cache rate)`);
if (DEBUG_LOGGING) console.log(`   ❌ ${errorCount} errors`);
if (DEBUG_LOGGING) console.log(`   🚀 Rate: ${itemsPerSecond} items/second`);

    res.json(response);

  } catch (error) {
    console.error('❌ SAFE-FAST processing error:', error);
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

    // SAFE-FAST: Smart target price calculation
    let targetPrice = costToReplace ? parseFloat(costToReplace) : null;
    if (!targetPrice) {
      targetPrice = getSmartTargetPrice(itemDescription, itemDescription);
    }

    // Build search query combining all fields
    const searchParts = [
      itemDescription,
      brand,
      model
    ].filter(part => part && part.trim() !== '');

    const combinedQuery = searchParts.join(' ').trim();
    const toleranceValue = tolerance ? parseInt(tolerance) : 10;
if (DEBUG_LOGGING) console.log(`🔍 SAFE-FAST single item test: "${combinedQuery}"`);
    
    const result = await insuranceItemPricer.findBestPrice(combinedQuery, targetPrice, toleranceValue);
    
    let responseResult;
    
    if (result && result.found) {
      responseResult = {
        'Price': `${result.price}`,
        'Cat': result.category || 'HSW',
        'Sub Cat': result.subcategory || 'General',
        'Source': result.source,
        'URL': result.url,
        'Pricer': 'AI-Enhanced',
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
                                'Item Description': itemDescription
      };
    }

    res.json({
      success: result && result.found,
      result: responseResult
    });

  } catch (error) {
    console.error('❌ SAFE-FAST single item error:', error);
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
if (DEBUG_LOGGING) console.log(`📊 SAFE-FAST processing ${csvData.length} rows from CSV`);

    const headers = Object.keys(csvData[0] || {});
    const columnMap = detectColumns(headers);

    // SAFE-FAST: Process sequentially for backward compatibility route too
    const processedRows = [];
    
    for (let index = 0; index < csvData.length; index++) {
      const row = csvData[index];
      
      try {
        if (!row['Item #']) {
          continue;
        }

        // SAFE-FAST: Use new query building logic
        const queryResult = buildOptimalQuery(row, columnMap);
        
        if (!queryResult.query) {
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

        // SAFE-FAST: Smart target price calculation
        let targetPrice = parseFloat(row['Cost to Replace Pre-Tax (each)']?.toString().replace(/[$,\s]/g, ''));
        if (!targetPrice || isNaN(targetPrice)) {
          targetPrice = getSmartTargetPrice(row['Desc'], row['Item Description']);
        }

        const result = await insuranceItemPricer.findBestPrice(queryResult.query, targetPrice, 10);

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

        // SAFE-FAST: Minimal delay
        if (index < csvData.length - 1) {
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
    console.error('❌ SAFE-FAST CSV processing error:', error);
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
if (DEBUG_LOGGING) console.log(`🔍 SAFE-FAST single item test: "${query}"`);
    
    const result = await insuranceItemPricer.findBestPrice(query, targetPrice, 10);
    
    res.json(result);
  } catch (error) {
    console.error('❌ SAFE-FAST single item test error:', error);
    res.status(500).json({ error: 'Failed to process item: ' + error.message });
  }
});

module.exports = router;