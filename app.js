// Load environment configuration
try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch (e) {
  // .env may not exist if variables are passed via system environment
}

const express = require("express");
const app = express();
const mongoose = require("mongoose");
const Listing = require("./models/listing.js");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");
const session = require("express-session");
const connectMongo = require("connect-mongo");
const MongoStore = connectMongo.MongoStore || connectMongo;
const flash = require("connect-flash");

const {
  isLoggedIn,
  isOwner,
  loadCurrentUser,
  csrfProtection,
} = require("./middleware/auth.js");
const userRoutes = require("./routes/users.js");
const {
  router: reservationRoutes,
  parseCalendarDate,
  getTodayUtc,
  calculateNights,
} = require("./routes/reservations.js");

// Determine database URL
const MONGO_URL =
  (process.env.NODE_ENV === "test" && process.env.TEST_MONGO_URL)
    ? process.env.TEST_MONGO_URL
    : process.env.MONGO_URL ||
      process.env.MONGODB_URI ||
      "mongodb://127.0.0.1:27017/staynest";

// Safety check: Never run tests against production database
if (process.env.NODE_ENV === "test") {
  if (
    MONGO_URL.includes("airbnb.ih00mhr.mongodb.net") ||
    MONGO_URL.startsWith("mongodb+srv://")
  ) {
    throw new Error(
      "SAFETY VIOLATION: Test environment attempted to connect to production Atlas database! Tests must use an isolated test database."
    );
  }
}

// Connect to MongoDB
if (process.env.NODE_ENV !== "test") {
  main()
    .then(() => {
      console.log("Connected to DB");
    })
    .catch((err) => {
      console.error("Database connection error:", err.message);
    });
}

async function main() {
  await mongoose.connect(MONGO_URL, {
    serverSelectionTimeoutMS: 5000,
  });
}

// Session configuration
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET && process.env.NODE_ENV === "production") {
  throw new Error("FATAL: SESSION_SECRET is required in production environment");
}
const sessionSecret = SESSION_SECRET || "staynest_dev_session_fallback_secret_key";

const store = MongoStore.create({
  mongoUrl: MONGO_URL,
  touchAfter: 24 * 3600,
  crypto: {
    secret: sessionSecret,
  },
});

store.on("error", (err) => {
  console.error("Session store error:", err.message);
});

const sessionConfig = {
  store,
  name: "staynest_sid",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    secure: process.env.NODE_ENV === "production",
  },
};

// Trust proxy if in production / behind reverse proxy
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// View engine setup
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.engine("ejs", ejsMate);

// Core middleware
app.use(express.static(path.join(__dirname, "/public")));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(methodOverride("_method"));

// Session & Flash
app.use(session(sessionConfig));
app.use(flash());

// Security middleware: User Context & CSRF Protection
app.use(loadCurrentUser);
app.use(csrfProtection);

// Auth Routes
app.use("/", userRoutes);

// Reservation Routes
app.use("/", reservationRoutes);

// Root route
app.get("/", (req, res) => {
  res.redirect("/listings");
});

// Helper to escape user input for safe regular expressions
function escapeRegex(text) {
  if (typeof text !== "string") return "";
  return text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

// Helper to sanitize search string parameters
function sanitizeSearchString(val) {
  if (typeof val !== "string") return "";
  return val.trim().slice(0, 100);
}

// Helper to validate and parse price parameters
function parsePrice(val) {
  if (val === undefined || val === null || val === "") return null;
  if (typeof val !== "string" && typeof val !== "number") return null;
  const num = Number(val);
  if (!Number.isFinite(num) || Number.isNaN(num) || num < 0) return null;
  return num;
}

// Pure helper function to construct safe MongoDB query filter from req.query
function buildListingFilter(queryParams = {}) {
  const cleanSearch = sanitizeSearchString(queryParams.search || queryParams.q);
  const cleanLocation = sanitizeSearchString(queryParams.location || queryParams.destination);
  const cleanTitle = sanitizeSearchString(queryParams.title);
  const cleanCountry = sanitizeSearchString(queryParams.country);
  const minPriceNum = parsePrice(queryParams.minPrice);
  const maxPriceNum = parsePrice(queryParams.maxPrice);

  const conditions = [];

  // General search across title, location, and country
  if (cleanSearch) {
    const searchRegex = new RegExp(escapeRegex(cleanSearch), "i");
    conditions.push({
      $or: [
        { title: searchRegex },
        { location: searchRegex },
        { country: searchRegex },
      ],
    });
  }

  // Location / destination specific search
  if (cleanLocation) {
    const locRegex = new RegExp(escapeRegex(cleanLocation), "i");
    conditions.push({
      $or: [
        { location: locRegex },
        { country: locRegex },
      ],
    });
  }

  // Title specific search
  if (cleanTitle) {
    const titleRegex = new RegExp(escapeRegex(cleanTitle), "i");
    conditions.push({ title: titleRegex });
  }

  // Country specific search
  if (cleanCountry) {
    const countryRegex = new RegExp(escapeRegex(cleanCountry), "i");
    conditions.push({ country: countryRegex });
  }

  // Price range filters
  if (minPriceNum !== null || maxPriceNum !== null) {
    const priceFilter = {};
    if (minPriceNum !== null) priceFilter.$gte = minPriceNum;
    if (maxPriceNum !== null) priceFilter.$lte = maxPriceNum;
    conditions.push({ price: priceFilter });
  }

  const mongoFilter = conditions.length > 0 ? { $and: conditions } : {};
  const hasActiveFilters = Boolean(
    cleanSearch ||
    cleanLocation ||
    cleanTitle ||
    cleanCountry ||
    minPriceNum !== null ||
    maxPriceNum !== null
  );

  return {
    mongoFilter,
    hasActiveFilters,
    filters: {
      search: cleanSearch,
      location: cleanLocation,
      title: cleanTitle,
      country: cleanCountry,
      minPrice: minPriceNum !== null ? minPriceNum : "",
      maxPrice: maxPriceNum !== null ? maxPriceNum : "",
    },
  };
}

// Index route (Public - supports destination, title, and price range filters)
app.get("/listings", async (req, res, next) => {
  try {
    const { mongoFilter, hasActiveFilters, filters } = buildListingFilter(req.query);
    const allListings = await Listing.find(mongoFilter);
    res.render("listings/index.ejs", {
      allListings,
      filters,
      hasActiveFilters,
    });
  } catch (err) {
    next(err);
  }
});

// New route (Protected)
app.get("/listings/new", isLoggedIn, (req, res) => {
  res.render("listings/new.ejs");
});

// Show route (Public)
app.get("/listings/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const listing = await Listing.findById(id).populate("owner", "name email");
    if (!listing) {
      req.flash("error", "The listing you requested does not exist.");
      return res.redirect("/listings");
    }
    res.render("listings/show.ejs", { listing });
  } catch (err) {
    if (err.name === "CastError") {
      req.flash("error", "Invalid listing identifier.");
      return res.redirect("/listings");
    }
    next(err);
  }
});

// Create route (Protected)
app.post("/listings", isLoggedIn, async (req, res, next) => {
  try {
    const listingData = { ...req.body.listing };
    // Enforce server-side ownership: strictly assign authenticated user ID as owner
    listingData.owner = req.session.userId;
    const newListing = new Listing(listingData);
    await newListing.save();
    req.flash("success", "New stay created successfully!");
    res.redirect("/listings");
  } catch (err) {
    next(err);
  }
});

// Edit route (Protected - Owner only)
app.get("/listings/:id/edit", isLoggedIn, isOwner, async (req, res, next) => {
  try {
    const listing = req.listing;
    res.render("listings/edit.ejs", { listing });
  } catch (err) {
    next(err);
  }
});

// Update route (Protected - Owner only)
app.put("/listings/:id", isLoggedIn, isOwner, async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body.listing };
    // Prevent client-side manipulation of listing ownership
    delete updateData.owner;
    delete updateData.ownerId;
    await Listing.findByIdAndUpdate(id, updateData);
    req.flash("success", "Listing updated successfully!");
    res.redirect(`/listings/${id}`);
  } catch (err) {
    next(err);
  }
});

// Delete route (Protected - Owner only)
app.delete("/listings/:id", isLoggedIn, isOwner, async (req, res, next) => {
  try {
    const { id } = req.params;
    await Listing.findByIdAndDelete(id);
    req.flash("success", "Listing deleted successfully!");
    res.redirect("/listings");
  } catch (err) {
    next(err);
  }
});

// 404 Handler (Express 5 compatible catch-all)
app.use((req, res) => {
  res.status(404).render("errors/error.ejs", {
    message: "Page Not Found",
    status: 404,
  });
});

// Centralized Error Handling Middleware
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const message = err.message || "Something went wrong on the server.";
  res.status(status).render("errors/error.ejs", { message, status });
});

// Export app and main for testing / server entry
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`StayNest server is running on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  main,
  store,
  buildListingFilter,
  escapeRegex,
  parsePrice,
  parseCalendarDate,
  getTodayUtc,
  calculateNights,
};
