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

// Inisialisasi Bot TANPA Polling (Menggunakan Webhook)
const bot = new TelegramBot(token);

bot.setWebHook(`${url}/bot${token}`);

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

// 1. API: HEARTBEAT (Dipanggil dari Flutter)
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

// 2. API: CHECKER (Dipanggil oleh Cron-job setiap 10-14 menit)
app.get("/check-users", async (req, res) => {
  try {
    // Threshold diatur ke 1 jam
    const threshold = moment().subtract(2, "hours").toDate();

    const snapshot = await db
      .collection("users")
      .where("lastHeartbeat", "<", threshold)
      .where("isAlertSent", "==", false)
      .get();

    if (snapshot.empty) return res.send("Semua user terpantau aktif.");

    const batch = db.batch();
    const alertPromises = [];

    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.guardianChatId) {
        // Kirim data lastHeartbeat ke fungsi alert
        alertPromises.push(
          sendTelegramAlert(
            data.guardianChatId,
            data.userName,
            data.lastHeartbeat
          )
        );
        batch.update(doc.ref, { isAlertSent: true });
      }
    }

    await Promise.all(alertPromises);
    await batch.commit();

    res.send(`${snapshot.size} peringatan telah dikirim.`);
  } catch (error) {
    console.error("Checker Error:", error);
    res.status(500).send("Internal Server Error");
  }
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

// ---------------------------------------------------------
// FUNGSI PEMBANTU (HELPER)
// ---------------------------------------------------------

async function sendTelegramAlert(chatId, userName, lastHeartbeat) {
  // Format waktu dari Firestore Timestamp
  const lastSeen = lastHeartbeat
    ? moment(lastHeartbeat.toDate()).format("HH:mm [WIB]")
    : "Waktu tidak diketahui";

  const message =
    `⚠️ *PERINGATAN KEAMANAN* ⚠️\n\n` +
    `User: *${userName}*\n` +
    `Status: *OFFLINE*\n` +
    `Terakhir Aktif: *${lastSeen}*\n\n` +
    `Aplikasi sudah tidak mengirim data selama lebih dari 1 jam. Mohon segera hubungi yang bersangkutan.`;

  try {
    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (e) {
    console.error(`Gagal mengirim pesan ke ${chatId}:`, e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server JudiGuard berjalan pada port ${PORT}`)
);
