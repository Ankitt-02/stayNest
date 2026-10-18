const express = require("express");
const router = express.Router();
const User = require("../models/user.js");
const { saveRedirectUrl, authLimiter } = require("../middleware/auth.js");

// Email regex pattern
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /signup
router.get("/signup", (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect("/listings");
  }
  res.render("users/signup.ejs", { formData: {} });
});

// POST /signup
router.post("/signup", authLimiter, async (req, res, next) => {
  try {
    const { name, email, password } = req.body || {};

    const trimmedName = typeof name === "string" ? name.trim() : "";
    const normalizedEmail =
      typeof email === "string" ? email.trim().toLowerCase() : "";
    const rawPassword = typeof password === "string" ? password : "";

    // Server-side input validation
    if (!trimmedName || trimmedName.length < 2 || trimmedName.length > 50) {
      const msg = "Name must be between 2 and 50 characters.";
      req.flash("error", msg);
      res.locals.error = [msg];
      return res.status(400).render("users/signup.ejs", {
        formData: { name: trimmedName, email: normalizedEmail },
      });
    }

    if (
      !normalizedEmail ||
      normalizedEmail.length > 100 ||
      !EMAIL_REGEX.test(normalizedEmail)
    ) {
      const msg = "Please provide a valid email address.";
      req.flash("error", msg);
      res.locals.error = [msg];
      return res.status(400).render("users/signup.ejs", {
        formData: { name: trimmedName, email: normalizedEmail },
      });
    }

    if (!rawPassword || rawPassword.length < 8 || rawPassword.length > 128) {
      const msg = "Password must be between 8 and 128 characters long.";
      req.flash("error", msg);
      res.locals.error = [msg];
      return res.status(400).render("users/signup.ejs", {
        formData: { name: trimmedName, email: normalizedEmail },
      });
    }

    // Check for existing account
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      const msg = "An account with this email address already exists. Please log in.";
      req.flash("error", msg);
      res.locals.error = [msg];
      return res.status(409).render("users/signup.ejs", {
        formData: { name: trimmedName, email: normalizedEmail },
      });
    }

    // Hash password with bcrypt (12 rounds)
    const hashedPassword = await User.hashPassword(rawPassword);

    // Persist new user
    const newUser = new User({
      name: trimmedName,
      email: normalizedEmail,
      password: hashedPassword,
    });
    await newUser.save();

    // Regenerate session to prevent fixation
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = newUser._id;
      req.flash("success", `Welcome to StayNest, ${newUser.name}!`);
      res.redirect("/listings");
    });
  } catch (err) {
    if (err.code === 11000) {
      const msg = "An account with this email address already exists. Please log in.";
      req.flash("error", msg);
      res.locals.error = [msg];
      return res.status(409).render("users/signup.ejs", {
        formData: { name: req.body?.name || "", email: req.body?.email || "" },
      });
    }
    next(err);
  }
});

// GET /login
router.get("/login", (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect("/listings");
  }
  res.render("users/login.ejs", { formData: {} });
});

// POST /login
router.post("/login", authLimiter, saveRedirectUrl, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail =
      typeof email === "string" ? email.trim().toLowerCase() : "";
    const rawPassword = typeof password === "string" ? password : "";

    if (!normalizedEmail || !rawPassword) {
      const msg = "Please provide both email and password.";
      req.flash("error", msg);
      res.locals.error = [msg];
      return res.status(400).render("users/login.ejs", {
        formData: { email: normalizedEmail },
      });
    }

    // Look up user
    const user = await User.findOne({ email: normalizedEmail });

    // Constant-time check / generic rejection to prevent enumeration
    if (!user) {
      const msg = "Invalid email or password.";
      req.flash("error", msg);
      res.locals.error = [msg];
      return res.status(401).render("users/login.ejs", {
        formData: { email: normalizedEmail },
      });
    }

    const isMatch = await user.comparePassword(rawPassword);
    if (!isMatch) {
      const msg = "Invalid email or password.";
      req.flash("error", msg);
      res.locals.error = [msg];
      return res.status(401).render("users/login.ejs", {
        formData: { email: normalizedEmail },
      });
    }

    // Resolve safe redirect URL (avoid open redirects)
    let redirectUrl = res.locals.redirectUrl || "/listings";
    if (
      typeof redirectUrl !== "string" ||
      !redirectUrl.startsWith("/") ||
      redirectUrl.startsWith("//")
    ) {
      redirectUrl = "/listings";
    }

    // Regenerate session upon successful login
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user._id;
      req.flash("success", `Welcome back, ${user.name}!`);
      res.redirect(redirectUrl);
    });
  } catch (err) {
    next(err);
  }
});

// POST /logout
router.post("/logout", (req, res, next) => {
  if (req.session) {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie("staynest_sid");
      res.clearCookie("connect.sid");
      res.redirect("/listings");
    });
  } else {
    res.redirect("/listings");
  }
});

module.exports = router;
