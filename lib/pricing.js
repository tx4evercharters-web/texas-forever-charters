/* ============================================================
   Texas Forever Charters — Pricing Module
   ============================================================
   Single source of truth for charter pricing.

   Usage (browser):
     <script src="/lib/pricing.js"></script>
     const result = TFCPricing.calculatePricing({...});

   Usage (Node):
     const { calculatePricing } = require('../lib/pricing');

   Pricing rules (effective 2026-05-08):
     Yacht hourly:    Mon-Thu $250, Fri/Sun $300, Sat $350
     Pontoon hourly:  Mon-Thu $100, Fri/Sun/Sat $150
     +$100/hr surcharge on US bank-holiday weekends (Fri-Mon bracket)
     +$100/hr surcharge on charters of 5 or more hours
     Fee stack on charter+addons subtotal:
       1. +10%   Admin fee
       2. +8.5%  Sales tax (on subtotal+admin)
       3. +2.9%  CC processing (on subtotal+admin+tax) — skipped when paymentMethod='external'
     Promo codes (10% off post-fee total): LAKELIFE10, FOREVER10, TXF10
     Deposit: 10% of grand total
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TFCPricing = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── Constants ─────────────────────────────────────────────── */

  var ADD_ON_PRICES = {
    drone_footage: 200,
    water_bottles: 25,
    ice:           50,
    beer_pong:     50,
    towels:         8, // per towel
  };

  var VALID_PROMO_CODES = ['LAKELIFE10', 'FOREVER10', 'TXF10'];

  /* US bank holidays 2025-2027. Pricing extends each holiday to the
     surrounding Fri-Mon long-weekend bracket — see HOLIDAY_PRICING_DAYS. */
  var BANK_HOLIDAYS = [
    '2025-01-01','2025-01-20','2025-02-17','2025-05-26',
    '2025-06-19','2025-07-04','2025-09-01','2025-10-13',
    '2025-11-11','2025-11-27','2025-12-25',
    '2026-01-01','2026-01-19','2026-02-16','2026-05-25',
    '2026-06-19','2026-07-03','2026-07-04','2026-09-07',
    '2026-10-12','2026-11-11','2026-11-26','2026-12-25',
    '2027-01-01','2027-01-18','2027-02-15','2027-05-31',
    '2027-06-18','2027-07-05','2027-09-06','2027-11-11',
    '2027-11-25','2027-12-24'
  ];

  /* ── Date helpers ──────────────────────────────────────────── */

  /* Parse "YYYY-MM-DD" as LOCAL midnight, never UTC.
     Reason: new Date("2026-07-04") parses as UTC midnight, which becomes
     July 3rd in any time zone west of UTC, breaking holiday detection on
     boundary days (Memorial Day, July 4, etc.). Use the explicit
     (year, month-1, day) constructor to anchor at local-midnight regardless
     of server timezone. */
  function parseLocalDate(str) {
    if (!str || typeof str !== 'string') {
      throw new Error('parseLocalDate: expected string, got ' + JSON.stringify(str));
    }
    var parts = str.split('-');
    if (parts.length !== 3) {
      throw new Error('parseLocalDate: expected YYYY-MM-DD, got ' + JSON.stringify(str));
    }
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    var d = parseInt(parts[2], 10);
    if (!isFinite(y) || !isFinite(m) || !isFinite(d)) {
      throw new Error('parseLocalDate: non-numeric component in ' + JSON.stringify(str));
    }
    return new Date(y, m - 1, d);
  }

  function dateKey(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /* Holiday pricing days: every actual federal holiday plus the Fri-Mon
     weekend bracket around it. Mon holidays expand back to Fri; Fri/Sat/Sun
     holidays expand to the surrounding Fri-Sun. Tue/Wed/Thu holidays don't
     extend. Computed once at module-load. */
  var HOLIDAY_PRICING_DAYS = (function () {
    var set = {};
    for (var i = 0; i < BANK_HOLIDAYS.length; i++) {
      var key = BANK_HOLIDAYS[i];
      var base = parseLocalDate(key);
      set[key] = true;
      var dow = base.getDay(); // 0=Sun … 6=Sat
      var fridayOffset;
      if      (dow === 5) fridayOffset =  0;
      else if (dow === 6) fridayOffset = -1;
      else if (dow === 0) fridayOffset = -2;
      else if (dow === 1) fridayOffset = -3;
      else continue;
      for (var j = 0; j < 4; j++) {
        var dt = new Date(base);
        dt.setDate(base.getDate() + fridayOffset + j);
        set[dateKey(dt)] = true;
      }
    }
    return set;
  })();

  /* Public: accepts YYYY-MM-DD string. Returns true if the date falls
     within a holiday weekend bracket (or is the holiday itself). */
  function isHoliday(dateStr) {
    if (!dateStr) return false;
    return HOLIDAY_PRICING_DAYS[dateStr] === true;
  }

  /* ── Math helpers ──────────────────────────────────────────── */

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /* ── Add-on math ───────────────────────────────────────────── */

  /* Accepts add-ons keyed by snake_case names matching the Supabase column.
     Truthy boolean keys add the flat fee; `towels` is a quantity. */
  function computeAddOnTotal(addOns) {
    if (!addOns || typeof addOns !== 'object') return 0;
    var total = 0;
    if (addOns.drone_footage) total += ADD_ON_PRICES.drone_footage;
    if (addOns.water_bottles) total += ADD_ON_PRICES.water_bottles;
    if (addOns.ice)           total += ADD_ON_PRICES.ice;
    if (addOns.beer_pong)     total += ADD_ON_PRICES.beer_pong;
    var towelQty = parseInt(addOns.towels, 10) || 0;
    if (towelQty > 0) total += ADD_ON_PRICES.towels * towelQty;
    return total;
  }

  /* ── Main entry ────────────────────────────────────────────── */

  /* Compute the full pricing breakdown for a charter.
     See top-of-file rules. Returns a plain object that callers can render
     however they like; the `grandTotal` field is the canonical number to
     charge / persist. */
  function calculatePricing(input) {
    if (!input || typeof input !== 'object') {
      throw new Error('calculatePricing: input object required');
    }
    var vessel        = input.vessel;
    var date          = input.date;
    var duration      = Number(input.duration);
    var partySize     = (input.partySize != null) ? Number(input.partySize) : null;
    var addOns        = input.addOns || {};
    var promoCode     = input.promoCode || null;
    var paymentMethod = input.paymentMethod || 'stripe';

    // Validation
    if (vessel !== 'yacht' && vessel !== 'pontoon') {
      throw new Error('calculatePricing: vessel must be "yacht" or "pontoon", got ' + JSON.stringify(vessel));
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('calculatePricing: date must be YYYY-MM-DD, got ' + JSON.stringify(date));
    }
    if (!isFinite(duration) || duration <= 0) {
      throw new Error('calculatePricing: duration must be positive, got ' + JSON.stringify(input.duration));
    }
    if (paymentMethod !== 'stripe' && paymentMethod !== 'external') {
      throw new Error('calculatePricing: paymentMethod must be "stripe" or "external", got ' + JSON.stringify(paymentMethod));
    }

    var dt = parseLocalDate(date);
    var day = dt.getDay();

    /* Base hourly rate by vessel × day-of-week */
    var baseHourlyRate;
    if (vessel === 'yacht') {
      baseHourlyRate = (day === 6) ? 350
                     : (day === 0 || day === 5) ? 300
                     : 250;
    } else {
      baseHourlyRate = (day === 5 || day === 6 || day === 0) ? 150 : 100;
    }

    /* Surcharges */
    var holidayBool        = isHoliday(date);
    var holidaySurcharge   = holidayBool ? 100 : 0;
    var longCharterPremium = duration >= 5 ? 100 : 0;
    var effectiveHourlyRate = baseHourlyRate + holidaySurcharge + longCharterPremium;

    /* Subtotals */
    var charterSubtotal = effectiveHourlyRate * duration;
    var addOnTotal      = computeAddOnTotal(addOns);
    var subtotal        = charterSubtotal + addOnTotal;

    /* Fee stack — preserves the existing rounding sequence
       (round after EACH step, not just at the end). Changing this would
       shift in-flight bookings by single pennies. */
    var adminFee     = round2(subtotal * 0.10);
    var afterAdmin   = subtotal + adminFee;
    var salesTax     = round2(afterAdmin * 0.085);
    var afterTax     = afterAdmin + salesTax;
    var processingFee = (paymentMethod === 'external')
      ? 0
      : round2(afterTax * 0.029);
    var beforeDiscount = afterTax + processingFee;

    /* Promo */
    var normalizedCode = String(promoCode || '').trim().toUpperCase();
    var appliedPromoCode = (VALID_PROMO_CODES.indexOf(normalizedCode) !== -1)
      ? normalizedCode
      : null;
    var promoDiscount = appliedPromoCode ? round2(beforeDiscount * 0.10) : 0;

    /* Totals */
    var grandTotal       = round2(beforeDiscount - promoDiscount);
    var depositAmount    = round2(grandTotal * 0.10);
    var remainingBalance = round2(grandTotal - depositAmount);

    /* `subtotalAfterDiscount`: the user spec asked for this field. The
       canonical math applies promo POST-fees, not on the bare subtotal,
       so this field is provided as a derived view (subtotal minus the
       proportional 10% if a code is applied) and is NOT used to compute
       grandTotal. The canonical total stays grandTotal. */
    var subtotalAfterDiscount = appliedPromoCode
      ? round2(subtotal - subtotal * 0.10)
      : subtotal;

    var DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

    return {
      // Echo of inputs for traceability
      vessel: vessel,
      date: date,
      duration: duration,
      partySize: partySize,
      paymentMethod: paymentMethod,

      // Rate breakdown
      baseHourlyRate: baseHourlyRate,
      holidaySurcharge: holidaySurcharge,
      longCharterPremium: longCharterPremium,
      effectiveHourlyRate: effectiveHourlyRate,

      // Subtotals
      charterSubtotal: charterSubtotal,
      addOnTotal: addOnTotal,
      subtotal: subtotal,
      subtotalAfterDiscount: subtotalAfterDiscount,

      // Fees
      adminFee: adminFee,
      salesTax: salesTax,
      processingFee: processingFee,

      // Promo
      appliedPromoCode: appliedPromoCode,
      promoDiscount: promoDiscount,

      // Totals
      grandTotal: grandTotal,
      depositAmount: depositAmount,
      remainingBalance: remainingBalance,

      // Calendar metadata
      isHoliday: holidayBool,
      dayOfWeek: DAYS[day]
    };
  }

  /* ── Public API ────────────────────────────────────────────── */
  return {
    calculatePricing: calculatePricing,
    isHoliday: isHoliday,
    parseLocalDate: parseLocalDate,
    dateKey: dateKey,
    VALID_PROMO_CODES: VALID_PROMO_CODES.slice(),
    ADD_ON_PRICES: Object.assign({}, ADD_ON_PRICES),
    BANK_HOLIDAYS: BANK_HOLIDAYS.slice()
  };
}));
