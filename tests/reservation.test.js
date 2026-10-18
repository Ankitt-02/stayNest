// Set test environment variables BEFORE requiring application modules
process.env.NODE_ENV = "test";
process.env.TEST_MONGO_URL = "mongodb://127.0.0.1:27017/staynest_reservation_test";
process.env.SESSION_SECRET = "staynest_reservation_test_secret_1234567890";

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
const Reservation = require("../models/reservation.js");

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

  const listRes = await request(app).get("/listings").set("Cookie", authCookie);
  const authCsrf = extractCsrfToken(listRes.text);

  return { user, authCookie, authCsrf };
}

// Generate valid future date strings guaranteed to be in the future
function getFutureDates(offsetDays = 20, stayLength = 4) {
  const now = new Date();
  const d1 = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate() + offsetDays));
  const d2 = new Date(d1.getTime() + stayLength * 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const inStr = `${d1.getUTCFullYear()}-${pad(d1.getUTCMonth() + 1)}-${pad(d1.getUTCDate())}`;
  const outStr = `${d2.getUTCFullYear()}-${pad(d2.getUTCMonth() + 1)}-${pad(d2.getUTCDate())}`;
  return { inStr, outStr, d1, d2, nights: stayLength };
}

test.describe("StayNest Reservations & Availability System Test Suite", () => {
  let userA, userB;
  let testListing1, testListing2;

  test.before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.TEST_MONGO_URL);
    }
    // Clean test collections
    await User.deleteMany({});
    await Listing.deleteMany({});
    await Reservation.deleteMany({});

    // Create test users
    userA = await createAuthenticatedUser("Alice Traveler", "alice.book@example.com", "SecurePassword123!");
    userB = await createAuthenticatedUser("Bob Explorer", "bob.book@example.com", "SecurePassword123!");

    // Create deterministic test listings (testListing1: 10000/night, testListing2: 5000/night)
    testListing1 = await Listing.create({
      title: "Alpine Lake Haven",
      description: "Picturesque alpine stay overlooking peaceful waters.",
      location: "Manali",
      country: "India",
      price: 10000,
      image: { filename: "alpine", url: "https://example.com/alpine.jpg" },
    });

    testListing2 = await Listing.create({
      title: "Sunny Coastal Studio",
      description: "Charming studio seconds from the beach.",
      location: "Goa",
      country: "India",
      price: 5000,
      image: { filename: "coastal", url: "https://example.com/coastal.jpg" },
    });
  });

  test.after(async () => {
    try {
      await User.deleteMany({});
      await Listing.deleteMany({});
      await Reservation.deleteMany({});
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

  test("1. Public visitors can still browse listing pages", async () => {
    const res = await request(app).get(`/listings/${testListing1._id}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /Alpine Lake Haven/);
    assert.match(res.text, /Sign In to Reserve/);
  });

  test("2. An unauthenticated user cannot create a reservation", async () => {
    // 2a. GET /listings/:id/reservations/new requires authentication
    const getNewRes = await request(app).get(`/listings/${testListing1._id}/reservations/new`);
    assert.equal(getNewRes.status, 302);
    assert.match(getNewRes.headers.location, /\/login/);

    // 2b. POST /listings/:id/reservations requires authentication
    const anonVisit = await request(app).get(`/listings/${testListing1._id}`);
    const anonCsrf = extractCsrfToken(anonVisit.text);
    const anonCookie = extractCookie(anonVisit);

    const { inStr, outStr } = getFutureDates(10, 3);
    const res = await request(app)
      .post(`/listings/${testListing1._id}/reservations`)
      .set("Cookie", anonCookie)
      .send({
        checkIn: inStr,
        checkOut: outStr,
        guests: 2,
        _csrf: anonCsrf,
      });

    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/login/);

    const count = await Reservation.countDocuments({});
    assert.equal(count, 0);
  });

  test("3. An authenticated user can reserve an available listing", async () => {
    const { inStr, outStr, nights } = getFutureDates(10, 4);
    const res = await request(app)
      .post(`/listings/${testListing1._id}/reservations`)
      .set("Cookie", userA.authCookie)
      .send({
        checkIn: inStr,
        checkOut: outStr,
        guests: 2,
        _csrf: userA.authCsrf,
      });

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/reservations");

    const created = await Reservation.findOne({
      listing: testListing1._id,
      user: userA.user._id,
    });
    assert.ok(created);
    assert.equal(created.status, "CONFIRMED");
    assert.equal(created.guests, 2);
    assert.equal(created.totalPrice, testListing1.price * nights); // 10000 * 4 = 40000
  });

  test("4. Reservation ownership is derived from the authenticated session", async () => {
    const reservation = await Reservation.findOne({ listing: testListing1._id });
    assert.ok(reservation);
    assert.equal(reservation.user.toString(), userA.user._id.toString());
  });

  test("5. Submitted user IDs and total prices cannot override server-derived values", async () => {
    const { inStr, outStr, nights } = getFutureDates(20, 3);
    const fakePrice = 1; // Attempt to tamper price
    const res = await request(app)
      .post(`/listings/${testListing1._id}/reservations`)
      .set("Cookie", userA.authCookie)
      .send({
        checkIn: inStr,
        checkOut: outStr,
        guests: 2,
        totalPrice: fakePrice,
        user: userB.user._id, // Attempt to attribute to userB
        status: "CANCELLED", // Attempt to tamper status
        _csrf: userA.authCsrf,
      });

    assert.equal(res.status, 302);

    const created = await Reservation.findOne({ checkIn: new Date(inStr + "T00:00:00.000Z") });
    assert.ok(created);
    // User must be userA, NOT userB
    assert.equal(created.user.toString(), userA.user._id.toString());
    // Price must be server-calculated (10000 * 3 = 30000), NOT 1
    assert.equal(created.totalPrice, testListing1.price * nights);
    assert.equal(created.status, "CONFIRMED");
  });

  test("6. Invalid dates are rejected", async () => {
    // Nonexistent calendar date Feb 31
    const res = await request(app)
      .post(`/listings/${testListing1._id}/reservations`)
      .set("Cookie", userA.authCookie)
      .send({
        checkIn: "2027-02-31",
        checkOut: "2027-03-05",
        guests: 2,
        _csrf: userA.authCsrf,
      });

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `/listings/${testListing1._id}`);

    // Arbitrary string
    const res2 = await request(app)
      .post(`/listings/${testListing1._id}/reservations`)
      .set("Cookie", userA.authCookie)
      .send({
        checkIn: "not-a-date",
        checkOut: "also-not-a-date",
        guests: 2,
        _csrf: userA.authCsrf,
      });

    assert.equal(res2.status, 302);
    assert.equal(res2.headers.location, `/listings/${testListing1._id}`);
  });

  test("7. Check-out on or before check-in is rejected", async () => {
    const { inStr } = getFutureDates(30, 0);

    // Same-day check-in and check-out (0 nights)
    const resSame = await request(app)
      .post(`/listings/${testListing1._id}/reservations`)
      .set("Cookie", userA.authCookie)
      .send({
        checkIn: inStr,
        checkOut: inStr,
        guests: 2,
        _csrf: userA.authCsrf,
      });

    assert.equal(resSame.status, 302);
    assert.equal(resSame.headers.location, `/listings/${testListing1._id}`);

    // Check-out before check-in (negative nights)
    const resReversed = await request(app)
      .post(`/listings/${testListing1._id}/reservations`)
      .set("Cookie", userA.authCookie)
      .send({
        checkIn: "2027-06-15",
        checkOut: "2027-06-10",
        guests: 2,
        _csrf: userA.authCsrf,
      });

    assert.equal(resReversed.status, 302);
    assert.equal(resReversed.headers.location, `/listings/${testListing1._id}`);
  });

  test("8. Past check-in dates are rejected", async () => {
    const res = await request(app)
      .post(`/listings/${testListing1._id}/reservations`)
      .set("Cookie", userA.authCookie)
      .send({
        checkIn: "2020-01-01",
        checkOut: "2020-01-05",
        guests: 2,
        _csrf: userA.authCsrf,
      });

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `/listings/${testListing1._id}`);
  });

  test("9. Guest counts that are missing, non-integer, zero, or negative are rejected", async () => {
    const { inStr, outStr } = getFutureDates(40, 3);

    const badGuests = [0, -2, "abc", "1.5", "", null];
    for (const bg of badGuests) {
      const res = await request(app)
        .post(`/listings/${testListing1._id}/reservations`)
        .set("Cookie", userA.authCookie)
        .send({
          checkIn: inStr,
          checkOut: outStr,
          guests: bg,
          _csrf: userA.authCsrf,
        });

      assert.equal(res.status, 302);
      assert.equal(res.headers.location, `/listings/${testListing1._id}`);
    }
  });

  test("10. Nonexistent listings are handled safely", async () => {
    const { inStr, outStr } = getFutureDates(50, 3);
    const nonId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .post(`/listings/${nonId}/reservations`)
      .set("Cookie", userA.authCookie)
      .send({
        checkIn: inStr,
        checkOut: outStr,
        guests: 2,
        _csrf: userA.authCsrf,
      });

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/listings");
  });

  test("11. Total price is calculated correctly from listing rate and stay duration", async () => {
    // 5 nights at 5000/night = 25000
    const { inStr, outStr, nights } = getFutureDates(60, 5);
    const res = await request(app)
      .post(`/listings/${testListing2._id}/reservations`)
      .set("Cookie", userB.authCookie)
      .send({
        checkIn: inStr,
        checkOut: outStr,
        guests: 3,
        _csrf: userB.authCsrf,
      });

    assert.equal(res.status, 302);
    const created = await Reservation.findOne({
      listing: testListing2._id,
      user: userB.user._id,
    });
    assert.ok(created);
    assert.equal(created.totalPrice, 25000);
    assert.equal(nights, 5);
  });

  test("12. An overlapping reservation for the same listing is rejected", async () => {
    // Existing: days 10 to 14 from test 3 on testListing1
    const { inStr: baseIn, outStr: baseOut } = getFutureDates(10, 4); // inStr = day 10, outStr = day 14

    // Attempt overlapping reservation: days 12 to 16
    const { inStr: overlapIn, outStr: overlapOut } = getFutureDates(12, 4);

    const res = await request(app)
      .post(`/listings/${testListing1._id}/reservations`)
      .set("Cookie", userB.authCookie)
      .send({
        checkIn: overlapIn,
        checkOut: overlapOut,
        guests: 1,
        _csrf: userB.authCsrf,
      });

    // Must be rejected and redirected back to show page
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `/listings/${testListing1._id}`);

    // Verify userB reservation was NOT created
    const attempt = await Reservation.findOne({
      listing: testListing1._id,
      user: userB.user._id,
      checkIn: new Date(overlapIn + "T00:00:00.000Z"),
    });
    assert.equal(attempt, null);
  });

  test("13. Back-to-back reservations are allowed", async () => {
    // Existing on testListing1: days 10 to 14
    // Back-to-back: checkIn = day 14, checkOut = day 18
    const { outStr: baseOut } = getFutureDates(10, 4); // day 14
    const { outStr: nextOut } = getFutureDates(14, 4); // day 18

    const res = await request(app)
      .post(`/listings/${testListing1._id}/reservations`)
      .set("Cookie", userB.authCookie)
      .send({
        checkIn: baseOut, // 14
        checkOut: nextOut, // 18
        guests: 2,
        _csrf: userB.authCsrf,
      });

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/reservations");

    const b2b = await Reservation.findOne({
      listing: testListing1._id,
      user: userB.user._id,
      checkIn: new Date(baseOut + "T00:00:00.000Z"),
    });
    assert.ok(b2b);
    assert.equal(b2b.status, "CONFIRMED");
  });

  test("14. Reservations for different listings do not conflict", async () => {
    // Same dates as test 13 (days 14 to 18) but on testListing2
    const { outStr: baseOut } = getFutureDates(10, 4);
    const { outStr: nextOut } = getFutureDates(14, 4);

    const res = await request(app)
      .post(`/listings/${testListing2._id}/reservations`)
      .set("Cookie", userA.authCookie)
      .send({
        checkIn: baseOut,
        checkOut: nextOut,
        guests: 2,
        _csrf: userA.authCsrf,
      });

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/reservations");

    const created = await Reservation.findOne({
      listing: testListing2._id,
      checkIn: new Date(baseOut + "T00:00:00.000Z"),
    });
    assert.ok(created);
  });

  test("15. Cancelled reservations no longer block the dates", async () => {
    // 1. Create a reservation on testListing2
    const { inStr, outStr } = getFutureDates(70, 3);
    const createRes = await request(app)
      .post(`/listings/${testListing2._id}/reservations`)
      .set("Cookie", userA.authCookie)
      .send({
        checkIn: inStr,
        checkOut: outStr,
        guests: 2,
        _csrf: userA.authCsrf,
      });
    assert.equal(createRes.status, 302);

    const resRecord = await Reservation.findOne({
      listing: testListing2._id,
      checkIn: new Date(inStr + "T00:00:00.000Z"),
    });
    assert.ok(resRecord);

    // 2. Cancel the reservation
    const cancelRes = await request(app)
      .post(`/reservations/${resRecord._id}/cancel`)
      .set("Cookie", userA.authCookie)
      .send({ _csrf: userA.authCsrf });

    assert.equal(cancelRes.status, 302);

    const cancelledDoc = await Reservation.findById(resRecord._id);
    assert.equal(cancelledDoc.status, "CANCELLED");

    // 3. User B can now book the exact same dates!
    const rebookRes = await request(app)
      .post(`/listings/${testListing2._id}/reservations`)
      .set("Cookie", userB.authCookie)
      .send({
        checkIn: inStr,
        checkOut: outStr,
        guests: 2,
        _csrf: userB.authCsrf,
      });

    assert.equal(rebookRes.status, 302);
    assert.equal(rebookRes.headers.location, "/reservations");

    const newBooking = await Reservation.findOne({
      listing: testListing2._id,
      user: userB.user._id,
      status: "CONFIRMED",
      checkIn: new Date(inStr + "T00:00:00.000Z"),
    });
    assert.ok(newBooking);
  });

  test("16. Users can see their own reservations", async () => {
    const res = await request(app).get("/reservations").set("Cookie", userA.authCookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /My Reservations/);
    assert.match(res.text, /Alpine Lake Haven/);
  });

  test("17. Users cannot see another user's private reservations", async () => {
    // User A should see Alpine Lake Haven, but NOT Sunny Coastal Studio booked only by user B
    const resA = await request(app).get("/reservations").set("Cookie", userA.authCookie);
    assert.equal(resA.status, 200);

    // Verify user B's exclusive reservation isn't displayed on user A's dashboard
    const userBExclusiveBooking = await Reservation.findOne({
      user: userB.user._id,
      listing: testListing2._id,
      guests: 3,
    });
    assert.ok(userBExclusiveBooking);

    // Fetch user A's page and ensure only user A's bookings are rendered
    assert.doesNotMatch(resA.text, /3 guests/);
  });

  test("18. Users cannot cancel another user's reservation", async () => {
    // User B attempts to cancel User A's reservation
    const userABooking = await Reservation.findOne({
      user: userA.user._id,
      status: "CONFIRMED",
    });
    assert.ok(userABooking);

    const cancelRes = await request(app)
      .post(`/reservations/${userABooking._id}/cancel`)
      .set("Cookie", userB.authCookie)
      .send({ _csrf: userB.authCsrf });

    // Must be rejected with 403 Forbidden
    assert.equal(cancelRes.status, 403);
    assert.match(cancelRes.text, /Forbidden/i);

    // Status remains CONFIRMED
    const doc = await Reservation.findById(userABooking._id);
    assert.equal(doc.status, "CONFIRMED");
  });

  test("19. Unauthenticated users cannot cancel reservations", async () => {
    const userABooking = await Reservation.findOne({
      user: userA.user._id,
      status: "CONFIRMED",
    });

    const anonVisit = await request(app).get(`/listings/${testListing1._id}`);
    const anonCsrf = extractCsrfToken(anonVisit.text);
    const anonCookie = extractCookie(anonVisit);

    const cancelRes = await request(app)
      .post(`/reservations/${userABooking._id}/cancel`)
      .set("Cookie", anonCookie)
      .send({ _csrf: anonCsrf });

    assert.equal(cancelRes.status, 302);
    assert.match(cancelRes.headers.location, /\/login/);
  });

  test("20. CSRF protection remains active on reservation actions", async () => {
    const { inStr, outStr } = getFutureDates(80, 2);

    // Missing CSRF token
    const res = await request(app)
      .post(`/listings/${testListing1._id}/reservations`)
      .set("Cookie", userA.authCookie)
      .send({
        checkIn: inStr,
        checkOut: outStr,
        guests: 2,
      });

    assert.equal(res.status, 403);
    assert.match(res.text, /Security check failed/i);
  });

  test("21. A cancelled reservation remains in the database with status CANCELLED", async () => {
    const cancelledDocs = await Reservation.find({ status: "CANCELLED" });
    assert.ok(cancelledDocs.length > 0);
    // Historical record exists
    assert.equal(cancelledDocs[0].status, "CANCELLED");
  });

  test("22. Dedicated reservation form view GET /listings/:id/reservations/new works", async () => {
    const res = await request(app)
      .get(`/listings/${testListing1._id}/reservations/new`)
      .set("Cookie", userA.authCookie);

    assert.equal(res.status, 200);
    assert.match(res.text, /Alpine Lake Haven/);
    assert.match(res.text, /Confirm Reservation/);
  });

  test("23. Concurrent reservation attempts for identical dates are handled safely", async () => {
    const { inStr, outStr } = getFutureDates(120, 3);

    // Launch two simultaneous booking requests for identical listing and dates
    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/listings/${testListing1._id}/reservations`)
        .set("Cookie", userA.authCookie)
        .send({
          checkIn: inStr,
          checkOut: outStr,
          guests: 2,
          _csrf: userA.authCsrf,
        }),
      request(app)
        .post(`/listings/${testListing1._id}/reservations`)
        .set("Cookie", userB.authCookie)
        .send({
          checkIn: inStr,
          checkOut: outStr,
          guests: 2,
          _csrf: userB.authCsrf,
        }),
    ]);

    // Both should receive 302 redirects
    assert.equal(res1.status, 302);
    assert.equal(res2.status, 302);

    // Exactly one reservation must be confirmed in the database for those dates
    const confirmedCount = await Reservation.countDocuments({
      listing: testListing1._id,
      status: "CONFIRMED",
      checkIn: new Date(inStr + "T00:00:00.000Z"),
      checkOut: new Date(outStr + "T00:00:00.000Z"),
    });

    assert.equal(confirmedCount, 1, "Only one concurrent reservation should be confirmed");
  });
});
