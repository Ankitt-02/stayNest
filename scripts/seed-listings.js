/**
 * StayNest - Curated Property Listings Seed Script
 *
 * Populates 8 high-quality, realistic accommodation listings into the target
 * MongoDB database ('staynest') if and only if the collection is currently empty.
 *
 * Safety & Idempotency:
 * - Loads credentials safely from environment variables (process.env.MONGO_URL / MONGODB_URI).
 * - Explicitly verifies connection to the 'staynest' database; aborts if connected elsewhere.
 * - Checks current listing count before any write.
 * - Skips insertion if listings already exist (0 duplicate risk).
 * - Leaves 'owner' undefined so seeded stays act as community/platform properties.
 * - Cleans up database connection and exits cleanly.
 */

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Listing = require("../models/listing.js");

// 1. Safe environment variable loading
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("Warning loading .env via process.loadEnvFile:", err.message);
    }
  }
}

const mongoUri = process.env.MONGO_URL || process.env.MONGODB_URI;

if (!mongoUri) {
  console.error("Error: Neither MONGO_URL nor MONGODB_URI is set in the environment.");
  process.exit(1);
}

// 2. Curated Sample Listings Data
const curatedListings = [
  {
    title: "The Glasshouse Alpine Cabin",
    description:
      "Nestled quietly among towering deodar pines in the Kullu Valley, this modern glass-fronted cabin offers sweeping woodland views and starlit night skies. Enjoy cozy cedar wood interiors, a Scandinavian wood-burning fireplace, heated floors, and a private wraparound deck for morning forest baths.",
    image: {
      filename: "forest-glass-cabin",
      url: "https://images.unsplash.com/photo-1510798831971-661eb04b3739?auto=format&fit=crop&w=1200&q=80",
    },
    price: 11500,
    location: "Manali, Himachal Pradesh",
    country: "India",
  },
  {
    title: "Azure Cliffside Oceanfront Villa",
    description:
      "Perched majestically above the dramatic red cliffs of Varkala, this tranquil coastal haven offers uninterrupted panoramic views of the Arabian Sea. Unwind beside the private infinity plunge pool, savor open-air sunset dinners on the shaded sea deck, and enjoy private pathway access to quiet sandy beaches.",
    image: {
      filename: "coastal-ocean-villa",
      url: "https://images.unsplash.com/photo-1613490493576-7fde63acd811?auto=format&fit=crop&w=1200&q=80",
    },
    price: 17500,
    location: "Varkala, Kerala",
    country: "India",
  },
  {
    title: "The Whispering Pines Mountain Chalet",
    description:
      "A handcrafted wooden alpine chalet framed by snow-dusted peaks and serene mountain meadows. Features warm pine-paneled rooms, an artisanal stone fireplace, floor-to-ceiling panoramic windows, and easy proximity to world-class ski slopes and alpine trails.",
    image: {
      filename: "mountain-chalet",
      url: "https://images.unsplash.com/photo-1502784444187-359ac186c5bb?auto=format&fit=crop&w=1200&q=80",
    },
    price: 16000,
    location: "Gulmarg, Jammu & Kashmir",
    country: "India",
  },
  {
    title: "The Royal Amber Heritage Haveli",
    description:
      "Step into timeless regal elegance at this beautifully restored 19th-century Rajasthani haveli. Marvel at hand-painted fresco ceilings, carved jharokha balconies, and a sunlit marble courtyard fountain, complete with evening folk recitals and authentic royal Mewari and Marwari cuisine.",
    image: {
      filename: "jaipur-heritage-haveli",
      url: "https://images.unsplash.com/photo-1599661046289-e31897846e41?auto=format&fit=crop&w=1200&q=80",
    },
    price: 24000,
    location: "Jaipur, Rajasthan",
    country: "India",
  },
  {
    title: "Casa Sol Tropical Estate",
    description:
      "An idyllic sun-drenched sanctuary tucked away beneath swaying coconut palms in trendy Assagao. Features a private swimming pool, sun-drenched cabana, high-vaulted wooden ceilings, breezy open-concept living spaces, and easy access to North Goa's most celebrated boutique cafes and sunset beaches.",
    image: {
      filename: "tropical-goa-villa",
      url: "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=1200&q=80",
    },
    price: 19500,
    location: "Assagao, Goa",
    country: "India",
  },
  {
    title: "Misty Hills Plantation Cottage",
    description:
      "Wake up to the intoxicating scent of flowering arabica coffee and rolling morning mist in this heritage plantation bungalow. Surrounded by a 50-acre working coffee and pepper estate, this cottage offers spacious colonial verandahs, fireplace evenings, guided nature walks, and home-cooked Kodava delicacies.",
    image: {
      filename: "coorg-coffee-cottage",
      url: "https://images.unsplash.com/photo-1587381420270-3e1a5b9e6904?auto=format&fit=crop&w=1200&q=80",
    },
    price: 6800,
    location: "Madikeri, Coorg, Karnataka",
    country: "India",
  },
  {
    title: "Pichola Palace Lakeside Villa",
    description:
      "Set right along the shimmer of Lake Pichola, this intimate lakeside villa commands unmatched views of the illuminated City Palace and Jag Mandir. Enjoy romantic candlelit rooftop dining, intricate scalloped archways, plush velvet divans, and serene sunrise boat excursions on the tranquil lake.",
    image: {
      filename: "udaipur-lakeside-villa",
      url: "https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&w=1200&q=80",
    },
    price: 26500,
    location: "Udaipur, Rajasthan",
    country: "India",
  },
  {
    title: "Kumarakom Palm & Water Retreat",
    description:
      "Immerse yourself in authentic backwater bliss at this peaceful waterfront lodge on the tranquil banks of Lake Vembanad. Built with reclaimed teakwood and classic Kerala terracotta gables, the retreat offers an open-air rain shower, hammock lounges overlooking water lilies, and private country boat tours along emerald canals.",
    image: {
      filename: "kerala-backwater-retreat",
      url: "https://images.unsplash.com/photo-1602216056096-3b40cc0c9944?auto=format&fit=crop&w=1200&q=80",
    },
    price: 13500,
    location: "Kumarakom, Kerala",
    country: "India",
  },
];

async function seedListings() {
  console.log("Connecting to MongoDB for listing seed verification...");
  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 8000,
    });

    const dbName = mongoose.connection.name;
    console.log(`Connected successfully. Active database name: "${dbName}"`);

    // Target database verification check
    if (dbName !== "staynest") {
      console.error(
        `Safety Abort: Target database name is "${dbName}", expected "staynest". Aborting seed operation.`
      );
      await mongoose.disconnect();
      process.exit(1);
    }

    // Idempotency check: Count existing listings
    const existingCount = await Listing.countDocuments();
    console.log(`Current listings count in "${dbName}": ${existingCount}`);

    if (existingCount > 0) {
      console.log(
        `Database already contains ${existingCount} listing(s). Skipping seed insertion to preserve existing data.`
      );
      await mongoose.disconnect();
      console.log("Disconnected from MongoDB. Seed script completed safely.");
      process.exit(0);
    }

    // Insert curated listings
    console.log(`Seeding ${curatedListings.length} curated accommodation listings...`);
    const inserted = await Listing.insertMany(curatedListings);
    console.log(`Successfully inserted ${inserted.length} listings into "${dbName}".`);

    const finalCount = await Listing.countDocuments();
    console.log(`Verified new total listings count: ${finalCount}`);

    await mongoose.disconnect();
    console.log("Database connection closed. Seed operation completed successfully.");
    process.exit(0);
  } catch (err) {
    console.error("Seed script encountered an error:", err.message);
    try {
      await mongoose.disconnect();
    } catch (_) {}
    process.exit(1);
  }
}

seedListings();
