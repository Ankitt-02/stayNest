// Set test environment variables BEFORE requiring application modules
process.env.NODE_ENV = "test";
process.env.TEST_MONGO_URL = "mongodb://127.0.0.1:27017/staynest_search_test";
process.env.SESSION_SECRET = "staynest_search_test_secret_1234567890";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const mongoose = require("mongoose");

// Safety guard: Verify tests NEVER target production Atlas database
if (
  process.env.TEST_MONGO_URL.includes("airbnb.ih00mhr.mongodb.net") ||
  process.env.TEST_MONGO_URL.startsWith("mongodb+srv://")
) {
  console.error("FATAL: Tests attempted to use production Atlas cluster! Aborting.");
  process.exit(1);
}

const { app, store, buildListingFilter, escapeRegex, parsePrice } = require("../app.js");
const Listing = require("../models/listing.js");

// Deterministic test fixtures
const fixtures = [
  {
    title: "Azure Coast Beachfront Villa",
    description: "Spectacular villa right on the beach.",
    location: "North Goa",
    country: "India",
    price: 18000,
    image: { filename: "test1", url: "https://example.com/1.jpg" },
  },
  {
    title: "Himalayan Alpine Wooden Chalet",
    description: "Cozy chalet in the snow peaks.",
    location: "Manali",
    country: "India",
    price: 9000,
    image: { filename: "test2", url: "https://example.com/2.jpg" },
  },
  {
    title: "Backwater Serenity Cottage",
    description: "Peaceful retreat by the backwaters.",
    location: "Kumarakom",
    country: "India",
    price: 12000,
    image: { filename: "test3", url: "https://example.com/3.jpg" },
  },
  {
    title: "French Colonial Heritage House",
    description: "Historic property with French architecture.",
    location: "Pondicherry",
    country: "France Overseas",
    price: 25000,
    image: { filename: "test4", url: "https://example.com/4.jpg" },
  },
  {
    title: "Budget Backpacker Eco Hut",
    description: "Affordable eco-friendly hut.",
    location: "Rishikesh",
    country: "India",
    price: 3000,
    image: { filename: "test5", url: "https://example.com/5.jpg" },
  },
];

test.describe("StayNest Search & Property Filters Test Suite", () => {
  test.before(async () => {
    // Connect to isolated test database
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.TEST_MONGO_URL);
    }
    // Clean and seed deterministic fixtures
    await Listing.deleteMany({});
    await Listing.insertMany(fixtures);
  });

  test.after(async () => {
    try {
      await Listing.deleteMany({});
    } catch (_) {}
    if (store && typeof store.close === "function") {
      try {
        await store.close();
      } catch (_) {}
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  test("1. Visiting /listings without filters still returns all available listings", async () => {
    const res = await request(app).get("/listings");
    assert.equal(res.status, 200);
    assert.match(res.text, /All Stays/);
    assert.match(res.text, /5\s*<\/b>\s*stays/);
    assert.match(res.text, /Azure Coast Beachfront Villa/);
    assert.match(res.text, /Himalayan Alpine Wooden Chalet/);
    assert.match(res.text, /Backwater Serenity Cottage/);
    assert.match(res.text, /French Colonial Heritage House/);
    assert.match(res.text, /Budget Backpacker Eco Hut/);
  });

  test("2. Searching by location returns matching properties", async () => {
    // Via location parameter
    const resLocation = await request(app).get("/listings?location=Goa");
    assert.equal(resLocation.status, 200);
    assert.match(resLocation.text, /Azure Coast Beachfront Villa/);
    assert.doesNotMatch(resLocation.text, /Himalayan Alpine Wooden Chalet/);
    assert.doesNotMatch(resLocation.text, /Budget Backpacker Eco Hut/);
    assert.match(resLocation.text, /1\s*<\/b>\s*stay\s*found/);

    // Via general search input for location
    const resSearch = await request(app).get("/listings?search=Manali");
    assert.equal(resSearch.status, 200);
    assert.match(resSearch.text, /Himalayan Alpine Wooden Chalet/);
    assert.doesNotMatch(resSearch.text, /Azure Coast Beachfront Villa/);
  });

  test("3. Searching by country returns matching properties", async () => {
    // Specific country param
    const resCountry = await request(app).get("/listings?country=France Overseas");
    assert.equal(resCountry.status, 200);
    assert.match(resCountry.text, /French Colonial Heritage House/);
    assert.doesNotMatch(resCountry.text, /Azure Coast Beachfront Villa/);
    assert.doesNotMatch(resCountry.text, /Himalayan Alpine Wooden Chalet/);

    // General search matching country
    const resIndia = await request(app).get("/listings?search=India");
    assert.equal(resIndia.status, 200);
    assert.match(resIndia.text, /4\s*<\/b>\s*stays\s*found/);
    assert.match(resIndia.text, /Azure Coast Beachfront Villa/);
    assert.doesNotMatch(resIndia.text, /French Colonial Heritage House/);
  });

  test("4. Searching by title returns matching properties", async () => {
    // Search by title param
    const resTitle = await request(app).get("/listings?title=Chalet");
    assert.equal(resTitle.status, 200);
    assert.match(resTitle.text, /Himalayan Alpine Wooden Chalet/);
    assert.doesNotMatch(resTitle.text, /Azure Coast Beachfront Villa/);

    // Search by general search query
    const resSearch = await request(app).get("/listings?search=Villa");
    assert.equal(resSearch.status, 200);
    assert.match(resSearch.text, /Azure Coast Beachfront Villa/);
    assert.doesNotMatch(resSearch.text, /Himalayan Alpine Wooden Chalet/);
  });

  test("5. Minimum-price filtering works", async () => {
    // Properties >= 15000: Azure Coast Villa (18000), French Colonial House (25000)
    const res = await request(app).get("/listings?minPrice=15000");
    assert.equal(res.status, 200);
    assert.match(res.text, /2\s*<\/b>\s*stays\s*found/);
    assert.match(res.text, /Azure Coast Beachfront Villa/);
    assert.match(res.text, /French Colonial Heritage House/);
    assert.doesNotMatch(res.text, /Himalayan Alpine Wooden Chalet/); // 9000
    assert.doesNotMatch(res.text, /Backwater Serenity Cottage/); // 12000
    assert.doesNotMatch(res.text, /Budget Backpacker Eco Hut/); // 3000
  });

  test("6. Maximum-price filtering works", async () => {
    // Properties <= 10000: Himalayan Chalet (9000), Budget Backpacker Hut (3000)
    const res = await request(app).get("/listings?maxPrice=10000");
    assert.equal(res.status, 200);
    assert.match(res.text, /2\s*<\/b>\s*stays\s*found/);
    assert.match(res.text, /Himalayan Alpine Wooden Chalet/);
    assert.match(res.text, /Budget Backpacker Eco Hut/);
    assert.doesNotMatch(res.text, /Azure Coast Beachfront Villa/); // 18000
    assert.doesNotMatch(res.text, /Backwater Serenity Cottage/); // 12000
    assert.doesNotMatch(res.text, /French Colonial Heritage House/); // 25000
  });

  test("7. Combined search and price filters work", async () => {
    // India stays between 8000 and 15000: Himalayan Chalet (9000), Backwater Cottage (12000)
    const res = await request(app).get("/listings?search=India&minPrice=8000&maxPrice=15000");
    assert.equal(res.status, 200);
    assert.match(res.text, /2\s*<\/b>\s*stays\s*found/);
    assert.match(res.text, /Himalayan Alpine Wooden Chalet/);
    assert.match(res.text, /Backwater Serenity Cottage/);
    assert.doesNotMatch(res.text, /Budget Backpacker Eco Hut/); // 3000 (below min)
    assert.doesNotMatch(res.text, /Azure Coast Beachfront Villa/); // 18000 (above max)
    assert.doesNotMatch(res.text, /French Colonial Heritage House/); // France
  });

  test("8. A search with no matches returns a valid empty state", async () => {
    const res = await request(app).get("/listings?search=NonExistentDestination999");
    assert.equal(res.status, 200);
    assert.match(res.text, /0\s*<\/b>\s*stays\s*found/);
    assert.match(res.text, /No stays found/i);
    assert.match(res.text, /Clear All Filters/);
    assert.doesNotMatch(res.text, /card col/);
  });

  test("9. Invalid, negative, or reversed price ranges are handled safely", async () => {
    // Malformed non-numeric values
    const resAlpha = await request(app).get("/listings?minPrice=abc&maxPrice=xyz");
    assert.equal(resAlpha.status, 200);
    assert.match(resAlpha.text, /5\s*<\/b>\s*stays/);

    // Negative price
    const resNegative = await request(app).get("/listings?minPrice=-500");
    assert.equal(resNegative.status, 200);
    assert.match(resNegative.text, /5\s*<\/b>\s*stays/);

    // Reversed price range: min 25000, max 5000 (impossible range)
    const resReversed = await request(app).get("/listings?minPrice=25000&maxPrice=5000");
    assert.equal(resReversed.status, 200);
    assert.match(resReversed.text, /0\s*<\/b>\s*stays\s*found/);
    assert.match(resReversed.text, /No stays found/i);
  });

  test("10. Regex metacharacters and malformed search values cannot cause query injection or unhandled errors", async () => {
    // Unclosed brackets and regex metacharacters
    const dangerousQueries = [
      "[unclosed-bracket",
      "villa (.*)",
      "\\",
      "+",
      "?",
      "{5}",
      "^.*$",
      "|",
    ];

    for (const q of dangerousQueries) {
      const res = await request(app).get(`/listings?search=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, `Failed on query: ${q}`);
      // Must not leak stack traces or crash
      assert.doesNotMatch(res.text, /SyntaxError/);
      assert.doesNotMatch(res.text, /Invalid regular expression/);
    }

    // Object injection via query parameters
    const resObj = await request(app).get("/listings?search[$gt]=0&minPrice[$gt]=0");
    assert.equal(resObj.status, 200);
    assert.doesNotMatch(resObj.text, /TypeError/);
    assert.doesNotMatch(resObj.text, /MongoError/);
  });

  test("11. Filter state preservation and clear action in template", async () => {
    const res = await request(app).get("/listings?search=Manali&minPrice=5000&maxPrice=12000");
    assert.equal(res.status, 200);
    // Value retained in inputs
    assert.match(res.text, /value="Manali"/);
    assert.match(res.text, /value="5000"/);
    assert.match(res.text, /value="12000"/);
    // Clear filter link present
    assert.match(res.text, /href="\/listings"/);
    assert.match(res.text, /Clear/);
  });
});
