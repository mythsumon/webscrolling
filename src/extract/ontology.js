/**
 * Label ontology: the knowledge base that turns a human label into a value
 * kind plus the vocabulary to hunt for it.
 *
 * This is NOT a list of supported fields — labels that miss every entry here
 * still work, via heuristic inference in labels.js. The ontology only makes
 * the common cases sharper (knowing that "Tel" means phone, or that
 * "Amenities" is a list, is what lets tiers 1–4 succeed without an LLM).
 *
 * Entry shape:
 *   type        value kind, selects resolvers + validator (see patterns.js)
 *   aliases     label spellings a user might type
 *   keywords    words to look for in the DOM (labels, headings, class names)
 *   schemaKeys  JSON-LD / microdata property names
 *   attrHints   substrings to match in class/id/itemprop attributes
 *   metaKeys    <meta> names/properties
 *   plural      force array output regardless of the label's own plurality
 *   pageHints   URL path words where this field is likely to live
 */

/** @typedef {{type: string, aliases: string[], keywords?: string[], schemaKeys?: string[], attrHints?: string[], metaKeys?: string[], plural?: boolean, pageHints?: string[]}} OntologyEntry */

/** @type {Record<string, OntologyEntry>} */
export const ONTOLOGY = {
  name: {
    type: 'name',
    aliases: ['name', 'title', 'business name', 'company name', 'hotel name', 'restaurant name',
      'property name', 'shop name', 'store name', 'venue name', 'brand', 'brand name',
      'organisation name', 'organization name', 'site name', 'page title', 'product name',
      'listing name', 'establishment name'],
    keywords: ['name', 'title'],
    schemaKeys: ['name', 'legalName', 'alternateName', 'headline'],
    metaKeys: ['og:title', 'og:site_name', 'twitter:title', 'application-name'],
    attrHints: ['site-title', 'business-name', 'hotel-name', 'company-name', 'product-title', 'entry-title'],
  },

  description: {
    type: 'description',
    aliases: ['description', 'about', 'about us', 'summary', 'overview', 'intro', 'introduction',
      'details', 'bio', 'profile', 'company description', 'hotel description', 'product description',
      'short description', 'long description', 'content', 'body'],
    keywords: ['description', 'about', 'overview', 'summary', 'introduction', 'welcome'],
    schemaKeys: ['description', 'abstract', 'disambiguatingDescription', 'articleBody'],
    metaKeys: ['og:description', 'description', 'twitter:description'],
    attrHints: ['description', 'about', 'intro', 'overview', 'summary', 'bio'],
    pageHints: ['about', 'about-us', 'company', 'profile', 'overview'],
  },

  address: {
    type: 'address',
    aliases: ['address', 'full address', 'street address', 'location', 'postal address',
      'mailing address', 'office address', 'head office', 'headquarters', 'where we are',
      'find us', 'venue', 'street'],
    keywords: ['address', 'location', 'street', 'find us', 'visit us', 'where', 'office', 'headquarters'],
    schemaKeys: ['address', 'streetAddress', 'location'],
    attrHints: ['address', 'location', 'adr', 'street', 'contact-address'],
    pageHints: ['contact', 'contact-us', 'location', 'locations', 'find-us', 'directions', 'about'],
  },

  city: {
    type: 'text',
    aliases: ['city', 'town', 'locality', 'city name'],
    keywords: ['city', 'town', 'locality'],
    schemaKeys: ['addressLocality', 'city'],
    attrHints: ['city', 'locality'],
  },

  region: {
    type: 'text',
    aliases: ['state', 'region', 'province', 'county', 'district'],
    keywords: ['state', 'region', 'province', 'district'],
    schemaKeys: ['addressRegion', 'state', 'region'],
    attrHints: ['region', 'state', 'province'],
  },

  country: {
    type: 'text',
    aliases: ['country', 'nation'],
    keywords: ['country'],
    schemaKeys: ['addressCountry', 'country'],
    attrHints: ['country'],
  },

  postal_code: {
    type: 'text',
    aliases: ['postal code', 'postcode', 'zip', 'zip code', 'post code'],
    keywords: ['postal', 'postcode', 'zip'],
    schemaKeys: ['postalCode', 'zipCode'],
    attrHints: ['postal', 'zip', 'postcode'],
  },

  phone: {
    type: 'phone',
    aliases: ['phone', 'phone number', 'telephone', 'tel', 'mobile', 'mobile number', 'cell',
      'contact number', 'contact', 'call us', 'hotline', 'reservations', 'booking phone',
      'primary phone', 'landline'],
    keywords: ['phone', 'tel', 'telephone', 'mobile', 'cell', 'call', 'contact', 'hotline',
      'reservation', 'reservations', 'enquiries', 'inquiries', 'ph'],
    schemaKeys: ['telephone', 'phone', 'contactPoint'],
    attrHints: ['phone', 'tel', 'mobile', 'contact-phone', 'call'],
    pageHints: ['contact', 'contact-us', 'reservations', 'booking', 'about'],
  },

  whatsapp: {
    type: 'phone',
    aliases: ['whatsapp', 'whatsapp number', 'viber', 'viber number'],
    keywords: ['whatsapp', 'viber', 'wa'],
    schemaKeys: ['telephone'],
    attrHints: ['whatsapp', 'viber'],
  },

  fax: {
    type: 'phone',
    aliases: ['fax', 'fax number'],
    keywords: ['fax'],
    schemaKeys: ['faxNumber'],
    attrHints: ['fax'],
  },

  email: {
    type: 'email',
    aliases: ['email', 'e-mail', 'email address', 'mail', 'contact email', 'enquiries email',
      'reservations email', 'support email', 'info email'],
    keywords: ['email', 'e-mail', 'mail', 'contact', 'enquiries', 'inquiries', 'write to us'],
    schemaKeys: ['email'],
    attrHints: ['email', 'mail'],
    pageHints: ['contact', 'contact-us', 'about'],
  },

  website: {
    type: 'url',
    aliases: ['website', 'web site', 'url', 'homepage', 'home page', 'web', 'site', 'web address',
      'official website', 'link'],
    keywords: ['website', 'url', 'homepage', 'web', 'visit'],
    schemaKeys: ['url', 'sameAs', 'mainEntityOfPage'],
    metaKeys: ['og:url', 'link:canonical'],
    attrHints: ['website', 'url', 'web', 'homepage'],
  },

  price: {
    type: 'price',
    aliases: ['price', 'cost', 'rate', 'rates', 'fee', 'fees', 'pricing', 'room price',
      'room rate', 'starting price', 'price from', 'price range', 'ticket price', 'tariff',
      'amount', 'charge'],
    keywords: ['price', 'cost', 'rate', 'rates', 'from', 'per night', 'pricing', 'fee', 'tariff',
      'starting', 'usd', 'mmk', 'thb'],
    schemaKeys: ['price', 'lowPrice', 'highPrice', 'priceRange', 'offers', 'priceSpecification'],
    metaKeys: ['product:price:amount', 'og:price:amount'],
    attrHints: ['price', 'cost', 'rate', 'amount', 'tariff'],
    pageHints: ['rooms', 'pricing', 'rates', 'prices', 'booking', 'menu', 'products', 'shop'],
  },

  currency: {
    type: 'text',
    aliases: ['currency', 'price currency'],
    keywords: ['currency'],
    schemaKeys: ['priceCurrency'],
    metaKeys: ['product:price:currency', 'og:price:currency'],
    attrHints: ['currency'],
  },

  room_type: {
    type: 'list',
    aliases: ['room type', 'room types', 'rooms', 'accommodation', 'accommodations', 'suites',
      'room categories', 'unit type', 'apartment type'],
    keywords: ['room', 'rooms', 'suite', 'suites', 'deluxe', 'standard', 'superior', 'twin',
      'double', 'single', 'family', 'accommodation', 'villa', 'bungalow', 'studio'],
    schemaKeys: ['containsPlace', 'accommodationCategory', 'name', 'bed', 'occupancy'],
    // `name` is here to read a nested HotelRoom's name — gated so it cannot
    // return the hotel's own name or an amenity's name instead.
    schemaEntityTypes: ['hotelroom', 'room', 'suite', 'accommodation', 'apartment',
      'house', 'singlefamilyresidence', 'meetingroom', 'campingpitch', 'product'],
    attrHints: ['room', 'suite', 'accommodation', 'unit-type'],
    pageHints: ['rooms', 'accommodation', 'suites', 'stay', 'rooms-suites'],
  },

  amenities: {
    type: 'list',
    aliases: ['amenities', 'amenity', 'facilities', 'features', 'services', 'inclusions',
      'what we offer', 'offerings', 'highlights', 'perks', 'tags', 'categories', 'specifications'],
    keywords: ['amenity', 'amenities', 'facility', 'facilities', 'feature', 'features', 'services',
      'included', 'includes', 'offer', 'wifi', 'parking', 'pool', 'breakfast', 'gym', 'spa',
      'air conditioning', 'restaurant', 'bar'],
    schemaKeys: ['amenityFeature', 'additionalProperty', 'keywords', 'features', 'makesOffer'],
    attrHints: ['amenit', 'facilit', 'feature', 'service', 'inclusion', 'highlight'],
    plural: true,
    pageHints: ['amenities', 'facilities', 'services', 'features', 'rooms', 'about'],
  },

  main_image: {
    type: 'image',
    aliases: ['main image', 'primary image', 'featured image', 'cover image', 'cover photo',
      'hero image', 'main photo', 'thumbnail', 'image', 'photo', 'picture', 'hotel image',
      'product image', 'banner image'],
    keywords: ['image', 'photo', 'picture', 'hero', 'banner', 'cover', 'featured', 'main'],
    schemaKeys: ['image', 'primaryImageOfPage', 'photo', 'contentUrl', 'thumbnailUrl'],
    metaKeys: ['og:image', 'twitter:image'],
    attrHints: ['hero', 'banner', 'main-image', 'featured', 'cover'],
  },

  gallery_images: {
    type: 'image_list',
    aliases: ['gallery images', 'gallery', 'images', 'photos', 'pictures', 'photo gallery',
      'image gallery', 'all images', 'room images', 'property photos', 'media'],
    keywords: ['gallery', 'photos', 'images', 'pictures', 'slider', 'carousel', 'slideshow',
      'lightbox', 'media'],
    schemaKeys: ['image', 'photo', 'associatedMedia'],
    attrHints: ['gallery', 'slider', 'carousel', 'photos', 'images', 'lightbox', 'swiper'],
    plural: true,
    pageHints: ['gallery', 'photos', 'images', 'media', 'rooms'],
  },

  logo: {
    type: 'image',
    aliases: ['logo', 'brand logo', 'company logo'],
    keywords: ['logo', 'brand'],
    schemaKeys: ['logo'],
    attrHints: ['logo', 'brand'],
  },

  opening_hours: {
    type: 'hours',
    aliases: ['opening hours', 'open hours', 'hours', 'business hours', 'working hours',
      'office hours', 'operating hours', 'hours of operation', 'check in', 'check-in time',
      'check out', 'schedule', 'timings'],
    keywords: ['hours', 'opening', 'open', 'closed', 'monday', 'weekday', 'schedule', 'timing',
      'check in', 'check-in', 'check out', 'check-out'],
    schemaKeys: ['openingHours', 'openingHoursSpecification', 'checkinTime', 'checkoutTime'],
    attrHints: ['hours', 'opening', 'schedule', 'timing', 'open'],
    // 'Opening Hours' is one value, despite the plural noun.
    plural: false,
    pageHints: ['contact', 'about', 'hours', 'visit'],
  },

  latitude: {
    type: 'latitude',
    aliases: ['latitude', 'lat', 'gps latitude'],
    keywords: ['latitude', 'lat', 'coordinates', 'gps'],
    schemaKeys: ['latitude', 'geo'],
    metaKeys: ['place:location:latitude', 'geo.position', 'icbm'],
    attrHints: ['latitude', 'lat', 'geo'],
    pageHints: ['contact', 'location', 'directions', 'map'],
  },

  longitude: {
    type: 'longitude',
    aliases: ['longitude', 'lng', 'long', 'lon', 'gps longitude'],
    keywords: ['longitude', 'lng', 'lon', 'coordinates', 'gps'],
    schemaKeys: ['longitude', 'geo'],
    metaKeys: ['place:location:longitude', 'geo.position', 'icbm'],
    attrHints: ['longitude', 'lng', 'lon', 'geo'],
    pageHints: ['contact', 'location', 'directions', 'map'],
  },

  rating: {
    type: 'rating',
    aliases: ['rating', 'star rating', 'average rating', 'score', 'stars', 'reviews score'],
    keywords: ['rating', 'stars', 'score', 'rated', 'out of'],
    schemaKeys: ['ratingValue', 'aggregateRating', 'starRating'],
    attrHints: ['rating', 'stars', 'score'],
  },

  review_count: {
    type: 'number',
    aliases: ['review count', 'number of reviews', 'reviews', 'total reviews'],
    keywords: ['reviews', 'ratings', 'review'],
    schemaKeys: ['reviewCount', 'ratingCount'],
    attrHints: ['review-count', 'reviews'],
  },

  person_name: {
    type: 'name',
    aliases: ['ceo', 'ceo name', 'founder', 'owner', 'manager', 'general manager', 'director',
      'contact person', 'contact name', 'author', 'chef', 'president', 'principal', 'head'],
    keywords: ['ceo', 'founder', 'owner', 'manager', 'director', 'president', 'chief executive',
      'contact person', 'team', 'leadership', 'author', 'chef', 'proprietor'],
    schemaKeys: ['founder', 'employee', 'author', 'ceo', 'name', 'memberOf', 'worksFor'],
    // `name` is in schemaKeys so we can read a nested Person.name — but it must
    // NOT match the business's own name. This restricts generic keys like
    // `name` to entities of these types; specific keys (founder, ceo…) are
    // unaffected. Without it, "CEO Name" happily returns the company name.
    schemaEntityTypes: ['person'],
    // Roles are mutually exclusive: a value labelled "Practice Manager" is not
    // an answer to "CEO Name", even though both are person roles. `exclusive`
    // means the user's own words must appear in the match; the keywords above
    // only help find and rank candidates, they cannot qualify one.
    exclusive: true,
    attrHints: ['ceo', 'founder', 'owner', 'manager', 'director', 'team-member', 'author'],
    pageHints: ['about', 'about-us', 'team', 'our-team', 'leadership', 'management', 'people', 'staff'],
  },

  facebook: {
    type: 'social',
    aliases: ['facebook', 'facebook page', 'fb', 'facebook url', 'facebook link'],
    keywords: ['facebook', 'fb'],
    schemaKeys: ['sameAs'],
    attrHints: ['facebook', 'fb'],
    social: 'facebook',
  },

  instagram: {
    type: 'social',
    aliases: ['instagram', 'instagram page', 'ig', 'insta', 'instagram url'],
    keywords: ['instagram', 'ig', 'insta'],
    schemaKeys: ['sameAs'],
    attrHints: ['instagram', 'insta'],
    social: 'instagram',
  },

  twitter: {
    type: 'social',
    aliases: ['twitter', 'x', 'twitter url', 'x profile', 'twitter handle'],
    keywords: ['twitter', 'x'],
    schemaKeys: ['sameAs'],
    metaKeys: ['twitter:site', 'twitter:creator'],
    attrHints: ['twitter'],
    social: 'twitter',
  },

  linkedin: {
    type: 'social',
    aliases: ['linkedin', 'linkedin page', 'linkedin url'],
    keywords: ['linkedin'],
    schemaKeys: ['sameAs'],
    attrHints: ['linkedin'],
    social: 'linkedin',
  },

  youtube: {
    type: 'social',
    aliases: ['youtube', 'youtube channel', 'youtube url'],
    keywords: ['youtube'],
    schemaKeys: ['sameAs'],
    attrHints: ['youtube'],
    social: 'youtube',
  },

  tiktok: {
    type: 'social',
    aliases: ['tiktok', 'tik tok', 'tiktok url'],
    keywords: ['tiktok'],
    schemaKeys: ['sameAs'],
    attrHints: ['tiktok'],
    social: 'tiktok',
  },

  sku: {
    type: 'text',
    aliases: ['sku', 'product code', 'item code', 'model', 'model number', 'part number', 'mpn'],
    keywords: ['sku', 'model', 'product code', 'item code', 'part number'],
    schemaKeys: ['sku', 'mpn', 'productID', 'model', 'gtin13', 'gtin'],
    attrHints: ['sku', 'model', 'product-code'],
  },

  availability: {
    type: 'text',
    aliases: ['availability', 'in stock', 'stock', 'stock status'],
    keywords: ['availability', 'in stock', 'out of stock', 'stock'],
    schemaKeys: ['availability', 'inventoryLevel'],
    attrHints: ['availability', 'stock'],
  },

  category: {
    type: 'text',
    aliases: ['category', 'type', 'business type', 'property type', 'cuisine', 'genre', 'industry',
      'sector', 'classification'],
    keywords: ['category', 'type', 'cuisine', 'industry', 'sector'],
    schemaKeys: ['category', 'servesCuisine', 'additionalType', '@type', 'industry'],
    attrHints: ['category', 'cuisine', 'industry', 'type'],
  },

  date: {
    type: 'date',
    aliases: ['date', 'published', 'published date', 'date published', 'established',
      'founded', 'founding date', 'year', 'event date', 'updated'],
    keywords: ['date', 'published', 'founded', 'established', 'since', 'updated'],
    schemaKeys: ['datePublished', 'dateModified', 'foundingDate', 'startDate', 'endDate'],
    metaKeys: ['article:published_time', 'article:modified_time'],
    attrHints: ['date', 'published', 'founded', 'established'],
  },
};

/** Flat alias -> ontology key lookup, built once. */
export const ALIAS_INDEX = (() => {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const [key, entry] of Object.entries(ONTOLOGY)) {
    map.set(key.replace(/_/g, ' '), key);
    for (const alias of entry.aliases) map.set(alias.toLowerCase(), key);
  }
  return map;
})();

/**
 * Generic priors for relevance-scoring internal links, independent of the
 * requested labels. Used as a tie-breaker in links/discovery.js.
 */
export const PAGE_PRIORS = {
  contact: 0.9,
  'contact-us': 0.9,
  contacts: 0.8,
  about: 0.7,
  'about-us': 0.7,
  location: 0.7,
  locations: 0.65,
  'find-us': 0.65,
  directions: 0.6,
  gallery: 0.7,
  photos: 0.65,
  rooms: 0.7,
  accommodation: 0.65,
  suites: 0.6,
  menu: 0.6,
  pricing: 0.6,
  rates: 0.6,
  prices: 0.6,
  booking: 0.55,
  reservations: 0.55,
  team: 0.5,
  'our-team': 0.5,
  leadership: 0.5,
  management: 0.45,
  services: 0.5,
  facilities: 0.55,
  amenities: 0.6,
  products: 0.5,
  shop: 0.45,
  impressum: 0.6,
  imprint: 0.6,
};
