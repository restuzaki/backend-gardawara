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

const token = process.env.TELEGRAM_TOKEN;
const url =
  process.env.RENDER_EXTERNAL_URL || "https://api-judi-guard.onrender.com";

// Inisialisasi Bot TANPA Polling
const bot = new TelegramBot(token);

// Set Webhook ke Telegram
bot.setWebHook(`${url}/bot${token}`);

// Endpoint khusus untuk menerima update dari Telegram
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ---------------------------------------------------------
// LOGIKA BOT: MENANGANI SEMUA PESAN MASUK
// ---------------------------------------------------------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").toString().toLowerCase().trim();
  const firstName = msg.from.first_name || "User";

  if (text === "/start") {
    try {
      await db
        .collection("registered_guards")
        .doc(chatId.toString())
        .set({
          chatId: chatId,
          firstName: firstName,
          username: msg.from.username || "",
          registeredAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      const opts = { parse_mode: "Markdown" };
      const responseText = `Halo! 👋\n\nID Telegram Anda adalah:\n\`${chatId}\`\n\nSilakan masukkan ID ini ke aplikasi *Garda Wara*.`;

      bot.sendMessage(chatId, responseText, opts);
      console.log(`User ${firstName} terdaftar: ${chatId}`);
    } catch (error) {
      console.error("Firestore Error:", error);
      bot.sendMessage(chatId, "Terjadi kesalahan pendaftaran.");
    }
  } else {
    bot.sendMessage(chatId, "⛔ Ketik /start untuk mendapatkan ID.");
  }
});

// ---------------------------------------------------------
// API ROUTES
// ---------------------------------------------------------

// Health Check
app.get("/", (req, res) => res.send("Server JudiGuard Aktif! 🚀"));

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

// 2. API: CHECKER (Cron-job)
app.get("/check-users", async (req, res) => {
  const threshold = moment().subtract(3, "hours");
  const snapshot = await db
    .collection("users")
    .where("lastHeartbeat", "<", threshold.toDate())
    .where("isAlertSent", "==", false)
    .get();

  if (snapshot.empty) return res.send("Aman.");

  const batch = db.batch();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (data.guardianChatId) {
      await sendTelegramAlert(data.guardianChatId, data.userName);
      batch.update(doc.ref, { isAlertSent: true });
    }
  }
  await batch.commit();
  res.send("Peringatan dikirim.");
});

// 3. API: VERIFY GUARD
app.get("/verify-guard/:chatId", async (req, res) => {
  try {
    const doc = await db
      .collection("registered_guards")
      .doc(req.params.chatId)
      .get();
    if (doc.exists) {
      res.json({ valid: true, data: doc.data() });
    } else {
      res.status(404).json({ valid: false, message: "ID tidak terdaftar." });
    }
  } catch (error) {
    res.status(500).json({ valid: false });
  }
});

async function sendTelegramAlert(chatId, userName) {
  const message = `⚠️ *PERINGATAN* ⚠️\nUser: ${userName} offline lebih dari 3 jam!`;
  try {
    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (e) {
    console.error("Gagal kirim alert:", e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));
