// Utility functions for the Price Validation System

class HelperUtils {
  static formatPrice(price) {
    if (!price) return 'N/A';
    const numericPrice = parseFloat(price.toString().replace(/[$,]/g, ''));
    if (isNaN(numericPrice)) return 'N/A';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(numericPrice);
  }

  static extractModelNumber(description) {
    const patterns = [
      /\b[A-Z]{2,}\d{3,}\b/g,
      /\b\d{2,}[A-Z]{2,}\d+\b/g,
      /\b[A-Z]+\-\d+[A-Z]*\b/g,
      /\bModel[\s:]+([A-Z0-9\-]+)\b/gi
    ];
    for (const pattern of patterns) {
      const matches = description.match(pattern);
      if (matches && matches.length > 0) {
        return matches[0];
      }
    }
    return null;
  }

  static cleanProductName(name) {
    if (!name) return '';
    return name
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s\-\.]/g, '')
      .trim();
  }

  static validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  static generateCacheKey(product, minPrice, maxPrice, operator) {
    const key = `${product}_${minPrice || 'null'}_${maxPrice || 'null'}_${operator}`;
    return key.toLowerCase().replace(/\s+/g, '_');
  }

  static isValidUrl(string) {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  }

  static sanitizeInput(input) {
    if (!input) return '';
    return input
      .toString()
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/[<>]/g, '')
      .trim();
  }

  static logActivity(action, details) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${action}:`, details);
  }

  static calculateAccuracy(foundProducts, expectedCount) {
    if (expectedCount === 0) return 0;
    return Math.min((foundProducts / expectedCount) * 100, 100);
  }

  static getRetailerRating(domain) {
    const ratings = {
      'amazon.com': 9.5,
      'target.com': 9.0,
      'walmart.com': 8.5,
      'bestbuy.com': 9.2,
      'homedepot.com': 8.8,
      'lowes.com': 8.7,
      'costco.com': 9.3,
      'newegg.com': 8.9
    };
    return ratings[domain] || 7.0;
  }

  static estimateSearchTime(query, priceRange) {
    let estimatedTime = 5000;
    if (query.length > 50) estimatedTime += 2000;
    if (priceRange.min && priceRange.max) estimatedTime += 1000;
    estimatedTime += Math.random() * 3000;
    return Math.round(estimatedTime);
  }

  static formatTableData(products) {
    return products.map(product => {
      return {
        'Price': this.formatPrice(product.price),
        'Cat': product.category || 'Unknown',
        'Sub Cat': product.subCategory || 'Unknown',
        'Source': product.source || 'Unknown',
        'URL': product.url || 'N/A',
        'Pricer': 'AI-Enhanced',
        'Description': this.cleanProductName(product.description) || 'No description'
      };
    });
  }

  static normalizeDomain(link) {
    try {
      const parsed = new URL(link);
      return parsed.hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  }

  static extractASIN(link) {
    try {
      const match = link.match(/\/dp\/([A-Z0-9]{10})/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }
}

module.exports = HelperUtils;
