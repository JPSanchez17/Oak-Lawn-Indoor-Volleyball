const { onDocumentCreated, onDocumentDeleted } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { defineSecret } = require('firebase-functions/params');
const { Resend } = require('resend');

initializeApp();
const db = getFirestore();
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const FROM = 'Oak Lawn Volleyball <noreply@oaklawnvball.com>';

// Helper: get email from users/{uid}/private/contact
async function getUserEmail(uid) {
  const snap = await db.doc(`users/${uid}/private/contact`).get();
  return snap.exists ? snap.data().email : null;
}

// ── 1. New event posted → email everyone who has a profile ──────────────────
exports.onEventCreated = onDocumentCreated(
  { document: 'events/{eventId}', secrets: [RESEND_API_KEY] },
  async (event) => {
    const ev = event.data.data();
    const resend = new Resend(RESEND_API_KEY.value());

    const usersSnap = await db.collection('users').get();
    const emailJobs = [];

    for (const userDoc of usersSnap.docs) {
      const contactSnap = await db.doc(`users/${userDoc.id}/private/contact`).get();
      if (!contactSnap.exists) continue;
      const { email } = contactSnap.data();
      if (!email) continue;

      const d = new Date(ev.date + 'T12:00:00');
      const dateStr = d.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
      });

      emailJobs.push(resend.emails.send({
        from: FROM,
        to: email,
        subject: `New Open Gym Posted — ${dateStr}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:auto;background:#100730;color:#F0EEFF;padding:32px;border-radius:12px">
            <div style="text-align:center;margin-bottom:24px">
              <div style="font-size:48px">🏐</div>
              <h1 style="font-size:28px;margin:8px 0;background:linear-gradient(135deg,#FFC107,#FF6200);-webkit-background-clip:text;-webkit-text-fill-color:transparent">New Open Gym!</h1>
            </div>
            <div style="background:#1C0F45;border:1px solid #3D2A7A;border-radius:10px;padding:20px;margin-bottom:20px">
              <div style="font-size:20px;font-weight:700;margin-bottom:12px">${ev.name}</div>
              <div style="color:#9080C8;line-height:2">
                📅 ${dateStr}<br>
                🕐 ${ev.time}<br>
                📍 ${ev.location}<br>
                💰 $${ev.cost} per person<br>
                👥 ${ev.spots} spots available${ev.courts ? `<br>🏐 ${ev.courts} court${ev.courts > 1 ? 's' : ''}` : ''}
              </div>
            </div>
            <div style="text-align:center">
              <a href="https://oaklawnvball.com" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#FF6200,#FFC107);color:#000;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px">Sign Up Now →</a>
            </div>
            <p style="margin-top:28px;font-size:12px;color:#9080C8;text-align:center">
              Oak Lawn Indoor Volleyball · <a href="https://oaklawnvball.com" style="color:#9080C8">oaklawnvball.com</a><br>
              You're receiving this because you have an OLIV account.
            </p>
          </div>`
      }));
    }

    await Promise.allSettled(emailJobs);
    console.log(`Event announcement sent to ${emailJobs.length} players.`);
  }
);

// ── 2. Registration cancelled → promote first waitlisted person ──────────────
exports.onRegistrationDeleted = onDocumentDeleted(
  { document: 'registrations/{regId}', secrets: [RESEND_API_KEY] },
  async (event) => {
    const deleted = event.data.data();
    if (deleted.waitlisted) return; // waitlist person left — no promotion needed

    const { eventId } = deleted;
    const resend = new Resend(RESEND_API_KEY.value());

    // Get the event
    const evSnap = await db.doc(`events/${eventId}`).get();
    if (!evSnap.exists) return;
    const ev = evSnap.data();

    // Check if a spot actually opened
    const mainRegsSnap = await db.collection('registrations')
      .where('eventId', '==', eventId)
      .where('waitlisted', '==', false)
      .get();
    const taken = mainRegsSnap.docs.reduce(
      (sum, d) => sum + 1 + (d.data().guests?.length || 0), 0
    );
    if (taken >= ev.spots) return; // still full

    // Find the first waitlisted person (oldest signedUpAt)
    const waitSnap = await db.collection('registrations')
      .where('eventId', '==', eventId)
      .where('waitlisted', '==', true)
      .orderBy('signedUpAt')
      .limit(1)
      .get();
    if (waitSnap.empty) return;

    const waitDoc = waitSnap.docs[0];
    const waitReg = waitDoc.data();

    // Promote them
    await waitDoc.ref.update({ waitlisted: false });

    // Email them
    const email = await getUserEmail(waitReg.uid);
    if (!email) return;

    const d = new Date(ev.date + 'T12:00:00');
    const dateStr = d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    await resend.emails.send({
      from: FROM,
      to: email,
      subject: `✅ You're in! Spot opened for ${dateStr}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;background:#100730;color:#F0EEFF;padding:32px;border-radius:12px">
          <div style="text-align:center;margin-bottom:24px">
            <div style="font-size:48px">🎉</div>
            <h1 style="font-size:28px;margin:8px 0;color:#22C55E">Your spot is confirmed!</h1>
            <p style="color:#9080C8;margin:0">You were first on the waitlist — you're in!</p>
          </div>
          <div style="background:#1C0F45;border:1px solid #3D2A7A;border-radius:10px;padding:20px;margin-bottom:20px">
            <div style="font-size:20px;font-weight:700;margin-bottom:12px">${ev.name}</div>
            <div style="color:#9080C8;line-height:2">
              📅 ${dateStr}<br>
              🕐 ${ev.time}<br>
              📍 ${ev.location}
            </div>
          </div>
          <div style="background:rgba(255,98,0,0.1);border:1px solid rgba(255,98,0,0.3);border-radius:10px;padding:16px;margin-bottom:20px;text-align:center">
            <div style="font-weight:700;color:#FFC107">💰 Remember to pay $${ev.cost} at the door or via Venmo</div>
          </div>
          <div style="text-align:center">
            <a href="https://oaklawnvball.com" style="display:inline-block;padding:14px 32px;background:#22C55E;color:#000;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px">View Schedule →</a>
          </div>
          <p style="margin-top:28px;font-size:12px;color:#9080C8;text-align:center">
            Oak Lawn Indoor Volleyball · <a href="https://oaklawnvball.com" style="color:#9080C8">oaklawnvball.com</a>
          </p>
        </div>`
    });

    console.log(`Promoted ${waitReg.uid} off waitlist for event ${eventId}`);
  }
);
