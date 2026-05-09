/* ============================================================
   Texas Forever Charters — Time Slots Module
   ============================================================
   Single source of truth for charter start-time slots and the
   duration-availability business rules. Replaces the previously
   duplicated MORNING_SLOTS/AFTERNOON_SLOTS arrays in booking.html
   and the inline <option> lists in admin.html and waiver.html.

   Usage (browser):
     <script src="/lib/timeslots.js"></script>
     const html = TFCTimeSlots.renderOptions('11:00am');
     const slots = TFCTimeSlots.bookableSlotsForDuration(4);

   Usage (Node):
     const { SLOTS, isBookable } = require('../lib/timeslots');

   Two intentionally-quirky business rules — DO NOT smooth:
     - 11:30am + 4hr is NOT allowed (but 3, 5, 6, 7, 8 hr are).
     - 1:00pm + 8hr is NOT allowed (would end 9pm, past 8:30pm cutoff)
       but 1:00pm + 7hr IS allowed (ends 8pm, within cutoff).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TFCTimeSlots = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* All 17 canonical slots, 9:00am through 5:00pm in 30-min steps.
     `value` is the storage format (lowercase, no space). `label` is
     the display format. Storage format matches what booking.html sends
     to the server, what api/availability returns, and what we
     normalized the Supabase columns to in an earlier session. */
  var SLOTS = [
    { value: '9:00am',  label: '9:00 AM' },
    { value: '9:30am',  label: '9:30 AM' },
    { value: '10:00am', label: '10:00 AM' },
    { value: '10:30am', label: '10:30 AM' },
    { value: '11:00am', label: '11:00 AM' },
    { value: '11:30am', label: '11:30 AM' },
    { value: '12:00pm', label: '12:00 PM' },
    { value: '12:30pm', label: '12:30 PM' },
    { value: '1:00pm',  label: '1:00 PM' },
    { value: '1:30pm',  label: '1:30 PM' },
    { value: '2:00pm',  label: '2:00 PM' },
    { value: '2:30pm',  label: '2:30 PM' },
    { value: '3:00pm',  label: '3:00 PM' },
    { value: '3:30pm',  label: '3:30 PM' },
    { value: '4:00pm',  label: '4:00 PM' },
    { value: '4:30pm',  label: '4:30 PM' },
    { value: '5:00pm',  label: '5:00 PM' }
  ];

  /* Slot value → array of charter durations (hours) that may start at
     that slot. Encodes the duration-availability matrix exactly as
     specified by ops. Empty array = never bookable at that start time
     (midday shift gap: 1:30pm and 2:00pm have no captain availability).

     2-hour charters (Boat Tour, Sunset Cruise, Proposal) are NOT in
     this matrix by intentional business design. Their availability is
     preserved by the legacy LATEST_START_BY_DURATION filter in
     booking.html. Do not add a 2hr row without explicit owner approval.

     If you change these rules, also update the spec docs and re-run
     the verification at the bottom of this comment. */
  var DURATION_RULES = {
    '9:00am':  [3, 4, 5, 6, 7, 8],
    '9:30am':  [3, 4, 5, 6, 7, 8],
    '10:00am': [3, 4, 5, 6, 7, 8],
    '10:30am': [3, 4, 5, 6, 7, 8],
    '11:00am': [3, 4, 5, 6, 7, 8],
    '11:30am': [3,    5, 6, 7, 8],   // quirky: no 4hr
    '12:00pm': [            7, 8],
    '12:30pm': [            7, 8],
    '1:00pm':  [            7   ],   // quirky: no 8hr (would end 9pm, past cutoff)
    '1:30pm':  [],
    '2:00pm':  [],
    '2:30pm':  [3, 4, 5         ],
    '3:00pm':  [3, 4, 5         ],
    '3:30pm':  [3, 4, 5         ],
    '4:00pm':  [3, 4            ],
    '4:30pm':  [3, 4            ],
    '5:00pm':  [3               ]
  };

  /* Pre-derive morning/afternoon string-value arrays for backward compat
     with booking.html's existing buildTimeSlots flow. Morning = pre-noon
     (6 slots, 9:00am-11:30am); afternoon = noon-onward (11 slots,
     12:00pm-5:00pm). */
  var MORNING_SLOTS = SLOTS.slice(0, 6).map(function (s) { return s.value; });
  var AFTERNOON_SLOTS = SLOTS.slice(6).map(function (s) { return s.value; });

  /* Returns true iff the given duration (in hours) is allowed to start
     at the given slot, per DURATION_RULES. Strict — unknown slots and
     durations outside the matrix both return false. Callers that need
     to support durations outside 3-8 (e.g., 2hr boat tours) must
     handle that case before calling this. */
  function isBookable(slotValue, durationHours) {
    var dur = Number(durationHours);
    if (!isFinite(dur)) return false;
    var rules = DURATION_RULES[slotValue];
    if (!rules) return false;
    return rules.indexOf(dur) !== -1;
  }

  /* Returns true if the matrix has explicit rules for this duration
     (i.e., at least one slot allows it). Callers can use this to
     decide whether to apply the matrix or fall back to legacy logic
     for unsupported durations like 2hr. */
  function hasMatrixRulesFor(durationHours) {
    var dur = Number(durationHours);
    if (!isFinite(dur)) return false;
    for (var k in DURATION_RULES) {
      if (DURATION_RULES[k].indexOf(dur) !== -1) return true;
    }
    return false;
  }

  /* Returns the subset of SLOTS bookable for the given duration. */
  function bookableSlotsForDuration(durationHours) {
    return SLOTS.filter(function (s) {
      return isBookable(s.value, durationHours);
    });
  }

  /* Builds an HTML string of <option> tags for all 17 slots. If
     selectedValue matches one of the slot values, that option is
     pre-selected. Used by admin.html and waiver.html to populate
     their <select> elements at page load. */
  function renderOptions(selectedValue) {
    return SLOTS.map(function (s) {
      var sel = (s.value === selectedValue) ? ' selected' : '';
      return '<option value="' + s.value + '"' + sel + '>' + s.label + '</option>';
    }).join('');
  }

  /* Normalize legacy time-slot formats ("9:00 AM", "9:00 am", "9:00AM")
     to the canonical "9:00am" storage format. Idempotent on already-
     canonical input. Empty string for null/undefined/empty input.

     Replaces the inline .toLowerCase().replace(/\s+/g, '') pattern
     that existed in admin.html for legacy DB row defense. */
  function normalize(timeSlot) {
    if (!timeSlot) return '';
    return String(timeSlot).toLowerCase().replace(/\s+/g, '');
  }

  return {
    SLOTS: SLOTS.slice(),
    MORNING_SLOTS: MORNING_SLOTS.slice(),
    AFTERNOON_SLOTS: AFTERNOON_SLOTS.slice(),
    isBookable: isBookable,
    hasMatrixRulesFor: hasMatrixRulesFor,
    bookableSlotsForDuration: bookableSlotsForDuration,
    renderOptions: renderOptions,
    normalize: normalize
  };
}));
