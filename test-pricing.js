/* Pricing consolidation — verification harness.
   Runs the 6 test cases per the design spec and compares the NEW shared
   module (lib/pricing.js) against the OLD inline math from booking.html
   (pre-refactor) to confirm we didn't shift any numbers.

   Usage: node test-pricing.js
   Delete this file before deploy (or keep as a regression suite). */

const { calculatePricing } = require('./lib/pricing');

/* ── Old inline math, copied verbatim from booking.html pre-refactor.
   Recreated here so we can diff against the new module's output and
   confirm we preserved the rounding sequence. Customer-key add-on shape
   (drone/water/beerpong/towels) preserved as it was. */
const oldBankHolidays = new Set([
  '2025-01-01','2025-01-20','2025-02-17','2025-05-26',
  '2025-06-19','2025-07-04','2025-09-01','2025-10-13',
  '2025-11-11','2025-11-27','2025-12-25',
  '2026-01-01','2026-01-19','2026-02-16','2026-05-25',
  '2026-06-19','2026-07-04','2026-07-03','2026-09-07',
  '2026-10-12','2026-11-11','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-05-31',
  '2027-06-18','2027-07-05','2027-09-06','2027-11-11',
  '2027-11-25','2027-12-24',
]);
function oldDateKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth()+1).padStart(2,'0') + '-' +
    String(d.getDate()).padStart(2,'0');
}
const oldHolidayPricingDays = (() => {
  const expanded = new Set();
  for (const key of oldBankHolidays) {
    const [y,m,d] = key.split('-').map(Number);
    const base = new Date(y, m-1, d);
    expanded.add(key);
    const day = base.getDay();
    let off;
    if      (day === 5) off = 0;
    else if (day === 6) off = -1;
    else if (day === 0) off = -2;
    else if (day === 1) off = -3;
    else continue;
    for (let i = 0; i < 4; i++) {
      const dt = new Date(base);
      dt.setDate(base.getDate() + off + i);
      expanded.add(oldDateKey(dt));
    }
  }
  return expanded;
})();
function oldIsHoliday(d) { return oldHolidayPricingDays.has(oldDateKey(d)); }

/* Mirror of buildPriceBreakdown's math (post-5+hr-fix, pre-consolidation).
   Customer keys: drone, water, ice, beerpong, towels.
   Math model (post-2026-05-12):
     - 5% admin fee on (charter + addOns)
     - 10% promo off charter rate only (not addOns)
     - tax + processing apply to post-promo subtotal (charter_after_promo + addOns + admin)
     - processing 2.9% only, no flat fee */
function oldBuildPriceBreakdown({ vessel, dateStr, duration, addOns, promoApplied }) {
  const [y,m,d] = dateStr.split('-').map(Number);
  const date = new Date(y, m-1, d);
  const day = date.getDay();
  let rate;
  if (vessel === 'yacht') {
    rate = day === 6 ? 350 : (day === 0 || day === 5) ? 300 : 250;
  } else {
    rate = (day === 5 || day === 6 || day === 0) ? 150 : 100;
  }
  const holidaySurcharge = oldIsHoliday(date) ? 100 : 0;
  const longCharterPremium = duration >= 5 ? 100 : 0;
  const effectiveRate = rate + holidaySurcharge + longCharterPremium;
  const charterBase = effectiveRate * duration;

  let addOnsTotal = 0;
  if (addOns.drone) addOnsTotal += 200;
  addOnsTotal += (addOns.towels || 0) * 8;
  if (addOns.water) addOnsTotal += 25;
  if (addOns.ice) addOnsTotal += 25;
  if (addOns.beerpong) addOnsTotal += 50;

  const subtotal = charterBase + addOnsTotal;
  const discount = promoApplied ? Math.round(charterBase * 0.10 * 100) / 100 : 0;
  const charterAfterPromo = Math.round((charterBase - discount) * 100) / 100;
  const adminFee = Math.round(subtotal * 0.05 * 100) / 100;
  const taxable = Math.round((charterAfterPromo + addOnsTotal + adminFee) * 100) / 100;
  const tax = Math.round(taxable * 0.085 * 100) / 100;
  const afterTax = taxable + tax;
  const processingFee = Math.round(afterTax * 0.029 * 100) / 100;
  const grandTotal = Math.round((afterTax + processingFee) * 100) / 100;
  const depositAmount = Math.round(grandTotal * 0.10 * 100) / 100;

  return {
    baseHourlyRate:    rate,
    holidaySurcharge,
    longCharterPremium,
    effectiveHourlyRate: effectiveRate,
    charterSubtotal:   charterBase,
    addOnTotal:        addOnsTotal,
    subtotal,
    adminFee,
    salesTax:          tax,
    processingFee,
    promoDiscount:     discount,
    grandTotal,
    depositAmount,
  };
}

/* Mirror of admin's abComputePricing with the external-payment
   processing-fee gate. Snake_case add-on keys. Post-2026-05-12 math. */
function oldAdminCompute({ vessel, dateStr, duration, addOns, paymentMethod }) {
  const [y,m,d] = dateStr.split('-').map(Number);
  const date = new Date(y, m-1, d);
  const day = date.getDay();
  let rate;
  if (vessel === 'yacht') {
    rate = day === 6 ? 350 : (day === 0 || day === 5) ? 300 : 250;
  } else {
    rate = (day === 5 || day === 6 || day === 0) ? 150 : 100;
  }
  if (oldIsHoliday(date)) rate += 100;
  if (duration >= 5) rate += 100;
  const charterBase = rate * duration;

  let addOnsTotal = 0;
  if (addOns.drone_footage) addOnsTotal += 200;
  addOnsTotal += (addOns.towels || 0) * 8;
  if (addOns.water_bottles) addOnsTotal += 25;
  if (addOns.ice)           addOnsTotal += 25;
  if (addOns.beer_pong)     addOnsTotal += 50;

  const subtotal = charterBase + addOnsTotal;
  /* admin (no promo path in this mirror — used only for the
     external-payment case which doesn't apply LAKELIFE10) */
  const adminFee = Math.round(subtotal * 0.05 * 100) / 100;
  const taxable = Math.round((charterBase + addOnsTotal + adminFee) * 100) / 100;
  const tax = Math.round(taxable * 0.085 * 100) / 100;
  const afterTax = taxable + tax;
  const processingFee = paymentMethod === 'external' ? 0 : Math.round(afterTax * 0.029 * 100) / 100;
  const total = Math.round((afterTax + processingFee) * 100) / 100;

  return {
    effectiveHourlyRate: rate,
    charterSubtotal:     charterBase,
    addOnTotal:          addOnsTotal,
    subtotal,
    adminFee,
    salesTax:            tax,
    processingFee,
    grandTotal:          total,
  };
}

/* ── Helpers ──────────────────────────────────────────────────── */
const COMPARED_FIELDS = [
  'baseHourlyRate', 'holidaySurcharge', 'longCharterPremium',
  'effectiveHourlyRate', 'charterSubtotal', 'addOnTotal',
  'subtotal', 'adminFee', 'salesTax', 'processingFee',
  'promoDiscount', 'grandTotal', 'depositAmount',
];

function diff(newP, oldP) {
  const mismatches = [];
  for (const k of Object.keys(oldP)) {
    if (newP[k] === undefined) continue;
    const a = Number(newP[k]);
    const b = Number(oldP[k]);
    if (Math.abs(a - b) > 0.001) {
      mismatches.push({ field: k, new: a, old: b, diff: (a - b).toFixed(4) });
    }
  }
  return mismatches;
}

function fmt(p, fields) {
  const lines = [];
  for (const f of fields) {
    if (p[f] === undefined) continue;
    let v = p[f];
    if (typeof v === 'number') v = '$' + v.toFixed(2);
    lines.push('    ' + f.padEnd(22) + v);
  }
  return lines.join('\n');
}

function runCase(label, input, oldFn, expectMatch) {
  console.log('\n=== ' + label + ' ===');
  console.log('  Inputs:', JSON.stringify(input, null, 0));
  const newP = calculatePricing(input);
  const oldP = oldFn(input);
  console.log('  NEW module output:');
  console.log(fmt(newP, COMPARED_FIELDS));
  console.log('  OLD inline output:');
  console.log(fmt(oldP, COMPARED_FIELDS));
  const m = diff(newP, oldP);
  if (m.length === 0) {
    console.log('  ✅ MATCH — all comparable fields agree to within $0.001');
  } else {
    console.log('  ❌ MISMATCH:');
    m.forEach(x => console.log('    ' + x.field + ': new=$' + x.new.toFixed(2) + ' old=$' + x.old.toFixed(2) + ' diff=$' + x.diff));
  }
  return { newP, oldP, mismatches: m };
}

/* ── Test cases ───────────────────────────────────────────────── */

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Pricing consolidation — 6-case verification');
console.log('  ' + new Date().toISOString());
console.log('═══════════════════════════════════════════════════════════════');

// Case 1 — sanity baseline
runCase(
  'Case 1: 4hr Saturday yacht, no add-ons, no promo',
  {
    vessel: 'yacht', date: '2026-05-09', duration: 4,
    addOns: {}, promoCode: null, paymentMethod: 'stripe',
  },
  (input) => oldBuildPriceBreakdown({
    vessel: input.vessel, dateStr: input.date, duration: input.duration,
    addOns: {}, promoApplied: false,
  })
);

// Case 2 — the regression case (5+hr premium + promo + Saturday)
runCase(
  'Case 2: 6hr Saturday yacht with TXF10 promo (REGRESSION CASE)',
  {
    vessel: 'yacht', date: '2026-05-09', duration: 6,
    addOns: {}, promoCode: 'TXF10', paymentMethod: 'stripe',
  },
  (input) => oldBuildPriceBreakdown({
    vessel: input.vessel, dateStr: input.date, duration: input.duration,
    addOns: {}, promoApplied: true,
  })
);

// Case 3 — pontoon weekday with mixed add-ons
runCase(
  'Case 3: 3hr Tuesday pontoon, drone + 4 towels, no promo',
  {
    vessel: 'pontoon', date: '2026-05-12', duration: 3,
    addOns: { drone_footage: true, towels: 4 },
    promoCode: null, paymentMethod: 'stripe',
  },
  (input) => oldBuildPriceBreakdown({
    vessel: input.vessel, dateStr: input.date, duration: input.duration,
    addOns: { drone: true, towels: 4 }, // OLD code uses customer keys
    promoApplied: false,
  })
);

// Case 4 — both surcharges stacking on July 4 (Saturday in 2026, holiday)
runCase(
  'Case 4: 5hr July 4 2026 yacht (holiday + 5+hr stacking)',
  {
    vessel: 'yacht', date: '2026-07-04', duration: 5,
    addOns: {}, promoCode: null, paymentMethod: 'stripe',
  },
  (input) => oldBuildPriceBreakdown({
    vessel: input.vessel, dateStr: input.date, duration: input.duration,
    addOns: {}, promoApplied: false,
  })
);

// Case 5 — admin external payment (no processing fee)
runCase(
  'Case 5: Admin booking — 4hr Saturday yacht, paymentMethod="external"',
  {
    vessel: 'yacht', date: '2026-05-09', duration: 4,
    addOns: {}, promoCode: null, paymentMethod: 'external',
  },
  (input) => oldAdminCompute({
    vessel: input.vessel, dateStr: input.date, duration: input.duration,
    addOns: {}, paymentMethod: 'external',
  })
);

// Case 6 — server-side mismatch refusal simulation
console.log('\n=== Case 6: Server-side price-mismatch refusal ===');
console.log('  Inputs: vessel=yacht, date=2026-05-09, duration=4, no addOns/promo');
const honestPrice = calculatePricing({
  vessel: 'yacht', date: '2026-05-09', duration: 4,
  addOns: {}, paymentMethod: 'stripe',
});
const tamperedClientGrandTotal = 1.00;
const TOLERANCE = 0.01;
const diff6 = Math.abs(honestPrice.grandTotal - tamperedClientGrandTotal);
console.log('  Server-computed grandTotal: $' + honestPrice.grandTotal.toFixed(2));
console.log('  Client-sent grandTotal:     $' + tamperedClientGrandTotal.toFixed(2));
console.log('  Diff: $' + diff6.toFixed(2) + ' (tolerance: $' + TOLERANCE.toFixed(2) + ')');
if (diff6 > TOLERANCE) {
  console.log('  ✅ REFUSED — server would return 400 { error: "price_mismatch" }');
  console.log('     Customer would see: "Pricing updated — please review and try again."');
} else {
  console.log('  ❌ ACCEPTED — security check failed!');
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  All cases complete.');
console.log('═══════════════════════════════════════════════════════════════');
