// Set test environment variables BEFORE requiring application modules
process.env.NODE_ENV = "test";
process.env.TEST_MONGO_URL = "mongodb://127.0.0.1:27017/staynest_ownership_test";
process.env.SESSION_SECRET = "staynest_ownership_test_secret_1234567890";

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

// Helper to register and log in a user, returning their session cookie and a fresh CSRF token
async function createAuthenticatedUser(name, email, password) {
  const signupGet = await request(app).get("/signup");
  const signupCsrf = extractCsrfToken(signupGet.text);
  const initialCookie = extractCookie(signupGet);

  const signupRes = await request(app)
    .post("/signup")
    .set("Cookie", initialCookie)
    .send({
      name,
      email,
      password,
      _csrf: signupCsrf,
    });

  const authCookie = extractCookie(signupRes);
  const user = await User.findOne({ email });

  // Fetch /listings to get an authenticated CSRF token
  const listRes = await request(app).get("/listings").set("Cookie", authCookie);
  const authCsrf = extractCsrfToken(listRes.text);

  return { user, cookie: authCookie, csrfToken: authCsrf };
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

test.describe("StayNest Listing Ownership & Authorization Security", () => {
  let userA, userB;
  let listingA;
  let legacyListing;

  test("Setup: Create User A, User B, and Legacy Listing", async () => {
    userA = await createAuthenticatedUser("Host Alice", "owner_alice@example.com", "Password12345!");
    userB = await createAuthenticatedUser("Attacker Bob", "attacker_bob@example.com", "Password12345!");

    // Create a legacy listing directly in DB with NO owner field
    legacyListing = new Listing({
      title: "Heritage Unowned Haveli",
      description: "An authentic historic haveli from before the ownership migration.",
      price: 5000,
      location: "Jaipur",
      country: "India",
      image: { url: "https://example.com/haveli.jpg" },
      // owner is intentionally omitted / undefined
    });
    await legacyListing.save();

    assert.ok(userA.user, "User A must exist");
    assert.ok(userB.user, "User B must exist");
    assert.ok(legacyListing._id, "Legacy listing must exist");
    assert.equal(legacyListing.owner, undefined, "Legacy listing must have no owner");
  });

  test("1. An anonymous visitor can browse public listings", async () => {
    const res = await request(app).get("/listings");
    assert.equal(res.status, 200);
    assert.match(res.text, /All Stays/i);
    assert.match(res.text, /Heritage Unowned Haveli/i);
  });

  test("2. An authenticated user can create a listing", async () => {
    // 2a. Fetch new form
    const formRes = await request(app)
      .get("/listings/new")
      .set("Cookie", userA.cookie);
    assert.equal(formRes.status, 200);
    const csrfToken = extractCsrfToken(formRes.text);

    // 2b. Post new listing as User A
    const postRes = await request(app)
      .post("/listings")
      .set("Cookie", userA.cookie)
      .send({
        listing: {
          title: "Alice's Seaside Villa",
          description: "Stunning private beach access and sunset patio.",
          price: 3200,
          location: "Goa",
          country: "India",
          image: { url: "https://example.com/alice_villa.jpg" },
        },
        _csrf: csrfToken,
      });

    assert.equal(postRes.status, 302);
    assert.equal(postRes.headers.location, "/listings");

    listingA = await Listing.findOne({ title: "Alice's Seaside Villa" });
    assert.ok(listingA, "Listing created by User A must be saved");
  });

  test("3. A newly created listing is assigned to the authenticated user", async () => {
    assert.ok(listingA.owner, "Listing must have an owner");
    assert.equal(
      listingA.owner.toString(),
      userA.user._id.toString(),
      "Listing owner must match User A's ID"
    );
  });

  test("4. A submitted fake owner ID cannot override the authenticated identity", async () => {
    const fakeOwnerId = new mongoose.Types.ObjectId();
    const formRes = await request(app)
      .get("/listings/new")
      .set("Cookie", userA.cookie);
    const csrfToken = extractCsrfToken(formRes.text);

    const postRes = await request(app)
      .post("/listings")
      .set("Cookie", userA.cookie)
      .send({
        listing: {
          title: "Alice's Mountain Chalet",
          description: "Cozy cabin with fireplace.",
          price: 2800,
          location: "Manali",
          country: "India",
          owner: fakeOwnerId.toString(), // Attacker attempt to spoof owner
          ownerId: fakeOwnerId.toString(),
        },
        _csrf: csrfToken,
      });

    assert.equal(postRes.status, 302);
    const createdListing = await Listing.findOne({ title: "Alice's Mountain Chalet" });
    assert.ok(createdListing);
    assert.notEqual(
      createdListing.owner.toString(),
      fakeOwnerId.toString(),
      "Fake owner ID must NOT be assigned"
    );
    assert.equal(
      createdListing.owner.toString(),
      userA.user._id.toString(),
      "Server-side authenticated ID must be assigned instead"
    );
  });

  test("5. The owner can open their listing's edit page", async () => {
    const editRes = await request(app)
      .get(`/listings/${listingA._id}/edit`)
      .set("Cookie", userA.cookie);

    assert.equal(editRes.status, 200);
    assert.match(editRes.text, /Edit your listing/i);
    assert.match(editRes.text, /Alice&#39;s Seaside Villa/i);
  });

  test("6. The owner can update their listing successfully", async () => {
    const editGet = await request(app)
      .get(`/listings/${listingA._id}/edit`)
      .set("Cookie", userA.cookie);
    const csrfToken = extractCsrfToken(editGet.text);

    const updateRes = await request(app)
      .put(`/listings/${listingA._id}`)
      .set("Cookie", userA.cookie)
      .send({
        listing: {
          title: "Alice's Seaside Villa (Updated)",
          description: "Updated description with private heated pool.",
          price: 3500,
          location: "Goa",
          country: "India",
          image: { url: "https://example.com/updated.jpg" },
        },
        _csrf: csrfToken,
      });

    assert.equal(updateRes.status, 302);
    assert.equal(updateRes.headers.location, `/listings/${listingA._id}`);

    const updatedListing = await Listing.findById(listingA._id);
    assert.equal(updatedListing.title, "Alice's Seaside Villa (Updated)");
    assert.equal(updatedListing.price, 3500);
    assert.equal(updatedListing.owner.toString(), userA.user._id.toString());
  });

  test("7. The owner can delete their listing successfully (tested on secondary listing)", async () => {
    // Create a temporary listing for User A to delete
    const tempListing = new Listing({
      title: "Temporary Listing to Delete",
      description: "Will be removed by owner",
      price: 1000,
      location: "Delhi",
      country: "India",
      owner: userA.user._id,
      image: { url: "https://example.com/temp.jpg" },
    });
    await tempListing.save();

    const showRes = await request(app)
      .get(`/listings/${tempListing._id}`)
      .set("Cookie", userA.cookie);
    const csrfToken = extractCsrfToken(showRes.text);

    const deleteRes = await request(app)
      .delete(`/listings/${tempListing._id}`)
      .set("Cookie", userA.cookie)
      .send({ _csrf: csrfToken });

    assert.equal(deleteRes.status, 302);
    assert.equal(deleteRes.headers.location, "/listings");

    const exists = await Listing.findById(tempListing._id);
    assert.equal(exists, null, "Listing must be deleted from database");
  });

  test("8. User B cannot open User A's edit page (403 Forbidden)", async () => {
    const editRes = await request(app)
      .get(`/listings/${listingA._id}/edit`)
      .set("Cookie", userB.cookie);

    assert.equal(editRes.status, 403, "Must return 403 Forbidden for non-owner");
    assert.match(editRes.text, /Forbidden|permission/i);
  });

  test("9. User B cannot update User A's listing (403 Forbidden)", async () => {
    // Get fresh CSRF token for User B's session
    const listRes = await request(app)
      .get("/listings")
      .set("Cookie", userB.cookie);
    const csrfToken = extractCsrfToken(listRes.text);

    const updateRes = await request(app)
      .put(`/listings/${listingA._id}`)
      .set("Cookie", userB.cookie)
      .send({
        listing: {
          title: "HACKED BY BOB",
          description: "Malicious override attempt",
          price: 1,
        },
        _csrf: csrfToken,
      });

    assert.equal(updateRes.status, 403, "Must return 403 Forbidden for non-owner update");
    assert.match(updateRes.text, /Forbidden|permission/i);
  });

  test("10. User B cannot delete User A's listing (403 Forbidden)", async () => {
    const listRes = await request(app)
      .get("/listings")
      .set("Cookie", userB.cookie);
    const csrfToken = extractCsrfToken(listRes.text);

    const deleteRes = await request(app)
      .delete(`/listings/${listingA._id}`)
      .set("Cookie", userB.cookie)
      .send({ _csrf: csrfToken });

    assert.equal(deleteRes.status, 403, "Must return 403 Forbidden for non-owner delete");
    assert.match(deleteRes.text, /Forbidden|permission/i);
  });

  test("11. User B's unauthorized requests leave User A's listing completely unchanged", async () => {
    const recordInDb = await Listing.findById(listingA._id);
    assert.ok(recordInDb);
    assert.equal(recordInDb.title, "Alice's Seaside Villa (Updated)");
    assert.notEqual(recordInDb.title, "HACKED BY BOB");
    assert.equal(recordInDb.price, 3500);
    assert.equal(recordInDb.owner.toString(), userA.user._id.toString());
  });

  test("12. Legacy listings without owners remain publicly viewable", async () => {
    const showRes = await request(app).get(`/listings/${legacyListing._id}`);
    assert.equal(showRes.status, 200);
    assert.match(showRes.text, /Heritage Unowned Haveli/i);
    assert.match(showRes.text, /StayNest Community Host/i);

    // Edit and Delete buttons must NOT be rendered
    assert.doesNotMatch(showRes.text, /Edit<\/a>/i);
  });

  test("13. Legacy listings without owners cannot be modified or deleted by ordinary users (403)", async () => {
    // User A attempts to edit legacy listing
    const editRes = await request(app)
      .get(`/listings/${legacyListing._id}/edit`)
      .set("Cookie", userA.cookie);
    assert.equal(editRes.status, 403);
    assert.match(editRes.text, /legacy listing/i);

    // User A attempts to update legacy listing
    const listRes = await request(app).get("/listings").set("Cookie", userA.cookie);
    const csrfToken = extractCsrfToken(listRes.text);

    const putRes = await request(app)
      .put(`/listings/${legacyListing._id}`)
      .set("Cookie", userA.cookie)
      .send({
        listing: { title: "Claimed By Alice" },
        _csrf: csrfToken,
      });
    assert.equal(putRes.status, 403);

    // User A attempts to delete legacy listing
    const delRes = await request(app)
      .delete(`/listings/${legacyListing._id}`)
      .set("Cookie", userA.cookie)
      .send({ _csrf: csrfToken });
    assert.equal(delRes.status, 403);

    // Verify record in DB is unmodified and still has NO owner
    const verifiedLegacy = await Listing.findById(legacyListing._id);
    assert.ok(verifiedLegacy);
    assert.equal(verifiedLegacy.title, "Heritage Unowned Haveli");
    assert.equal(verifiedLegacy.owner, undefined);
  });

  test("14. Anonymous users cannot create, edit, update, or delete listings", async () => {
    // Create form -> 302 /login
    const newRes = await request(app).get("/listings/new");
    assert.equal(newRes.status, 302);
    assert.equal(newRes.headers.location, "/login");

    // Edit form -> 302 /login
    const editRes = await request(app).get(`/listings/${listingA._id}/edit`);
    assert.equal(editRes.status, 302);
    assert.equal(editRes.headers.location, "/login");

    // Anonymous PUT -> rejected (403 CSRF or 302 login)
    const putRes = await request(app).put(`/listings/${listingA._id}`).send({
      listing: { title: "Anon Edit" },
    });
    assert.ok(putRes.status === 302 || putRes.status === 403);

    // Anonymous DELETE -> rejected
    const delRes = await request(app).delete(`/listings/${listingA._id}`).send({});
    assert.ok(delRes.status === 302 || delRes.status === 403);
  });

  test("15. Malformed and nonexistent listing IDs are handled safely without crashing", async () => {
    // Malformed ID on show route -> redirects with flash
    const badIdRes = await request(app).get("/listings/not-a-valid-hex-id");
    assert.equal(badIdRes.status, 302);
    assert.equal(badIdRes.headers.location, "/listings");

    // Nonexistent ID on show route
    const nonExistentRes = await request(app).get("/listings/507f1f77bcf86cd799439011");
    assert.equal(nonExistentRes.status, 302);
    assert.equal(nonExistentRes.headers.location, "/listings");

    // Malformed ID on edit route (authenticated)
    const badEditRes = await request(app)
      .get("/listings/not-a-valid-hex-id/edit")
      .set("Cookie", userA.cookie);
    assert.equal(badEditRes.status, 302);
    assert.equal(badEditRes.headers.location, "/listings");

    // Nonexistent ID on edit route (authenticated)
    const nonExistentEditRes = await request(app)
      .get("/listings/507f1f77bcf86cd799439011/edit")
      .set("Cookie", userA.cookie);
    assert.equal(nonExistentEditRes.status, 302);
    assert.equal(nonExistentEditRes.headers.location, "/listings");
  });
});
