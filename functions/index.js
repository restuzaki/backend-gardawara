const express = require("express");
const admin = require("firebase-admin");
const axios = require("axios");
const moment = require("moment");
require("dotenv").config();

const app = express();
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_TOKEN;

// 1. API: HEARTBEAT (Dipanggil Flutter)
app.post("/heartbeat", async (req, res) => {
  const { userId, guardianChatId, userName } = req.body;
  if (!userId) return res.status(400).send("User ID missing");

  try {
    await db
      .collection("users")
      .doc(userId)
      .set(
        {
          userName: userName || "No Name",
          guardianChatId: guardianChatId,
          lastHeartbeat: admin.firestore.FieldValue.serverTimestamp(),
          isAlertSent: false,
        },
        { merge: true }
      );
    res.send("Heartbeat OK");
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// 2. API: CHECKER (Dipanggil oleh Cron-job.org setiap jam)
app.get("/check-users", async (req, res) => {
  console.log("Memulai pengecekan...");
  const threshold = moment().subtract(3, "hours");

  const snapshot = await db
    .collection("users")
    .where("lastHeartbeat", "<", threshold.toDate())
    .where("isAlertSent", "==", false)
    .get();

  if (snapshot.empty) return res.send("Semua aman.");

  const batch = db.batch();
  let count = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (data.guardianChatId) {
      await sendTelegramAlert(data.guardianChatId, data.userName);
      batch.update(doc.ref, { isAlertSent: true });
      count++;
    }
  }

  await batch.commit();
  res.send(`Peringatan dikirim ke ${count} user.`);
});

async function sendTelegramAlert(chatId, userName) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const message = `⚠️ *PERINGATAN* ⚠️\nUser: ${userName} hilang!`;
  try {
    await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: "Markdown",
    });
  } catch (e) {
    console.error(e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));
