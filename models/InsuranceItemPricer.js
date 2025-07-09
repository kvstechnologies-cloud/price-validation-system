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
    this.serpApiKey = process.env.SERPAPI_KEY;
    this.searchEngine = 'google_shopping';
    
    if (!this.serpApiKey) {
      console.error('❌ SERPAPI_KEY environment variable is required');
      throw new Error('SERPAPI_KEY environment variable is required');
    }
  }

  // MAIN METHOD - This is what your routes call
  async findBestPrice(query, targetPrice = null, tolerance = 10) {
    try {
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

      const result = await this.trySerpAPIUltraFast(query, minPrice, maxPrice, targetPrice, tolerance);
      
      if (result) {
        console.log(`✅ Final result: $${result.price} from ${result.source} (within range: ${targetPrice ? (result.price >= minPrice && result.price <= maxPrice) : 'N/A'})`);
        return {
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
        return {
          found: false,
          message: targetPrice ? 
            `No suitable matches found within ±${tolerance}% of $${targetPrice} ($${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)})` :
            'No suitable matches found'
        };
      }
      
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

  isTrustedSource(sourceField) {
    if (!sourceField) return null;
    
    const source = sourceField.toLowerCase();
    
    for (const [domain, aliases] of Object.entries(trustedSources)) {
      for (const alias of aliases) {
        if (source.includes(alias.toLowerCase())) {
          return domain;
        }
      }
    }
    return null;
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

  // Calculate how close a price is to target (lower score = better)
  calculatePriceScore(price, targetPrice, tolerance) {
    if (!targetPrice) {
      return Math.abs(price - 50); // Default target if none provided
    }
    
    const toleranceAmount = targetPrice * (tolerance / 100);
    const minPrice = targetPrice - toleranceAmount;
    const maxPrice = targetPrice + toleranceAmount;
    
    if (price >= minPrice && price <= maxPrice) {
      // Perfect match within tolerance - prioritize closer to target
      return Math.abs(price - targetPrice);
    } else {
      // Outside tolerance - very high penalty to exclude these
      return 999999;
    }
  }

  async trySerpAPIUltraFast(query, min = 0, max = 99999, targetPrice = null, tolerance = 10) {
    const sanitized = this.sanitizeQuery(query);
    
    // Strategy 1: Start with best query first
    console.log(`🚀 Fast search for: "${sanitized}"`);
    
    let candidates = await this.performSearch(sanitized, min, max, targetPrice, tolerance);
    
    // CRITICAL FIX: Apply strict price range filtering when target price is set
    if (targetPrice && min > 0 && max < 99999) {
      const originalCount = candidates.length;
      candidates = candidates.filter(c => {
        const withinRange = c.price >= min && c.price <= max;
        if (!withinRange) {
          console.log(`🚫 Filtered out: ${c.description} - $${c.price} (outside range $${min.toFixed(2)}-$${max.toFixed(2)})`);
        }
        return withinRange;
      });
      console.log(`🎯 Price filtering: ${originalCount} -> ${candidates.length} results within range`);
      
      // If we have good matches within range, return immediately
      if (candidates.length > 0) {
        const bestMatch = this.selectBestMatch(candidates, targetPrice, min, max);
        if (bestMatch && bestMatch.price >= min && bestMatch.price <= max) {
          console.log(`✅ Found match within price range on first try: $${bestMatch.price}`);
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
          const bestMatch = this.selectBestMatch(candidates, targetPrice, min, max);
          
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

    // Strategy 2: Only try alternatives if we need more results
    console.log(`🔄 Trying alternative searches...`);
    
    const alternativeQueries = [
      sanitized.replace(/\b(new|mail box|postal box|heavy duty|security)\b/gi, '').trim(),
      sanitized.split(' ').slice(0, 6).join(' ')
    ];

    for (const altQuery of alternativeQueries) {
      if (altQuery.length < 5 || altQuery === sanitized) continue;
      
      console.log(`🔍 Trying: "${altQuery}"`);
      
      let altCandidates = await this.performSearch(altQuery, min, max, targetPrice, tolerance);
      
      // Apply price range filtering for alternative searches too
      if (targetPrice && min > 0 && max < 99999) {
        const originalCount = altCandidates.length;
        altCandidates = altCandidates.filter(c => {
          const withinRange = c.price >= min && c.price <= max;
          if (!withinRange) {
            console.log(`🚫 Alt filtered: ${c.description} - $${c.price} (outside range)`);
          }
          return withinRange;
        });
        console.log(`🎯 Alternative search price filtering: ${originalCount} -> ${altCandidates.length} results`);
        
        // If we found matches within range, use them immediately
        if (altCandidates.length > 0) {
          const bestMatch = this.selectBestMatch(altCandidates, targetPrice, min, max);
          if (bestMatch && bestMatch.price >= min && bestMatch.price <= max) {
            console.log(`✅ Found alternative match within range: $${bestMatch.price}`);
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
      
      // Short delay
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // If we found matches within price range, stop searching
      if (targetPrice && altCandidates.length > 0) {
        const withinRangeMatches = altCandidates.filter(c => c.price >= min && c.price <= max);
        if (withinRangeMatches.length > 0) {
          console.log(`✅ Found matches within price range, stopping search`);
          break;
        }
      } else {
        // Original logic for non-price-filtered searches
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
    const bestMatch = this.selectBestMatch(candidates, targetPrice, min, max);
    
    if (bestMatch) {
      // Final check: if we have a target price, ensure the result is within range
      if (targetPrice && (bestMatch.price < min || bestMatch.price > max)) {
        console.log(`❌ Best match $${bestMatch.price} is outside required range $${min.toFixed(2)}-$${max.toFixed(2)}`);
        return null;
      }
      
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

  async performSearch(query, min, max, targetPrice, tolerance = 10) {
    const serpUrl = `https://serpapi.com/search.json?engine=${this.searchEngine}&q=${encodeURIComponent(query)}&api_key=${this.serpApiKey}&num=25&gl=us&hl=en`;

    try {
      const serpResponse = await axios.get(serpUrl, { timeout: 8000 });
      const results = (serpResponse.data.shopping_results || []).slice(0, 25);
      
      if (!results.length) {
        return [];
      }

      console.log(`📦 Found ${results.length} results`);

      const candidates = [];

      for (const r of results) {
        const price = parseFloat(r.extracted_price || 0);
        const sourceField = r.source || '';
        const trustedDomain = this.isTrustedSource(sourceField);

        if (trustedDomain && price > 0) {
          const priceScore = this.calculatePriceScore(price, targetPrice, tolerance);
          const isInRange = price >= min && price <= max;

          candidates.push({
            price,
            source: trustedDomain,
            url: this.getDirectUrl(r),
            description: r.title || '',
            priceScore,
            isInRange,
            isAmazon: trustedDomain === 'amazon.com',
            sourceField
          });
          
          // Log each candidate for debugging
          console.log(`   📋 ${trustedDomain}: $${price} "${r.title?.substring(0, 50)}..." (Score: ${priceScore}, InRange: ${isInRange})`);
        }
      }

      return candidates;

    } catch (err) {
      console.error('❌ SerpAPI error:', err.message);
      return [];
    }
  }

  selectBestMatch(candidates, targetPrice, min, max) {
    console.log(`📊 Ranking ${candidates.length} total candidates`);
    
    // Remove duplicates quickly
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

    // CRITICAL FIX: When target price is set, prioritize price range compliance above all else
    if (targetPrice) {
      // First priority: items within the target price range
      const withinRangeMatches = uniqueCandidates.filter(c => c.price >= min && c.price <= max);
      
      if (withinRangeMatches.length > 0) {
        console.log(`🎯 Found ${withinRangeMatches.length} matches within price range`);
        
        // Among within-range matches, prefer Amazon, then sort by closeness to target
        const amazonWithinRange = withinRangeMatches.filter(c => c.isAmazon);
        
        let selectedTier = amazonWithinRange.length > 0 ? amazonWithinRange : withinRangeMatches;
        selectedTier.sort((a, b) => a.priceScore - b.priceScore);
        
        const bestMatch = selectedTier[0];
        console.log(`🏆 Best match: $${bestMatch.price} from ${bestMatch.source} (Within Range + ${amazonWithinRange.length > 0 ? 'Amazon' : 'Other Retailer'})`);
        return bestMatch;
      } else {
        console.log(`❌ No matches found within required price range $${min.toFixed(2)}-$${max.toFixed(2)}`);
        return null; // Strict: if target price is set, must be within range
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

    // Sort by price score (closest to target)
    selectedTier.sort((a, b) => a.priceScore - b.priceScore);

    const bestMatch = selectedTier[0];
    console.log(`🎯 Best match: ${bestMatch.price} from ${bestMatch.source} (${tierName})`);

    return bestMatch;
  }
}

module.exports = InsuranceItemPricer;