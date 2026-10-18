const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const User = require("../models/user.js");

// Require authentication for protected routes
const isLoggedIn = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    if (req.method === "GET") {
      // Prevent open redirect: verify URL starts with single slash and not double slash
      const requestedUrl = req.originalUrl;
      if (
        typeof requestedUrl === "string" &&
        requestedUrl.startsWith("/") &&
        !requestedUrl.startsWith("//")
      ) {
        req.session.redirectUrl = requestedUrl;
      }
    }
    req.flash("error", "You must be signed in first!");
    return res.redirect("/login");
  }
  next();
};

// Transfer saved redirect URL to res.locals before route execution
const saveRedirectUrl = (req, res, next) => {
  if (req.session && req.session.redirectUrl) {
    res.locals.redirectUrl = req.session.redirectUrl;
  }
  next();
};

// Load current user and flash messages into response locals
const loadCurrentUser = async (req, res, next) => {
  res.locals.success = req.flash ? req.flash("success") : [];
  res.locals.error = req.flash ? req.flash("error") : [];
  res.locals.currentUser = null;

  if (req.session && req.session.userId) {
    try {
      const user = await User.findById(req.session.userId).select("-password");
      if (user) {
        req.user = user;
        res.locals.currentUser = user;
      } else {
        delete req.session.userId;
        req.user = null;
        res.locals.currentUser = null;
      }
    } catch (err) {
      req.user = null;
      res.locals.currentUser = null;
    }
  } else {
    req.user = null;
    res.locals.currentUser = null;
  }
  next();
};

// Session-based CSRF protection middleware
const csrfProtection = (req, res, next) => {
  if (!req.session) {
    return next(new Error("Sessions must be initialized before CSRF protection"));
  }

  // Generate session CSRF token if missing
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }

  // Expose token to all views
  res.locals.csrfToken = req.session.csrfToken;

  // Safe HTTP methods do not mutate state
  const safeMethods = ["GET", "HEAD", "OPTIONS"];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // Extract token from request body or header
  const submittedToken =
    (req.body && req.body._csrf) ||
    req.headers["x-csrf-token"] ||
    req.headers["csrf-token"];

  if (
    !submittedToken ||
    typeof submittedToken !== "string" ||
    submittedToken.length !== req.session.csrfToken.length
  ) {
    return res.status(403).render("errors/error.ejs", {
      message: "Security check failed: Invalid or missing CSRF token. Please refresh the page and try again.",
      status: 403,
      currentUser: res.locals.currentUser || null,
      success: res.locals.success || [],
      error: res.locals.error || [],
    });
  }

  try {
    const expected = Buffer.from(req.session.csrfToken);
    const submitted = Buffer.from(submittedToken);
    if (!crypto.timingSafeEqual(expected, submitted)) {
      return res.status(403).render("errors/error.ejs", {
        message: "Security check failed: CSRF token mismatch.",
        status: 403,
        currentUser: res.locals.currentUser || null,
        success: res.locals.success || [],
        error: res.locals.error || [],
      });
    }
  } catch (e) {
    return res.status(403).render("errors/error.ejs", {
      message: "Security check failed: Invalid CSRF token encoding.",
      status: 403,
      currentUser: res.locals.currentUser || null,
      success: res.locals.success || [],
      error: res.locals.error || [],
    });
  }

  next();
};

// Rate limiter for authentication routes
const createAuthLimiter = (options = {}) => {
  return rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000, // 15 minutes
    max: options.max || (process.env.NODE_ENV === "test" ? 1000 : 20),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      if (req.flash) {
        req.flash("error", "Too many attempts from this network. Please wait a few minutes before trying again.");
      }
      res.status(429).render("errors/error.ejs", {
        message: "Too many requests. Please wait a few minutes and try again.",
        status: 429,
        currentUser: res.locals.currentUser || null,
        success: res.locals.success || [],
        error: res.locals.error || [],
      });
    },
  });
};

const authLimiter = createAuthLimiter();

// Authorization: verify that current user owns the listing
const Listing = require("../models/listing.js");

const isOwner = async (req, res, next) => {
  const { id } = req.params;

  try {
    const listing = await Listing.findById(id);

    if (!listing) {
      req.flash("error", "The listing you requested does not exist.");
      return res.redirect("/listings");
    }

    // Protect legacy unowned listings from mutation
    if (!listing.owner) {
      req.flash(
        "error",
        "Permission denied: This legacy listing does not have an assigned owner and cannot be modified."
      );
      return res.status(403).render("errors/error.ejs", {
        message: "Forbidden: This legacy listing has no assigned owner and cannot be modified.",
        status: 403,
        currentUser: res.locals.currentUser || null,
        success: res.locals.success || [],
        error: res.locals.error || [],
      });
    }

    // Verify authenticated user is the owner
    const authenticatedUserId = req.session && req.session.userId;
    if (!authenticatedUserId || !listing.owner.equals(authenticatedUserId)) {
      req.flash("error", "Permission denied: You are not authorized to modify this listing.");
      return res.status(403).render("errors/error.ejs", {
        message: "Forbidden: You are not authorized to modify this listing.",
        status: 403,
        currentUser: res.locals.currentUser || null,
        success: res.locals.success || [],
        error: res.locals.error || [],
      });
    }

    // Attach resolved listing for downstream handlers to avoid duplicate queries
    req.listing = listing;
    next();
  } catch (err) {
    if (err.name === "CastError") {
      req.flash("error", "Invalid listing identifier.");
      return res.redirect("/listings");
    }
    next(err);
  }
};

module.exports = {
  isLoggedIn,
  isOwner,
  saveRedirectUrl,
  loadCurrentUser,
  csrfProtection,
  authLimiter,
  createAuthLimiter,
};
