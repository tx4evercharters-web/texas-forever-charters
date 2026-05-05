const https = require('https');
const { put, list } = require('@vercel/blob');

const BOOKINGS_PATH = 'tfc/bookings.json';
const BLACKOUTS_PATH = 'tfc/blackouts.json';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

async function readBlob(pathname) {
  const { blobs } = await list({ prefix: pathname });
  const blob = blobs.find(b => b.pathname === pathname);
  if (!blob) return null;
  return fetchUrl(blob.url);
}

async function writeBlob(pathname, data) {
  await put(pathname, JSON.stringify(data), {
    access: 'public',
    addRandomSuffix: false,
  });
}

async function getBookings() {
  return (await readBlob(BOOKINGS_PATH)) || [];
}

async function saveBooking(booking) {
  console.log('[storage] saveBooking session:', booking.session_id);
  const bookings = await getBookings();
  const idx = bookings.findIndex(b => b.session_id === booking.session_id);
  if (idx >= 0) {
    bookings[idx] = { ...bookings[idx], ...booking };
  } else {
    bookings.push(booking);
  }
  await writeBlob(BOOKINGS_PATH, bookings);
  console.log('[storage] saved. total bookings:', bookings.length);
}

async function markBookingPaid(session_id) {
  const bookings = await getBookings();
  const booking = bookings.find(b => b.session_id === session_id);
  if (!booking) return null;
  booking.paid_in_full = true;
  booking.remaining_balance = 0;
  booking.payment_type = 'full';
  await writeBlob(BOOKINGS_PATH, bookings);
  return booking;
}

async function getBlackouts() {
  return (await readBlob(BLACKOUTS_PATH)) || [];
}

async function addBlackout(date) {
  const blackouts = await getBlackouts();
  if (!blackouts.includes(date)) blackouts.push(date);
  blackouts.sort();
  await writeBlob(BLACKOUTS_PATH, blackouts);
  return blackouts;
}

async function removeBlackout(date) {
  let blackouts = await getBlackouts();
  blackouts = blackouts.filter(d => d !== date);
  await writeBlob(BLACKOUTS_PATH, blackouts);
  return blackouts;
}

module.exports = { getBookings, saveBooking, markBookingPaid, getBlackouts, addBlackout, removeBlackout };
