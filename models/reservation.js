const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const reservationSchema = new Schema(
  {
    listing: {
      type: Schema.Types.ObjectId,
      ref: "Listing",
      required: [true, "Listing reference is required"],
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User reference is required"],
    },
    checkIn: {
      type: Date,
      required: [true, "Check-in date is required"],
    },
    checkOut: {
      type: Date,
      required: [true, "Check-out date is required"],
    },
    guests: {
      type: Number,
      required: [true, "Number of guests is required"],
      min: [1, "At least 1 guest is required"],
      validate: {
        validator: Number.isInteger,
        message: "Guest count must be an integer",
      },
    },
    totalPrice: {
      type: Number,
      required: [true, "Total price is required"],
      min: [0, "Total price cannot be negative"],
    },
    status: {
      type: String,
      enum: ["CONFIRMED", "CANCELLED"],
      default: "CONFIRMED",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient availability and overlap lookups:
// existing.checkIn < requested.checkOut AND existing.checkOut > requested.checkIn
reservationSchema.index({ listing: 1, status: 1, checkIn: 1, checkOut: 1 });

// Index for retrieving a user's reservations ordered by creation date
reservationSchema.index({ user: 1, createdAt: -1 });

const Reservation = mongoose.model("Reservation", reservationSchema);

module.exports = Reservation;
