# StayNest 🏡

An Airbnb-inspired accommodation marketplace platform built with **Node.js**, **Express 5**, **EJS**, and **MongoDB / Mongoose**.

StayNest allows travelers to discover unique stays across India, search by destination and price, view detailed accommodation specs, reserve stays with real-time availability checks, and manage their bookings.

---

## 🌟 Implemented Features

### 1. Authentication & Session Security
- **User Registration & Login:** User accounts with name, normalized email, and passwords hashed using `bcrypt` (12 salt rounds).
- **Session Management:** Secure HTTP-only session cookies backed by `connect-mongo` session storage.
- **CSRF Protection:** Cryptographic session-based CSRF tokens validated on all state-mutating requests (`POST`, `PUT`, `DELETE`).
- **Rate Limiting:** Brute-force protection on authentication endpoints powered by `express-rate-limit`.
- **Role & Context Middleware:** Dynamic user context loaded into view locals with flash messaging.

### 2. Property Listings & Ownership Authorization
- **Full Listing CRUD:** Browse, create, view, edit, and delete property listings.
- **Server-Side Ownership Enforcement:** Listings are strictly bound to authenticated owners on the server; client-supplied owner IDs are ignored.
- **Access Control:** Only listing owners can edit or delete their properties (`isOwner` middleware).
- **Platform & Community Listings:** Legacy or platform-seeded listings without assigned individual owners are publicly viewable and bookable, while protected from unauthorized modification or deletion.

### 3. Curated Sample Listings
- Seeded with 8 realistic, high-quality stays across India (Manali, Varkala, Gulmarg, Jaipur, Goa, Coorg, Udaipur, Kumarakom).
- Direct high-resolution photography, evocative architectural descriptions, and localized pricing in Indian Rupees ($\text{INR}$).

### 4. Search & Property Filters
- **Destination & Country Search:** Search properties by location name (e.g. `Goa`, `Kerala`, `Manali`) or country (`India`).
- **Property-Name Search:** Case-insensitive search on listing titles (e.g. `Villa`, `Chalet`, `Cabin`).
- **Price Range Filters:** Minimum price (`minPrice`) and maximum price (`maxPrice`) filters in $\text{INR}$.
- **Combination & Clear Actions:** Combined multi-parameter filtering (`/listings?search=villa&location=Kerala&minPrice=10000`).
- **Graceful Empty State:** Helpful guidance and reset action when no listings match filter criteria.
- **Injection Safety:** All user search inputs are escaped to prevent regular expression injection or NoSQL operator manipulation.

### 5. Reservations & Availability System
- **Calendar Date Arithmetic:** Robust `YYYY-MM-DD` date parsing normalized to UTC midnight, eliminating timezone and Daylight Saving Time (DST) drift.
- **Night & Price Calculation:** Automatic server-side price calculation ($\text{listing.price} \times \text{nights}$) rejecting client-side price tampering.
- **Overlap Prevention:** Strict interval overlap detection:
  $$\text{existing.checkIn} < \text{requested.checkOut} \quad\text{AND}\quad \text{existing.checkOut} > \text{requested.checkIn}$$
- **Back-to-Back Booking:** Check-out date aligns with the next guest's check-in date without conflicts.
- **Concurrency Protection:** Multi-document transactions (`session.startTransaction()`) guarantee atomic availability checks and reservation creation.
- **My Reservations Dashboard:** Authenticated guests can view booking history, destination details, stay duration, and total paid.
- **Cancellation Workflow:** Authenticated reservation owners can cancel bookings (`POST /reservations/:id/cancel`), immediately releasing dates for other guests while preserving historical records.

### 6. Automated Test Suites
- Comprehensive test coverage using the native Node.js test runner (`node:test`) and `supertest`.
- 62 automated tests running against isolated local test databases without touching production data.

---

## 🛠️ Technology Stack

| Layer | Technologies |
|-------|--------------|
| **Runtime & Server** | Node.js (v22+), Express 5 |
| **Database & ODM** | MongoDB (Atlas / Community Edition), Mongoose 8 |
| **Templating Engine** | EJS, EJS-Mate layouts |
| **Authentication & Security** | Bcrypt, Express-Session, Connect-Mongo, Express-Rate-Limit, Crypto |
| **Frontend & UI** | Bootstrap 5, FontAwesome 6, Custom CSS |
| **Testing** | Node.js Test Runner (`node:test`), Node Assert (`node:assert/strict`), Supertest |

---

## 📁 Project Structure

```text
StayNest/
├── app.js                   # Application entry point, Express config, routes & middleware
├── models/
│   ├── listing.js           # Property listing schema & model
│   ├── user.js              # User schema with bcrypt hashing methods
│   └── reservation.js       # Reservation schema with indexes & status enum
├── routes/
│   ├── users.js             # Authentication routes (signup, login, logout)
│   └── reservations.js      # Reservation routes (booking, dashboard, cancellation)
├── middleware/
│   └── auth.js              # isLoggedIn, isOwner, csrfProtection, loadCurrentUser, rateLimiter
├── views/
│   ├── layouts/
│   │   └── boilerplate.ejs  # Main HTML layout wrapper
│   ├── includes/
│   │   ├── navbar.ejs       # Responsive navigation bar
│   │   ├── footer.ejs       # Footer component
│   │   └── flash.ejs        # Success / error toast banners
│   ├── listings/
│   │   ├── index.ejs        # Listings catalog with search & filter bar
│   │   ├── show.ejs         # Property detail view with integrated booking card
│   │   ├── new.ejs          # Create listing form
│   │   └── edit.ejs         # Edit listing form
│   ├── reservations/
│   │   ├── index.ejs        # My Reservations booking dashboard
│   │   └── new.ejs          # Dedicated booking form view
│   ├── users/
│   │   ├── signup.ejs       # User registration page
│   │   └── login.ejs        # User login page
│   └── errors/
│       └── error.ejs        # Standard error template (403, 404, 500)
├── public/
│   ├── css/style.css        # Stylesheet overrides and card styles
│   └── js/script.js         # Bootstrap client form validation
├── scripts/
│   └── seed-listings.js     # Idempotent listing seed script
├── tests/
│   ├── auth.test.js         # Authentication & security test suite (12 tests)
│   ├── ownership.test.js    # Listing ownership authorization suite (16 tests)
│   ├── search.test.js       # Search & filter test suite (11 tests)
│   └── reservation.test.js  # Reservation & availability test suite (23 tests)
├── .env.example             # Template for environment configuration
├── .gitignore               # Excludes secrets, dependencies, and OS files
├── package.json             # Scripts and dependencies
└── README.md                # Project documentation
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js:** v20.0.0 or higher (tested on Node v22)
- **MongoDB:** A local MongoDB instance (`mongodb://127.0.0.1:27017`) or a free [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) cluster.
- **Git**

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Ankitt-02/stayNest.git
   cd stayNest
   ```

2. Install dependencies:
   ```bash
   npm install
   # or for deterministic CI builds:
   npm ci
   ```

### Environment Configuration

Copy the example environment configuration:
```bash
cp .env.example .env
```

Open `.env` and fill in your configuration:
```env
# MongoDB Connection String (Atlas or Local MongoDB)
MONGO_URL=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/staynest?retryWrites=true&w=majority

# Session Secret (cryptographically random string)
SESSION_SECRET=your_super_secret_session_key_min_32_characters

# Application Port
PORT=3000

# Environment Mode
NODE_ENV=development
```

> [!IMPORTANT]
> Never commit `.env` or expose production passwords in version control. The `.gitignore` file is configured to exclude all `.env` files.

---

## 🗄️ Database Seeding

To populate the database with the 8 curated accommodation listings:
```bash
npm run seed:listings
```

**Safety & Idempotency Features:**
- Checks the active database name and verifies it matches the intended database (`staynest`).
- Checks existing listing count: if listings already exist, it skips insertion safely to prevent duplicate records.
- Preserves user accounts and existing reservations.

---

## 🧪 Running Automated Tests

Run the complete isolated test suite:
```bash
npm test
```

To run a specific test suite in isolation:
```bash
# Authentication tests
node --test tests/auth.test.js

# Ownership authorization tests
node --test tests/ownership.test.js

# Search and filter tests
node --test tests/search.test.js

# Reservation and availability tests
node --test tests/reservation.test.js
```

**Database Isolation:**
All automated tests execute against dedicated local MongoDB databases (`staynest_auth_test`, `staynest_ownership_test`, `staynest_search_test`, `staynest_reservation_test`). Tests will never write to or modify production MongoDB Atlas databases.

---

## 💻 Running the Application Locally

Start the StayNest server:
```bash
npm start
```

Visit the application in your browser:
**[http://localhost:3000](http://localhost:3000)**

---

## 📌 Current Project Boundaries & Roadmap

The current version of StayNest is focused on core booking marketplace mechanics. The following features are intentionally reserved for future milestones:
- **Payment Processing:** Mock instant confirmations are currently issued upon reservation. Integration with Stripe/Razorpay is planned.
- **Image Storage Service:** Listing images currently reference optimized CDN URLs. Cloudinary or AWS S3 direct upload will be integrated in future phases.
- **Reviews & Ratings:** User reviews, star ratings, and host responses.
- **Guest Capacity Limits:** The current `Listing` schema validates that guest counts are positive integers; specific per-property capacity limits are planned for a schema revision.

---

## 📄 License

This project is open-source and available under the [ISC License](LICENSE).
