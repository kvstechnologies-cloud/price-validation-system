const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

class ProductValidator {
  constructor() {
    this.cache = new NodeCache({ stdTTL: process.env.CACHE_TTL_SECONDS || 3600 });
    
    this.trustedRetailers = [
      'amazon.com', 'target.com', 'walmart.com', 'bestbuy.com',
      'homedepot.com', 'lowes.com', 'costco.com', 'newegg.com',
      'bhphotovideo.com', 'adorama.com', 'rei.com', 'macys.com',
      'nordstrom.com', 'zappos.com', 'wayfair.com', 'overstock.com',
      'samsclub.com', 'officedepot.com', 'staples.com', 'cabelas.com'
    ];
    
    this.categoryKeywords = {
      'Electronics': ['phone', 'laptop', 'computer', 'tablet', 'camera', 'tv', 'monitor', 'headphones', 'speaker'],
      'Home & Garden': ['furniture', 'decor', 'kitchen', 'bathroom', 'garden', 'outdoor', 'bedding', 'lighting'],
      'Clothing & Accessories': ['shirt', 'pants', 'dress', 'shoes', 'watch', 'jewelry', 'bag', 'hat'],
      'Sports & Outdoors': ['fitness', 'exercise', 'sports', 'outdoor', 'camping', 'hiking', 'bike', 'golf'],
      'Health & Beauty': ['skincare', 'makeup', 'health', 'supplements', 'personal care', 'beauty'],
      'Books & Media': ['book', 'ebook', 'dvd', 'cd', 'music', 'movie', 'game'],
      'Toys & Games': ['toy', 'game', 'puzzle', 'doll', 'action figure', 'board game', 'video game'],
      'Automotive': ['car', 'auto', 'vehicle', 'parts', 'accessories', 'tools', 'maintenance']
    };
  }

  // Main validation function
  async validateProduct(productDescription, minPrice = null, maxPrice = null, operator = 'between') {
    const cacheKey = `${productDescription}_${minPrice}_${maxPrice}_${operator}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached) {
      console.log('📋 Returning cached results');
      return cached;
    }

    try {
      console.log(`🔍 Validating: "${productDescription}"`);
      console.log(`💰 Price criteria: ${this.formatPriceCriteria(minPrice, maxPrice, operator)}`);

      // Step 1: Search for products
      const searchResults = await this.performEnhancedSearch(productDescription);
      
      // Step 2: Filter trusted retailers
      const trustedResults = this.filterTrustedRetailers(searchResults);
      
      // Step 3: Extract and validate product data
      const validatedProducts = await this.validateProductPrices(trustedResults, minPrice, maxPrice, operator);
      
      // Step 4: Format results
      const formattedResults = this.formatTableResults(validatedProducts);
      
      const response = {
        query: productDescription,
        priceCriteria: { min: minPrice, max: maxPrice, operator },
        totalFound: formattedResults.length,
        products: formattedResults,
        timestamp: new Date().toISOString(),
        searchTime: Date.now()
      };

      // Cache the results
      this.cache.set(cacheKey, response);
      
      return response;
      
    } catch (error) {
      console.error('❌ Validation failed:', error);
      return {
        error: 'Product validation failed',
        query: productDescription,
        details: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  // Enhanced search strategies
  async performEnhancedSearch(productDescription) {
    const searchQueries = [
      `"${productDescription}" site:amazon.com OR site:target.com OR site:walmart.com`,
      `${productDescription} model number`,
      `${productDescription} buy online price`,
      `"${productDescription}" official retailer`,
      `${productDescription} product specifications`
    ];

    const allResults = [];
    
    for (const query of searchQueries) {
      try {
        const results = await this.searchGoogle(query);
        allResults.push(...results);
        await this.delay(300); // Rate limiting
      } catch (error) {
        console.warn(`⚠️ Search failed for: ${query}`);
      }
    }

    return this.removeDuplicates(allResults);
  }

  // Google Custom Search
  async searchGoogle(query) {
    try {
      const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
        params: {
          key: process.env.GOOGLE_API_KEY,
          cx: process.env.GOOGLE_SEARCH_ENGINE_ID,
          q: query,
          num: 10,
          safe: 'active'
        },
        timeout: 10000
      });

      return response.data.items || [];
    } catch (error) {
      console.error('Google search error:', error.response?.data || error.message);
      return [];
    }
  }

  // Filter trusted retailers
  filterTrustedRetailers(searchResults) {
    return searchResults.filter(result => {
      const domain = this.extractDomain(result.link);
      return this.trustedRetailers.some(retailer => domain.includes(retailer));
    });
  }

  // Validate product prices
  async validateProductPrices(trustedResults, minPrice, maxPrice, operator) {
    const validProducts = [];
    
    for (const result of trustedResults.slice(0, 10)) { // Limit to first 10 results
      try {
        const productData = await this.extractProductData(result);
        
        if (productData && productData.price) {
          const numericPrice = this.extractNumericPrice(productData.price);
          
          if (this.isPriceValid(numericPrice, minPrice, maxPrice, operator)) {
            console.log(`✅ Valid product found: ${productData.price} at ${productData.source}`);
            validProducts.push(productData);
          }
        }
        
        await this.delay(1000); // Rate limiting
        
      } catch (error) {
        console.warn(`⚠️ Failed to extract data from ${result.link}`);
      }
    }
    
    return validProducts;
  }

  // Extract product data from page
  async extractProductData(searchResult) {
    try {
      const response = await axios.get(searchResult.link, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: 15000
      });

      const $ = cheerio.load(response.data);
      const domain = this.extractDomain(searchResult.link);
      
      return this.parseByRetailer($, domain, searchResult);
      
    } catch (error) {
      throw new Error(`Failed to fetch: ${error.message}`);
    }
  }

  // Parse by specific retailer
  parseByRetailer($, domain, searchResult) {
    const baseData = {
      url: searchResult.link,
      source: domain,
      pricer: 'AI-Enhanced'
    };

    if (domain.includes('amazon.com')) {
      return { ...baseData, ...this.parseAmazon($) };
    } else if (domain.includes('target.com')) {
      return { ...baseData, ...this.parseTarget($) };
    } else if (domain.includes('walmart.com')) {
      return { ...baseData, ...this.parseWalmart($) };
    } else if (domain.includes('bestbuy.com')) {
      return { ...baseData, ...this.parseBestBuy($) };
    } else {
      return { ...baseData, ...this.parseGeneric($) };
    }
  }

  // Amazon parser
  parseAmazon($) {
    return {
      price: this.findPrice($, [
        '#priceblock_dealprice', '#priceblock_ourprice', 
        '.a-price-whole', '.a-offscreen', '[data-asin-price]'
      ]),
      description: this.findText($, ['#productTitle', 'h1']),
      category: this.findText($, ['#wayfinding-breadcrumbs_feature_div', '.nav-breadcrumb']),
      subCategory: this.extractSubCategory($('#wayfinding-breadcrumbs_feature_div').text())
    };
  }

  // Target parser
  parseTarget($) {
    return {
      price: this.findPrice($, [
        '[data-test="product-price"]', '.Price-module__currentPrice___1gVuV'
      ]),
      description: this.findText($, ['[data-test="product-title"]', 'h1']),
      category: this.findText($, ['[data-test="breadcrumb"]', '.Breadcrumb']),
      subCategory: this.extractSubCategory($('[data-test="breadcrumb"]').text())
    };
  }

  // Walmart parser
  parseWalmart($) {
    return {
      price: this.findPrice($, [
        '[data-automation-id="product-price"]', '.notranslate'
      ]),
      description: this.findText($, ['[data-automation-id="product-title"]', 'h1']),
      category: this.findText($, ['.breadcrumb', '[data-testid="breadcrumb"]']),
      subCategory: this.extractSubCategory($('.breadcrumb').text())
    };
  }

  // Best Buy parser
  parseBestBuy($) {
    return {
      price: this.findPrice($, ['.sr-only:contains("current price")', '.pricing-price__range']),
      description: this.findText($, ['.sku-title', 'h1']),
      category: this.findText($, ['.breadcrumb', '.sr-only']),
      subCategory: this.extractSubCategory($('.breadcrumb').text())
    };
  }

  // Generic parser
  parseGeneric($) {
    return {
      price: this.findPrice($, [
        '.price', '.product-price', '[class*="price"]', '[data-price]'
      ]),
      description: this.findText($, [
        'h1', '.product-title', '[class*="title"]', '.product-name'
      ]),
      category: this.categorizeProduct($('title').text() + ' ' + $('h1').text()),
      subCategory: 'Unknown'
    };
  }

  // Helper functions
  findPrice($, selectors) {
    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length) {
        const text = element.text().trim();
        const price = this.extractPrice(text);
        if (price) return price;
      }
    }
    return null;
  }

  findText($, selectors) {
    for (const selector of selectors) {
      const text = $(selector).first().text().trim();
      if (text && text.length > 0) return text;
    }
    return 'Unknown';
  }

  extractPrice(text) {
    const match = text.match(/\$[\d,]+\.?\d*/);
    return match ? match[0] : null;
  }

  extractNumericPrice(priceString) {
    if (!priceString) return 0;
    return parseFloat(priceString.replace(/[$,]/g, ''));
  }

  isPriceValid(price, minPrice, maxPrice, operator) {
    switch (operator) {
      case 'less_than':
        return maxPrice ? price < maxPrice : true;
      case 'greater_than':
        return minPrice ? price > minPrice : true;
      case 'between':
        return (!minPrice || price >= minPrice) && (!maxPrice || price <= maxPrice);
      default:
        return true;
    }
  }

  categorizeProduct(text) {
    const lowerText = text.toLowerCase();
    for (const [category, keywords] of Object.entries(this.categoryKeywords)) {
      if (keywords.some(keyword => lowerText.includes(keyword))) {
        return category;
      }
    }
    return 'General';
  }

  extractSubCategory(breadcrumbText) {
    if (!breadcrumbText) return 'Unknown';
    const parts = breadcrumbText.split(/[>\/›]/).map(part => part.trim());
    return parts.length > 1 ? parts[parts.length - 2] : 'Unknown';
  }

  extractDomain(url) {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return 'unknown';
    }
  }

  removeDuplicates(results) {
    const seen = new Set();
    return results.filter(result => {
      if (seen.has(result.link)) return false;
      seen.add(result.link);
      return true;
    });
  }

  formatPriceCriteria(minPrice, maxPrice, operator) {
    switch (operator) {
      case 'less_than':
        return `Less than $${maxPrice}`;
      case 'greater_than':
        return `Greater than $${minPrice}`;
      case 'between':
        return `Between $${minPrice || 0} - $${maxPrice || '∞'}`;
      default:
        return 'Any price';
    }
  }

  formatTableResults(products) {
    return products.map(product => ({
      'Price': product.price || 'N/A',
      'Cat': product.category || 'Unknown',
      'Sub Cat': product.subCategory || 'Unknown', 
      'Source': product.source || 'Unknown',
      'URL': product.url || 'N/A',
      'Pricer': product.pricer || 'AI-Enhanced',
      'Description': product.description || 'No description available'
    }));
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = ProductValidator;