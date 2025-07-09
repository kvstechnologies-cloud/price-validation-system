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
  async findBestPrice(query, targetPrice = null) {
    try {
      console.log(`🔍 Finding best price for: "${query}"`);
      
      // Set price range based on target price
      let minPrice = 0;
      let maxPrice = 99999;
      
      if (targetPrice) {
        const tolerance = 0.20; // 20% tolerance
        minPrice = Math.max(0, targetPrice * (1 - tolerance));
        maxPrice = targetPrice * (1 + tolerance);
      }

      const result = await this.trySerpAPIUltraFast(query, minPrice, maxPrice, targetPrice);
      
      if (result) {
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
        return {
          found: false,
          message: 'No suitable matches found'
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
      // Perfect match within tolerance
      return Math.abs(price - targetPrice);
    } else {
      // Outside tolerance - higher penalty
      return Math.abs(price - targetPrice) + 1000;
    }
  }

  async trySerpAPIUltraFast(query, min = 0, max = 99999, targetPrice = null) {
    const sanitized = this.sanitizeQuery(query);
    
    // Strategy 1: Start with best query first
    console.log(`🚀 Fast search for: "${sanitized}"`);
    
    let candidates = await this.performSearch(sanitized, min, max, targetPrice);
    
    // If we find good results immediately, use them
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

    // Strategy 2: Only try alternatives if first search wasn't good enough
    console.log(`🔄 Trying alternative searches...`);
    
    const alternativeQueries = [
      sanitized.replace(/\b(new|mail box|postal box|heavy duty|security)\b/gi, '').trim(),
      sanitized.split(' ').slice(0, 6).join(' ')
    ];

    for (const altQuery of alternativeQueries) {
      if (altQuery.length < 5 || altQuery === sanitized) continue;
      
      console.log(`🔍 Trying: "${altQuery}"`);
      
      const altCandidates = await this.performSearch(altQuery, min, max, targetPrice);
      candidates.push(...altCandidates.map(c => ({...c, strategy: 'Alternative'})));
      
      // Short delay
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // If we found Amazon matches, stop searching
      const amazonMatches = altCandidates.filter(c => c.isAmazon && c.isInRange);
      if (amazonMatches.length > 0) {
        console.log(`✅ Found Amazon matches, stopping search`);
        break;
      }
    }

    if (candidates.length === 0) {
      console.log('🚫 No candidates found.');
      return null;
    }

    // Smart ranking system
    const bestMatch = this.selectBestMatch(candidates, targetPrice, min, max);
    
    if (bestMatch) {
      console.log(`✅ Selected best match: ${bestMatch.price} from ${bestMatch.source}`);
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

  async performSearch(query, min, max, targetPrice) {
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
          const priceScore = targetPrice ? 
            this.calculatePriceScore(price, targetPrice, 15) : 
            Math.abs(price - ((min + max) / 2));

          candidates.push({
            price,
            source: trustedDomain,
            url: this.getDirectUrl(r),
            description: r.title || '',
            priceScore,
            isInRange: price >= min && price <= max,
            isAmazon: trustedDomain === 'amazon.com',
            sourceField
          });
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

    // Quick tier selection
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