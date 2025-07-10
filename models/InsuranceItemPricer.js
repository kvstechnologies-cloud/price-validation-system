const ProductValidator = require('./ProductValidator');
const DEBUG_LOGGING = false;
const axios = require('axios');

// Trusted retailer domains mapped to how they appear in SerpAPI source field
const trustedSources = {
  'amazon.com': ['Amazon', 'amazon.com', 'Amazon.com', 'Amazon.com - Seller'],
  'walmart.com': ['Walmart', 'walmart.com', 'Walmart - Seller', 'Walmart - RRX'],
  'target.com': ['Target', 'target.com'],
  'homedepot.com': ['Home Depot', 'homedepot.com', 'The Home Depot'],
  'lowes.com': ['Lowe\'s', 'lowes.com', 'Lowes'],
  'bestbuy.com': ['Best Buy', 'bestbuy.com', 'BestBuy'],
  'wayfair.com': ['Wayfair', 'wayfair.com'],
  'costco.com': ['Costco', 'costco.com'],
  'overstock.com': ['Overstock', 'overstock.com', 'Overstock.com']
};

class InsuranceItemPricer {
  constructor() {
    this.productValidator = new ProductValidator();
    this.serpApiKey = process.env.SERPAPI_KEY;
    this.searchEngine = 'google_shopping';
    
    // SMART-FAST: Pre-compile trusted sources for instant lookups
    this.trustedSourceMap = new Map();
    for (const [domain, aliases] of Object.entries(trustedSources)) {
      for (const alias of aliases) {
        this.trustedSourceMap.set(alias.toLowerCase(), domain);
      }
    }
    
    // SMART-FAST: Smart caching for duplicate queries (common in your Excel)
    this.queryCache = new Map();
    this.cacheHits = 0;
    
    if (!this.serpApiKey) {
      console.error('❌ SERPAPI_KEY environment variable is required');
      throw new Error('SERPAPI_KEY environment variable is required');
    }
  }

  // MAIN METHOD - This is what your routes call
  async findBestPrice(query, targetPrice = null, tolerance = 10) {
    try {
      // SMART-FAST: Check cache for duplicate queries (many similar items in Excel)
      const cacheKey = `${query.toLowerCase().substring(0, 50)}_${targetPrice}_${tolerance}`;
      if (this.queryCache.has(cacheKey)) {
        this.cacheHits++;
        const cached = this.queryCache.get(cacheKey);
        if (this.cacheHits % 10 === 0) {
          console.log(`💨 Cache hits: ${this.cacheHits} (saving time)`);
        }
        return cached;
      }
      
      console.log(`🔍 Finding best price for: "${query}"`);
      console.log(`💰 Target price: ${targetPrice ? '$' + targetPrice : 'None'}, Tolerance: ±${tolerance}%`);
      
      // Set price range based on target price and tolerance
      let minPrice = 0;
      let maxPrice = 99999;
      
      if (targetPrice) {
        const toleranceDecimal = tolerance / 100; // Convert percentage to decimal
        minPrice = Math.max(0, targetPrice * (1 - toleranceDecimal));
        maxPrice = targetPrice * (1 + toleranceDecimal);
        console.log(`🎯 Price filtering enabled: $${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)} (±${tolerance}% of $${targetPrice})`);
      }

      const result = await this.trySerpAPISmartFast(query, minPrice, maxPrice, targetPrice, tolerance);
      
      let response;
      if (result) {
        console.log(`✅ Final result: $${result.price} from ${result.source} (within range: ${targetPrice ? (result.price >= minPrice && result.price <= maxPrice) : 'N/A'})`);
        response = {
          found: true,
          price: result.price,
          source: result.source,
          url: result.url,
          category: 'HSW',
          subcategory: this.getSubCategory(result.description),
          description: result.description
        };
      } else {
        console.log(`❌ No results found within price range $${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)}`);
        response = {
          found: false,
          message: targetPrice ? 
            `No suitable matches found within ±${tolerance}% of $${targetPrice} ($${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)})` :
            'No suitable matches found'
        };
      }
      
      // SMART-FAST: Cache result for future duplicate queries
      this.queryCache.set(cacheKey, response);
      
      // SMART-FAST: Limit cache size to prevent memory issues
      if (this.queryCache.size > 100) {
        const firstKey = this.queryCache.keys().next().value;
        this.queryCache.delete(firstKey);
      }
      
      return response;
      
    } catch (error) {
      console.error('❌ findBestPrice error:', error);
      return {
        found: false,
        error: error.message
      };
    }
  }

  sanitizeQuery(raw) {
    return raw
      .replace(/\s+/g, ' ')
      .replace(/["']/g, '')
      .trim();
  }

  getSubCategory(description = '') {
    const desc = description.toLowerCase();
    if (desc.includes('letter') && desc.includes('box')) return 'Letter Box /HSW';
    if (desc.includes('fan') && desc.includes('tower')) return 'Fans /HSW';
    if (desc.includes('dehumidifier')) return 'Dehumidifier /HSW';
    if (desc.includes('window') && desc.includes('ac')) return 'Window AC /HSW';
    if (desc.includes('toilet') && desc.includes('brush')) return 'Bathroom Accessories /HSW';
    return 'Other /HSW';
  }

  // SMART-FAST: Ultra-fast trusted source lookup
  isTrustedSourceFast(sourceField) {
    if (!sourceField) return null;
    
    const sourceLower = sourceField.toLowerCase();
    
    // Direct map lookup first (fastest)
    const direct = this.trustedSourceMap.get(sourceLower);
    if (direct) return direct;
    
    // Fast contains check for partial matches
    if (sourceLower.includes('amazon')) return 'amazon.com';
    if (sourceLower.includes('walmart')) return 'walmart.com';
    if (sourceLower.includes('target')) return 'target.com';
    if (sourceLower.includes('home depot') || sourceLower.includes('homedepot')) return 'homedepot.com';
    if (sourceLower.includes('lowe')) return 'lowes.com';
    if (sourceLower.includes('best buy') || sourceLower.includes('bestbuy')) return 'bestbuy.com';
    if (sourceLower.includes('wayfair')) return 'wayfair.com';
    if (sourceLower.includes('costco')) return 'costco.com';
    if (sourceLower.includes('overstock')) return 'overstock.com';
    
    return null;
  }

  // Keep original method for backwards compatibility
  isTrustedSource(sourceField) {
    return this.isTrustedSourceFast(sourceField);
  }

  getDirectUrl(result) {
    // Check for direct Amazon product link with any ASIN
    if (result.link && result.link.includes('amazon.com/') && result.link.includes('/dp/')) {
      return result.link;
    }
    
    // Extract from Google redirect
    if (result.link && result.link.includes('google.com/aclk')) {
      try {
        const url = new URL(result.link);
        const adurl = url.searchParams.get('adurl');
        if (adurl && adurl.includes('amazon.com')) {
          return decodeURIComponent(adurl);
        }
      } catch (e) {
        // Continue to fallbacks
      }
    }
    
    // Use product_link as fallback
    if (result.product_link) {
      return result.product_link;
    }
    
    return result.link || 'Manual Validation Required';
  }

  // OPTIMIZED: Calculate how close a price is to target (lower score = better)
  calculatePriceScore(price, targetPrice, tolerance) {
    if (!targetPrice) {
      return price; // CHANGE: Prioritize lower prices when no target
    }
    
    const toleranceAmount = targetPrice * (tolerance / 100);
    const minPrice = targetPrice - toleranceAmount;
    const maxPrice = targetPrice + toleranceAmount;
    
    if (price >= minPrice && price <= maxPrice) {
      // CHANGE: Within range - prioritize lower prices
      return price;
    } else {
      // Outside tolerance - very high penalty to exclude these
      return 999999;
    }
  }

  async trySerpAPISmartFast(query, min = 0, max = 99999, targetPrice = null, tolerance = 10) {
    const sanitized = this.sanitizeQuery(query);
    
    // Strategy 1: Start with best query first
    console.log(`🚀 Smart-fast search for: "${sanitized}"`);
    
    let candidates = await this.performSearchSmartFast(sanitized, min, max, targetPrice, tolerance);
    
    // SMART-FAST: More flexible price filtering - allow some items outside range
    if (targetPrice && min > 0 && max < 99999) {
      const originalCount = candidates.length;
      const withinRangeCandidates = candidates.filter(c => c.price >= min && c.price <= max);
      const closeToRangeCandidates = candidates.filter(c => {
        const tolerance20 = targetPrice * 0.2; // 20% tolerance
        return c.price >= (targetPrice - tolerance20) && c.price <= (targetPrice + tolerance20);
      });
      
      console.log(`🎯 Price filtering: ${originalCount} total -> ${withinRangeCandidates.length} within range -> ${closeToRangeCandidates.length} within 20%`);
      
      // First try: exact range matches
      if (withinRangeCandidates.length > 0) {
        const bestMatch = this.selectBestMatchSmartFast(withinRangeCandidates, targetPrice, min, max);
        if (bestMatch) {
          console.log(`✅ Found exact range match: $${bestMatch.price}`);
          return {
            price: bestMatch.price,
            source: bestMatch.source,
            url: bestMatch.url,
            description: bestMatch.description
          };
        }
      }
      
      // Second try: close to range matches (prevents too many "not found")
      if (closeToRangeCandidates.length > 0) {
        const bestMatch = this.selectBestMatchSmartFast(closeToRangeCandidates, targetPrice, min, max);
        if (bestMatch) {
          console.log(`✅ Found close range match: $${bestMatch.price}`);
          return {
            price: bestMatch.price,
            source: bestMatch.source,
            url: bestMatch.url,
            description: bestMatch.description
          };
        }
      }
    } else {
      // No price filtering - use existing logic
      if (candidates.length > 0) {
        const perfectMatches = candidates.filter(c => c.isInRange && c.isAmazon);
        const goodMatches = candidates.filter(c => c.isInRange);
        
        if (perfectMatches.length > 0 || goodMatches.length > 0) {
          console.log(`✅ Found good matches on first try!`);
          const bestMatch = this.selectBestMatchSmartFast(candidates, targetPrice, min, max);
          
          if (bestMatch) {
            return {
              price: bestMatch.price,
              source: bestMatch.source,
              url: bestMatch.url,
              description: bestMatch.description
            };
          }
        }
      }
    }

    // Strategy 2: Try TWO alternative searches (not just one)
    console.log(`🔄 Trying alternative searches...`);
    
    const alternativeQueries = [
      sanitized.replace(/\b(new|mail box|postal box|heavy duty|security)\b/gi, '').trim(),
      sanitized.split(' ').slice(0, 5).join(' '), // Keep 5 words instead of 4
      sanitized.split(' ').slice(0, 3).join(' ')  // Also try 3 words
    ];

    for (const altQuery of alternativeQueries) {
      if (altQuery.length < 5 || altQuery === sanitized) continue;
      
      console.log(`🔍 Trying: "${altQuery}"`);
      
      let altCandidates = await this.performSearchSmartFast(altQuery, min, max, targetPrice, tolerance);
      
      // Apply more flexible price filtering for alternative searches
      if (targetPrice && min > 0 && max < 99999) {
        const withinRange = altCandidates.filter(c => c.price >= min && c.price <= max);
        const closeToRange = altCandidates.filter(c => {
          const tolerance20 = targetPrice * 0.2;
          return c.price >= (targetPrice - tolerance20) && c.price <= (targetPrice + tolerance20);
        });
        
        // Try exact range first, then close range
        const candidatesToUse = withinRange.length > 0 ? withinRange : closeToRange;
        
        if (candidatesToUse.length > 0) {
          const bestMatch = this.selectBestMatchSmartFast(candidatesToUse, targetPrice, min, max);
          if (bestMatch) {
            console.log(`✅ Found alternative match: $${bestMatch.price}`);
            return {
              price: bestMatch.price,
              source: bestMatch.source,
              url: bestMatch.url,
              description: bestMatch.description
            };
          }
        }
      } else {
        candidates.push(...altCandidates.map(c => ({...c, strategy: 'Alternative'})));
      }
      
      // SMART-FAST: Small delay between alternative searches
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Early exit conditions (same as before)
      if (targetPrice && altCandidates.length > 0) {
        const withinRangeMatches = altCandidates.filter(c => c.price >= min && c.price <= max);
        if (withinRangeMatches.length > 0) {
          console.log(`✅ Found matches within price range, stopping search`);
          break;
        }
      } else {
        const amazonMatches = altCandidates.filter(c => c.isAmazon && c.isInRange);
        if (amazonMatches.length > 0) {
          console.log(`✅ Found Amazon matches, stopping search`);
          break;
        }
      }
    }

    if (candidates.length === 0) {
      console.log('🚫 No candidates found.');
      return null;
    }

    // Final selection - prioritize price range compliance
    const bestMatch = this.selectBestMatchSmartFast(candidates, targetPrice, min, max);
    
    if (bestMatch) {
      console.log(`✅ Selected best match: $${bestMatch.price} from ${bestMatch.source}`);
      return {
        price: bestMatch.price,
        source: bestMatch.source,
        url: bestMatch.url,
        description: bestMatch.description
      };
    }

    console.log('❌ No suitable matches found after ranking.');
    return null;
  }

  async performSearchSmartFast(query, min, max, targetPrice, tolerance = 10) {
    const serpUrl = `https://serpapi.com/search.json?engine=${this.searchEngine}&q=${encodeURIComponent(query)}&api_key=${this.serpApiKey}&num=25&gl=us&hl=en`;

    try {
      // SMART-FAST: 5-second timeout (not 3s) - better success rate
      const serpResponse = await axios.get(serpUrl, { timeout: 5000 });
      const results = (serpResponse.data.shopping_results || []).slice(0, 25);
      
      if (!results.length) {
        return [];
      }

      console.log(`📦 Found ${results.length} results`);

      const candidates = [];

      for (const r of results) {
        const price = parseFloat(r.extracted_price || 0);
        const sourceField = r.source || '';
        const trustedDomain = this.isTrustedSourceFast(sourceField);

        if (trustedDomain && price > 0) {
          const priceScore = this.calculatePriceScore(price, targetPrice, tolerance);
          const isInRange = price >= min && price <= max;
          const isAmazon = trustedDomain === 'amazon.com';

          candidates.push({
            price,
            source: trustedDomain,
            url: this.getDirectUrl(r),
            description: r.title || '',
            priceScore,
            isInRange,
            isAmazon,
            sourceField
          });
          
          // SMART-FAST: Process more candidates for better quality
          if (candidates.length >= 20) {
            console.log(`⚡ Processing ${candidates.length} candidates`);
            break;
          }
        }
      }

      return candidates;

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        console.log(`⏱️ Timeout (5s): "${query.substring(0, 20)}..."`);
      } else {
        console.error('❌ SerpAPI error:', err.message);
      }
      return [];
    }
  }

  selectBestMatchSmartFast(candidates, targetPrice, min, max) {
    console.log(`📊 Smart-fast ranking ${candidates.length} candidates`);
    
    // Quick deduplication
    const uniqueCandidates = [];
    const seen = new Set();
    
    for (const candidate of candidates) {
      const key = `${candidate.price}-${candidate.source}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueCandidates.push(candidate);
      }
    }

    if (uniqueCandidates.length === 0) return null;

    // SMART-FAST: More flexible selection logic
    if (targetPrice) {
      // First priority: items within the target price range
      const withinRangeMatches = uniqueCandidates.filter(c => c.price >= min && c.price <= max);
      
      if (withinRangeMatches.length > 0) {
        console.log(`🎯 Found ${withinRangeMatches.length} matches within price range`);
        
        // Sort by lowest price first, then prefer Amazon
        withinRangeMatches.sort((a, b) => {
          if (Math.abs(a.price - b.price) < 1) {
            // Prices are very close, prefer Amazon
            if (a.isAmazon && !b.isAmazon) return -1;
            if (!a.isAmazon && b.isAmazon) return 1;
          }
          return a.price - b.price; // Lower price wins
        });
        
        const bestMatch = withinRangeMatches[0];
        console.log(`🏆 Best match: $${bestMatch.price} from ${bestMatch.source} (Within Range)`);
        return bestMatch;
      } else {
        // SMART-FAST: If no exact matches, try close matches (within 20%)
        const tolerance20 = targetPrice * 0.2;
        const closeMatches = uniqueCandidates.filter(c => 
          c.price >= (targetPrice - tolerance20) && c.price <= (targetPrice + tolerance20)
        );
        
        if (closeMatches.length > 0) {
          closeMatches.sort((a, b) => a.price - b.price);
          const bestMatch = closeMatches[0];
          console.log(`🏆 Best close match: $${bestMatch.price} from ${bestMatch.source} (Close to Range)`);
          return bestMatch;
        }
        
        console.log(`❌ No matches found within expanded price range`);
        return null;
      }
    }

    // Original logic for when no target price is set
    const perfectMatches = uniqueCandidates.filter(c => c.isInRange && c.isAmazon);
    const inRangeMatches = uniqueCandidates.filter(c => c.isInRange);
    const amazonMatches = uniqueCandidates.filter(c => c.isAmazon);

    let selectedTier = [];
    let tierName = '';
    
    if (perfectMatches.length > 0) {
      selectedTier = perfectMatches;
      tierName = 'Amazon + In Range';
    } else if (inRangeMatches.length > 0) {
      selectedTier = inRangeMatches;
      tierName = 'In Range';
    } else if (amazonMatches.length > 0) {
      selectedTier = amazonMatches;
      tierName = 'Amazon (Outside Range)';
    } else {
      selectedTier = uniqueCandidates;
      tierName = 'Any Trusted';
    }

    // Sort by lowest price first
    selectedTier.sort((a, b) => a.price - b.price);

    const bestMatch = selectedTier[0];
    console.log(`🎯 Best match: $${bestMatch.price} from ${bestMatch.source} (${tierName})`);

    return bestMatch;
  }
}

module.exports = InsuranceItemPricer;