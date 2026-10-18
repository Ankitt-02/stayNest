const express = require("express");
const router = express.Router({ mergeParams: true });
const mongoose = require("mongoose");
const Listing = require("../models/listing.js");
const Reservation = require("../models/reservation.js");
const { isLoggedIn } = require("../middleware/auth.js");

// Pure helper: parse calendar date string 'YYYY-MM-DD' into UTC midnight Date
function parseCalendarDate(dateStr) {
  if (typeof dateStr !== "string") return null;
  const match = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10); // 1-12
  const day = parseInt(match[3], 10);   // 1-31

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Use UTC to avoid local timezone and daylight-saving shifts
  const d = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  // Verify date did not roll over (e.g. Feb 31 -> Mar 3)
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

// Pure helper: get current date at UTC midnight
function getTodayUtc() {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
  );
}

// Pure helper: calculate calendar nights between two UTC dates
function calculateNights(checkInDate, checkOutDate) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((checkOutDate.getTime() - checkInDate.getTime()) / MS_PER_DAY);
}

// Format UTC date to YYYY-MM-DD for HTML5 date inputs
function formatDateForInput(date) {
  if (!date || isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Format UTC date for display (e.g. '10 Jun 2026')
function formatDateDisplay(date) {
  if (!date || isNaN(date.getTime())) return "";
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * Safely creates a reservation within an ACID MongoDB transaction.
 * Uses atomic version increment on the parent Listing document to serialize
 * concurrent reservation requests for the same listing and eliminate phantom insert races.
 *
 * Automatically retries up to maxAttempts on TransientTransactionError / WriteConflict.
 * If the MongoDB deployment does not support transactions, safely fails without unsafe non-transactional fallback.
 *
 * @param {Object} params
 * @param {mongoose.Types.ObjectId|string} params.listingId
 * @param {mongoose.Types.ObjectId|string} params.userId
 * @param {Date} params.checkInDate
 * @param {Date} params.checkOutDate
 * @param {number} params.guestsNum
 * @param {number} params.totalPrice
 * @param {number} [params.maxAttempts=3]
 * @returns {Promise<{ success: boolean, reservation?: Object, reason?: string, error?: Error }>}
 */
async function createReservationWithRetry({
  listingId,
  userId,
  checkInDate,
  checkOutDate,
  guestsNum,
  totalPrice,
  maxAttempts = 3,
}) {
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    let session = null;

    try {
      session = await mongoose.startSession();
      session.startTransaction();

      // 1. Acquire write lock on parent listing via atomic version increment.
      // In WiredTiger snapshot isolation, this creates a write conflict for any concurrent transaction on the same listing,
      // preventing two concurrent transactions from both reading 0 overlapping reservations and inserting duplicates.
      const updateResult = await Listing.updateOne(
        { _id: listingId },
        { $inc: { reservationVersion: 1 } }
      ).session(session);

      if (updateResult.matchedCount === 0) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, reason: "NOT_FOUND" };
      }

      // 2. Query for active overlapping reservations within the serialized transaction snapshot.
      // Overlap condition: existing.checkIn < requested.checkOut AND existing.checkOut > requested.checkIn
      const conflict = await Reservation.findOne({
        listing: listingId,
        status: "CONFIRMED",
        checkIn: { $lt: checkOutDate },
        checkOut: { $gt: checkInDate },
      }).session(session);

      if (conflict) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, reason: "UNAVAILABLE" };
      }

      // 3. Create and save the new confirmed reservation associated with the authenticated user
      const newReservation = new Reservation({
        listing: listingId,
        user: userId,
        checkIn: checkInDate,
        checkOut: checkOutDate,
        guests: guestsNum,
        totalPrice,
        status: "CONFIRMED",
      });

      const savedReservation = await newReservation.save({ session });
      await session.commitTransaction();
      session.endSession();

      return { success: true, reservation: savedReservation };
    } catch (err) {
      if (session) {
        try {
          await session.abortTransaction();
        } catch (_) {}
        try {
          session.endSession();
        } catch (_) {}
      }

      // Identify transient transaction errors: WriteConflict (code 112) or TransientTransactionError label
      const isTransient =
        (err.errorLabels && err.errorLabels.includes("TransientTransactionError")) ||
        (typeof err.hasErrorLabel === "function" && err.hasErrorLabel("TransientTransactionError")) ||
        err.code === 112 ||
        (err.message && err.message.includes("WriteConflict"));

      if (isTransient && attempt < maxAttempts) {
        // Exponential backoff with small random jitter (20-60ms)
        const backoffMs = attempt * 25 + Math.floor(Math.random() * 35);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      // Unsafe standalone fallback is strictly removed.
      // If transactions are unsupported by the MongoDB deployment (e.g. standalone instance),
      // fail safely with a descriptive diagnostic and user-friendly error instead of allowing phantom writes.
      const isUnsupported =
        (err.message &&
          (err.message.includes("Transaction numbers are only allowed") ||
            err.message.includes("standalone") ||
            err.message.includes("Transactions are not supported"))) ||
        err.code === 20;

      if (isUnsupported) {
        console.error(
          "StayNest Concurrency Error: MongoDB deployment does not support replica set transactions. Reservation was safely rejected to prevent uncoordinated race conditions.",
          err
        );
        return { success: false, reason: "TRANSACTIONS_UNSUPPORTED", error: err };
      }

      // Re-throw any other fatal or unexpected errors
      throw err;
    }
  }

  // If retries exhausted due to persistent transient write conflicts
  return { success: false, reason: "UNAVAILABLE" };
}

// ==========================================
// 1. Dedicated Reservation Form View
// ==========================================
router.get("/listings/:id/reservations/new", isLoggedIn, async (req, res, next) => {
  try {
    const { id } = req.params;
    const listing = await Listing.findById(id).populate("owner", "name email");

    if (!listing) {
      req.flash("error", "The listing you requested does not exist.");
      return res.redirect("/listings");
    }

    const today = getTodayUtc();
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

    res.render("reservations/new.ejs", {
      listing,
      todayStr: formatDateForInput(today),
      tomorrowStr: formatDateForInput(tomorrow),
    });
  } catch (err) {
    if (err.name === "CastError") {
      req.flash("error", "Invalid listing identifier.");
      return res.redirect("/listings");
    }
    next(err);
  }
});

// ==========================================
// 2. Create Reservation Endpoint
// ==========================================
router.post("/listings/:id/reservations", isLoggedIn, async (req, res, next) => {
  const { id } = req.params;

  try {
    const listing = await Listing.findById(id);

    if (!listing) {
      req.flash("error", "The listing you requested does not exist.");
      return res.redirect("/listings");
    }

    // Confirm listing has a valid, non-negative rate
    const nightlyPrice = listing.price;
    if (typeof nightlyPrice !== "number" || isNaN(nightlyPrice) || nightlyPrice < 0) {
      req.flash("error", "This property does not have a valid nightly rate configured.");
      return res.redirect(`/listings/${id}`);
    }

    // 1. Validate checkIn and checkOut date strings
    const rawCheckIn = (req.body.reservation && req.body.reservation.checkIn) || req.body.checkIn;
    const rawCheckOut = (req.body.reservation && req.body.reservation.checkOut) || req.body.checkOut;

    const checkInDate = parseCalendarDate(rawCheckIn);
    const checkOutDate = parseCalendarDate(rawCheckOut);

    if (!checkInDate || !checkOutDate) {
      req.flash("error", "Please provide valid check-in and check-out dates (YYYY-MM-DD).");
      return res.redirect(`/listings/${id}`);
    }

    // 2. Validate check-in is today or later
    const today = getTodayUtc();
    if (checkInDate.getTime() < today.getTime()) {
      req.flash("error", "Check-in date cannot be in the past. Please select today or a future date.");
      return res.redirect(`/listings/${id}`);
    }

    // 3. Validate stay duration (checkOut strictly after checkIn)
    const nights = calculateNights(checkInDate, checkOutDate);
    if (nights < 1) {
      req.flash("error", "Check-out date must be strictly after check-in date (at least 1 night).");
      return res.redirect(`/listings/${id}`);
    }

    // 4. Validate guests: must be positive integer
    const rawGuests = (req.body.reservation && req.body.reservation.guests) || req.body.guests;
    const guestsStr = typeof rawGuests === "string" ? rawGuests.trim() : String(rawGuests || "");
    const guestsNum = parseInt(guestsStr, 10);

    if (
      isNaN(guestsNum) ||
      !Number.isInteger(Number(guestsStr)) ||
      guestsNum < 1 ||
      String(guestsNum) !== guestsStr
    ) {
      req.flash("error", "Number of guests must be a positive whole integer (at least 1).");
      return res.redirect(`/listings/${id}`);
    }

    // 5. Server-derived total price: strictly calculate on server
    const totalPrice = nightlyPrice * nights;

    // 6. Overlap prevention with Concurrency Safety (MongoDB Transactions + Listing Version Lock + Bounded Retry)
    const bookingResult = await createReservationWithRetry({
      listingId: listing._id,
      userId: req.session.userId,
      checkInDate,
      checkOutDate,
      guestsNum,
      totalPrice,
    });

    if (!bookingResult.success) {
      if (bookingResult.reason === "UNAVAILABLE") {
        req.flash(
          "error",
          "The selected dates are no longer available for this property. Please choose different dates."
        );
        return res.redirect(`/listings/${id}`);
      }

      if (bookingResult.reason === "NOT_FOUND") {
        req.flash("error", "The listing you requested does not exist.");
        return res.redirect("/listings");
      }

      if (bookingResult.reason === "TRANSACTIONS_UNSUPPORTED") {
        return res.status(503).render("errors/error.ejs", {
          message:
            "Reservation service is temporarily unavailable because the database environment does not support ACID transactions.",
          status: 503,
        });
      }

      req.flash("error", "An unexpected error occurred while processing your reservation. Please try again.");
      return res.redirect(`/listings/${id}`);
    }

    req.flash("success", `Reservation confirmed! You have successfully booked ${nights} night(s).`);
    res.redirect("/reservations");
  } catch (err) {
    if (err.name === "CastError") {
      req.flash("error", "Invalid listing identifier.");
      return res.redirect("/listings");
    }
    next(err);
  }
});

// ==========================================
// 3. My Reservations Page (Authenticated)
// ==========================================
router.get("/reservations", isLoggedIn, async (req, res, next) => {
  try {
    const reservations = await Reservation.find({ user: req.session.userId })
      .populate("listing")
      .sort({ createdAt: -1 });

    res.render("reservations/index.ejs", {
      reservations,
      calculateNights,
      formatDateDisplay,
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// 4. Cancel Reservation Endpoint
// ==========================================
router.post("/reservations/:id/cancel", isLoggedIn, async (req, res, next) => {
  const { id } = req.params;

  try {
    const reservation = await Reservation.findById(id);

    if (!reservation) {
      req.flash("error", "The reservation you requested does not exist.");
      return res.status(404).render("errors/error.ejs", {
        message: "Reservation Not Found",
        status: 404,
      });
    }

    // Authorization: only the reservation owner can cancel
    if (!reservation.user.equals(req.session.userId)) {
      req.flash("error", "Permission denied: You cannot cancel another user's reservation.");
      return res.status(403).render("errors/error.ejs", {
        message: "Forbidden: You are not authorized to cancel this reservation.",
        status: 403,
      });
    }

    // Idempotency: prevent re-cancellation of already cancelled reservation
    if (reservation.status === "CANCELLED") {
      req.flash("error", "This reservation has already been cancelled.");
      return res.redirect("/reservations");
    }

    // Update status to CANCELLED (preserves historical record and releases dates)
    reservation.status = "CANCELLED";
    await reservation.save();

    req.flash("success", "Reservation cancelled successfully. The dates have been released.");
    res.redirect("/reservations");
  } catch (err) {
    if (err.name === "CastError") {
      req.flash("error", "Invalid reservation identifier.");
      return res.status(404).render("errors/error.ejs", {
        message: "Reservation Not Found",
        status: 404,
      });
    }
    next(err);
  }
});

module.exports = {
  router,
  parseCalendarDate,
  getTodayUtc,
  calculateNights,
  formatDateForInput,
  formatDateDisplay,
  createReservationWithRetry,
};
