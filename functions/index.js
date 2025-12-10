const express = require("express");
const admin = require("firebase-admin");
const moment = require("moment");
const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();

const app = express();
app.use(express.json());

// --- KONFIGURASI FIREBASE ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// --- KONFIGURASI TELEGRAM BOT ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_TOKEN;

// Inisialisasi Bot dengan mode POLLING
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ---------------------------------------------------------
// LOGIKA BOT: MENANGANI SEMUA PESAN MASUK
// ---------------------------------------------------------
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").toString().toLowerCase().trim();

  if (text === "/start") {
    const opts = { parse_mode: "Markdown" };
    const responseText = `Halo! 👋\n\nID Telegram Anda Untuk Gardawara AI adalah:\n\`${chatId}\`\n\n(Ketuk angka di atas untuk menyalin)\n\nSilakan masukkan ID ini ke aplikasi *Garda Wara* sebagai Penjamin.`;

    bot.sendMessage(chatId, responseText, opts);
    console.log(`User ${msg.from.first_name} meminta ID: ${chatId}`);
  } else {
    const errorText =
      "⛔ Maaf, saya adalah Bot Otomatis.\n\nSaya tidak dapat membalas chat manual. Silakan ketik atau klik /start untuk mendapatkan ID Penjamin Anda.";
    bot.sendMessage(chatId, errorText);
  }
});

// ---------------------------------------------------------
// 1. API: HEARTBEAT (Dipanggil Flutter)
// ---------------------------------------------------------
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

// ---------------------------------------------------------
// 2. API: CHECKER (Dipanggil oleh Cron-job.org setiap jam)
// ---------------------------------------------------------
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

// Fungsi Helper Kirim ke Telegram
async function sendTelegramAlert(chatId, userName) {
  const message = `⚠️ *PERINGATAN* ⚠️\nUser: ${userName} hilang/offline lebih dari 3 jam!`;
  try {
    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (e) {
    console.error("Gagal kirim telegram:", e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));
