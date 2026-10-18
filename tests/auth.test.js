// Set test environment variables BEFORE requiring application modules
process.env.NODE_ENV = "test";
process.env.TEST_MONGO_URL = "mongodb://127.0.0.1:27017/staynest_auth_test";
process.env.SESSION_SECRET = "staynest_test_secret_key_abcdef1234567890";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

// Safety guard: Double-check test database target
if (
  process.env.TEST_MONGO_URL.includes("airbnb.ih00mhr.mongodb.net") ||
  process.env.TEST_MONGO_URL.startsWith("mongodb+srv://")
) {
  console.error("FATAL: Tests attempted to use production Atlas cluster! Aborting.");
  process.exit(1);
}

const { app, store } = require("../app.js");
const User = require("../models/user.js");
const Listing = require("../models/listing.js");

// Helpers
function extractCsrfToken(html) {
  if (!html) return null;
  const match =
    html.match(/name="_csrf"\s+value="([a-f0-9]{64})"/i) ||
    html.match(/value="([a-f0-9]{64})"\s+name="_csrf"/i);
  return match ? match[1] : null;
}

function extractCookie(res) {
  const setCookie = res.headers["set-cookie"];
  if (!setCookie) return "";
  return Array.isArray(setCookie) ? setCookie[0].split(";")[0] : setCookie.split(";")[0];
}

// Lifecycle Hooks: Connect to isolated test database
test.before(async () => {
  await mongoose.connect(process.env.TEST_MONGO_URL);
  await User.deleteMany({});
  await Listing.deleteMany({});
});

test.after(async () => {
  // Clean up isolated test data
  if (mongoose.connection.readyState === 1) {
    await User.deleteMany({});
    await Listing.deleteMany({});
    await mongoose.connection.close();
  }
  if (store && typeof store.close === "function") {
    await store.close();
  }
});

test.describe("StayNest Authentication & Security Test Suite", () => {
  test("1. Registration accepts valid input and persists user", async () => {
    // 1a. Fetch signup form to obtain session and CSRF token
    const getRes = await request(app).get("/signup");
    assert.equal(getRes.status, 200);
    const csrfToken = extractCsrfToken(getRes.text);
    const cookie = extractCookie(getRes);
    assert.ok(csrfToken, "CSRF token must be present in signup form");
    assert.ok(cookie, "Session cookie must be established");

    // 1b. Post valid registration
    const postRes = await request(app)
      .post("/signup")
      .set("Cookie", cookie)
      .send({
        name: "Alice Tester",
        email: "alice@example.com",
        password: "SuperSecurePassword123!",
        _csrf: csrfToken,
      });

    assert.equal(postRes.status, 302);
    assert.equal(postRes.headers.location, "/listings");

    // 1c. Verify persisted record in test database
    const user = await User.findOne({ email: "alice@example.com" });
    assert.ok(user, "User must be found in database");
    assert.equal(user.name, "Alice Tester");
    assert.equal(user.email, "alice@example.com");
  });

  test("2. Passwords are hashed with bcrypt and plaintext is never stored or exposed", async () => {
    const user = await User.findOne({ email: "alice@example.com" });
    assert.ok(user);
    // Plaintext password should not be stored
    assert.notEqual(user.password, "SuperSecurePassword123!");
    // Bcrypt hash verification
    const isMatch = await bcrypt.compare("SuperSecurePassword123!", user.password);
    assert.equal(isMatch, true, "Bcrypt must verify password correctly");
    // Verification using model method
    const modelVerify = await user.comparePassword("SuperSecurePassword123!");
    assert.equal(modelVerify, true);

    // Ensure password is not leaked in toJSON / toObject
    const jsonUser = user.toJSON();
    assert.equal(jsonUser.password, undefined, "password field must be deleted in toJSON");
    const objUser = user.toObject();
    assert.equal(objUser.password, undefined, "password field must be deleted in toObject");
  });

  test("3. Registration rejects invalid inputs (short password, bad email, short name)", async () => {
    const getRes = await request(app).get("/signup");
    const csrfToken = extractCsrfToken(getRes.text);
    const cookie = extractCookie(getRes);

    // Short password
    const shortPassRes = await request(app)
      .post("/signup")
      .set("Cookie", cookie)
      .send({
        name: "Bob",
        email: "bob@example.com",
        password: "short",
        _csrf: csrfToken,
      });
    assert.equal(shortPassRes.status, 400);

    // Invalid email format
    const badEmailRes = await request(app)
      .post("/signup")
      .set("Cookie", cookie)
      .send({
        name: "Bob",
        email: "not-an-email",
        password: "ValidPassword123!",
        _csrf: csrfToken,
      });
    assert.equal(badEmailRes.status, 400);

    // Missing name
    const missingNameRes = await request(app)
      .post("/signup")
      .set("Cookie", cookie)
      .send({
        name: "",
        email: "bob2@example.com",
        password: "ValidPassword123!",
        _csrf: csrfToken,
      });
    assert.equal(missingNameRes.status, 400);
  });

  test("4. Duplicate email registration is prevented with a 409 status", async () => {
    const getRes = await request(app).get("/signup");
    const csrfToken = extractCsrfToken(getRes.text);
    const cookie = extractCookie(getRes);

    // Try to register with Alice's email again
    const dupRes = await request(app)
      .post("/signup")
      .set("Cookie", cookie)
      .send({
        name: "Alice Imposter",
        email: "ALICE@example.com", // testing normalization
        password: "AnotherPassword123!",
        _csrf: csrfToken,
      });

    assert.equal(dupRes.status, 409);
    assert.match(dupRes.text, /already exists/i);
  });

  test("5. Login accepts valid credentials and sets session", async () => {
    const getRes = await request(app).get("/login");
    const csrfToken = extractCsrfToken(getRes.text);
    const cookie = extractCookie(getRes);

    const loginRes = await request(app)
      .post("/login")
      .set("Cookie", cookie)
      .send({
        email: "alice@example.com",
        password: "SuperSecurePassword123!",
        _csrf: csrfToken,
      });

    assert.equal(loginRes.status, 302);
    assert.equal(loginRes.headers.location, "/listings");
    const authCookie = extractCookie(loginRes);
    assert.ok(authCookie, "New session cookie must be issued on login");
  });

  test("6. Login rejects invalid password and non-existent email with generic message", async () => {
    const getRes = await request(app).get("/login");
    const csrfToken = extractCsrfToken(getRes.text);
    const cookie = extractCookie(getRes);

    // Wrong password
    const wrongPassRes = await request(app)
      .post("/login")
      .set("Cookie", cookie)
      .send({
        email: "alice@example.com",
        password: "WrongPassword!",
        _csrf: csrfToken,
      });
    assert.equal(wrongPassRes.status, 401);
    assert.match(wrongPassRes.text, /Invalid email or password/i);

    // Non-existent user (should receive exact same message)
    const noUserRes = await request(app)
      .post("/login")
      .set("Cookie", cookie)
      .send({
        email: "ghost@example.com",
        password: "SomePassword123!",
        _csrf: csrfToken,
      });
    assert.equal(noUserRes.status, 401);
    assert.match(noUserRes.text, /Invalid email or password/i);
  });

  test("7. Logout destroys session and redirects to /listings", async () => {
    // 7a. Log in first
    const loginGet = await request(app).get("/login");
    const loginCsrf = extractCsrfToken(loginGet.text);
    let cookie = extractCookie(loginGet);

    const loginPost = await request(app)
      .post("/login")
      .set("Cookie", cookie)
      .send({
        email: "alice@example.com",
        password: "SuperSecurePassword123!",
        _csrf: loginCsrf,
      });
    cookie = extractCookie(loginPost);

    // 7b. Access page to get new CSRF token for the authenticated session
    const listGet = await request(app).get("/listings").set("Cookie", cookie);
    assert.equal(listGet.status, 200);
    assert.match(listGet.text, /Alice Tester/i, "Navbar must show user name when logged in");
    assert.match(listGet.text, /Log out/i, "Navbar must show Log out button");
    const authCsrf = extractCsrfToken(listGet.text);

    // 7c. Post logout
    const logoutRes = await request(app)
      .post("/logout")
      .set("Cookie", cookie)
      .send({ _csrf: authCsrf });

    assert.equal(logoutRes.status, 302);
    assert.equal(logoutRes.headers.location, "/listings");

    // 7d. Verify subsequent request has no user in navbar
    const afterLogout = await request(app).get("/listings").set("Cookie", cookie);
    assert.match(afterLogout.text, /Log in/i);
    assert.match(afterLogout.text, /Sign up/i);
  });

  test("8. Unauthenticated users cannot access protected routes (/listings/new, edit, create, delete)", async () => {
    // GET /listings/new
    const newRes = await request(app).get("/listings/new");
    assert.equal(newRes.status, 302);
    assert.equal(newRes.headers.location, "/login");

    // POST /listings
    const postRes = await request(app).post("/listings").send({
      listing: { title: "Hacker Stay" },
    });
    // Should be rejected (redirected to /login or blocked by CSRF/Auth)
    assert.ok(postRes.status === 302 || postRes.status === 403);

    // GET /listings/:id/edit
    const editRes = await request(app).get("/listings/507f1f77bcf86cd799439011/edit");
    assert.equal(editRes.status, 302);
    assert.equal(editRes.headers.location, "/login");
  });

  test("9. Public listing browsing remains functional for anonymous users", async () => {
    // Create a temporary sample listing in test DB
    const sample = new Listing({
      title: "Test Beach Villa",
      description: "A lovely test villa",
      price: 2500,
      location: "Goa",
      country: "India",
      image: { url: "https://example.com/photo.jpg" },
    });
    await sample.save();

    // GET /listings
    const indexRes = await request(app).get("/listings");
    assert.equal(indexRes.status, 200);
    assert.match(indexRes.text, /Test Beach Villa/i);

    // GET /listings/:id
    const showRes = await request(app).get(`/listings/${sample._id}`);
    assert.equal(showRes.status, 200);
    assert.match(showRes.text, /A lovely test villa/i);
  });

  test("10. CSRF protection blocks requests missing a valid token", async () => {
    const getRes = await request(app).get("/signup");
    const cookie = extractCookie(getRes);

    // Missing CSRF token
    const noCsrfRes = await request(app)
      .post("/signup")
      .set("Cookie", cookie)
      .send({
        name: "Charlie",
        email: "charlie@example.com",
        password: "ValidPassword123!",
      });
    assert.equal(noCsrfRes.status, 403);
    assert.match(noCsrfRes.text, /CSRF token/i);

    // Invalid / forged CSRF token
    const badCsrfRes = await request(app)
      .post("/signup")
      .set("Cookie", cookie)
      .send({
        name: "Charlie",
        email: "charlie@example.com",
        password: "ValidPassword123!",
        _csrf: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      });
    assert.equal(badCsrfRes.status, 403);
  });

  test("11. Safe handling of malformed input and non-existent IDs without leaking stack traces", async () => {
    // Malformed ObjectId
    const malformedRes = await request(app).get("/listings/invalid-non-hex-id");
    assert.equal(malformedRes.status, 302);
    assert.equal(malformedRes.headers.location, "/listings");

    // Non-existent 24-character hex ID
    const notFoundRes = await request(app).get("/listings/000000000000000000000000");
    assert.equal(notFoundRes.status, 302);
    assert.equal(notFoundRes.headers.location, "/listings");

    // 404 Route
    const pageNotFoundRes = await request(app).get("/non-existent-random-route-path");
    assert.equal(pageNotFoundRes.status, 404);
    assert.match(pageNotFoundRes.text, /Page Not Found/i);
  });

  test("12. Authentication rate limiting blocks excessive attempts with a 429 status", async () => {
    const { createAuthLimiter } = require("../middleware/auth.js");
    const express = require("express");
    const testApp = express();
    testApp.set("view engine", "ejs");
    testApp.set("views", require("path").join(__dirname, "../views"));
    testApp.engine("ejs", require("ejs-mate"));

    const testLimiter = createAuthLimiter({ max: 2, windowMs: 60000 });
    testApp.get("/rate-test", testLimiter, (req, res) => res.send("allowed"));

    // Request 1: allowed
    const res1 = await request(testApp).get("/rate-test");
    assert.equal(res1.status, 200);

    // Request 2: allowed
    const res2 = await request(testApp).get("/rate-test");
    assert.equal(res2.status, 200);

    // Request 3: blocked by rate limiter -> 429
    const res3 = await request(testApp).get("/rate-test");
    assert.equal(res3.status, 429);
    assert.match(res3.text, /Too many requests/i);
  });
});

