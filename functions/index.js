const express = require("express");
const admin = require("firebase-admin");
const moment = require("moment");
const TelegramBot = require("node-telegram-bot-api");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const cron = require("node-cron"); // TAMBAHAN: Untuk penjadwalan
require("dotenv").config();

const app = express();
app.use(express.json());

// --- KONFIGURASI FIREBASE ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// --- DATA MOTIVASI RANDOM (Quotes & Video) ---
const motivations = [
  {
    type: "video",
    content:
      "Hai! Coba tonton video ini sebentar, mungkin bisa merubah sudut pandangmu hari ini.",
    url: "https://www.w3schools.com/html/mov_bbb.mp4",
  },
  {
    type: "text",
    content:
      "Ayo berhenti judi, kamu pasti bisa melakukannya kok. Pikirkan keluargamu.",
  },
  {
    type: "video",
    content: "Pesan spesial untukmu: Kamu jauh lebih kuat dari kecanduanmu!",
    url: "https://sample-videos.com/video123/mp4/720/big_buck_bunny_720p_1mb.mp4",
  },
  {
    type: "text",
    content:
      "Hari ini adalah waktu yang tepat untuk memulai lembaran baru tanpa judi.",
  },
  {
    type: "text",
    content:
      "Jangan biarkan hari ini hancur karena kekalahan kemarin. Berhenti sekarang.",
  },
];

// --- KONFIGURASI BOT TELEGRAM ---
const token = process.env.TELEGRAM_TOKEN;
const url =
  process.env.RENDER_EXTERNAL_URL || "https://api-judi-guard.onrender.com";
const bot = new TelegramBot(token);

// Set Webhook
bot.setWebHook(`${url}/bot${token}`);

// --- FITUR: POPUP MENU COMMANDS ---
bot.setMyCommands([
  { command: "start", description: "Dapatkan ID Telegram Anda" },
  { command: "download", description: "Unduh laporan PDF riwayat blokir" },
  { command: "help", description: "Bantuan penggunaan bot" },
]);

// ---------------------------------------------------------
// LOGIKA NOTIFIKASI & CRON JOB (SARAN BARU)
// ---------------------------------------------------------

// Fungsi untuk mengirim notifikasi ke semua user yang punya token FCM
async function sendStopGamblingNotification() {
  console.log("Memulai proses broadcast notifikasi motivasi...");
  try {
    const snapshot = await db.collection("users").get();
    const tokens = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data.fcmToken) tokens.push(data.fcmToken);
    });

    if (tokens.length === 0)
      return console.log("Tidak ada token FCM ditemukan.");

    const message = {
      notification: {
        title: "Garda AI Peduli 🛡️",
        body: "Waktunya refleksi sejenak. Yuk, cek pesan spesial untukmu hari ini.",
      },
      data: {
        screen: "chatbot", // Key untuk navigasi Flutter
      },
      tokens: tokens,
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`Berhasil mengirim ${response.successCount} notifikasi.`);
  } catch (error) {
    console.error("Gagal mengirim notifikasi:", error);
  }
}

// JADWAL PENGETESAN: Setiap 5 Menit
cron.schedule("*/5 * * * *", () => {
  console.log("Menjalankan tugas TEST: Kirim notifikasi setiap 5 menit...");
  sendStopGamblingNotification();
});

// ---------------------------------------------------------
// LOGIKA BOT: MENANGANI PESAN MASUK (ORIGINAL)
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
      const responseText = `Halo! 👋\n\nID Telegram Anda adalah:\n\`${chatId}\`\n\n(Ketuk angka di atas untuk menyalin)\n\nSilakan masukkan ID ini ke aplikasi *Garda Wara*.`;
      bot.sendMessage(chatId, responseText, opts);
    } catch (error) {
      bot.sendMessage(chatId, "Terjadi kesalahan pendaftaran.");
    }
  } else if (text === "/download") {
    try {
      const userSnapshot = await db
        .collection("users")
        .where("guardianChatId", "==", chatId.toString())
        .get();
      if (userSnapshot.empty)
        return bot.sendMessage(
          chatId,
          "❌ Anda belum terhubung dengan user manapun."
        );

      const userData = userSnapshot.docs[userSnapshot.docs.length - 1].data();
      const history = Array.isArray(userData.blockedHistory)
        ? userData.blockedHistory
        : [];
      if (history.length === 0)
        return bot.sendMessage(
          chatId,
          "📭 Belum ada riwayat situs yang diblokir."
        );

      const pdfPath = `./logs_${chatId}.pdf`;
      const doc = new PDFDocument();
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);

      doc
        .fontSize(20)
        .text("LAPORAN RIWAYAT BLOKIR SITUS", { align: "center" });
      doc.fontSize(12).text(`User: ${userData.userName}`, { align: "center" });
      doc.text(`Dicetak pada: ${moment().format("DD MMMM YYYY, HH:mm")}`, {
        align: "center",
      });
      doc.moveDown().moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown();

      history.forEach((item, index) => {
        doc.fontSize(10).text(`${index + 1}. [${item.time}] - ${item.url}`);
        doc.moveDown(0.5);
      });
      doc.end();

      stream.on("finish", async () => {
        await bot.sendDocument(chatId, pdfPath, {
          caption: `Berikut adalah log situs yang dikunjungi oleh Pengguna.`,
        });
        fs.unlinkSync(pdfPath);
      });
    } catch (error) {
      bot.sendMessage(chatId, "⚠️ Terjadi kesalahan saat membuat PDF.");
    }
  } else if (text === "/help") {
    bot.sendMessage(
      chatId,
      "Gunakan /start untuk melihat ID atau /download untuk mengunduh laporan."
    );
  } else {
    bot.sendMessage(
      chatId,
      "⛔ Ketik /start untuk mendapatkan ID atau /download untuk mengunduh laporan."
    );
  }
});

// ---------------------------------------------------------
// API ROUTES
// ---------------------------------------------------------

app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("Server JudiGuard Aktif! 🚀"));

// API: AMBIL MOTIVASI RANDOM (SARAN BARU)
app.get("/random-motivation", (req, res) => {
  const randomItem =
    motivations[Math.floor(Math.random() * motivations.length)];
  res.json(randomItem);
});

// API: Sinkronisasi Notifikasi FCM Secara Manual (Testing)
app.get("/trigger-notif", async (req, res) => {
  await sendStopGamblingNotification();
  res.send("Notifikasi manual sedang diproses.");
});

app.post("/update-history", async (req, res) => {
  const { userId, blockedHistory, guardianChatId } = req.body;
  if (!userId) return res.status(400).send("User ID missing");
  try {
    await db
      .collection("users")
      .doc(userId)
      .set(
        {
          blockedHistory: blockedHistory,
          guardianChatId: guardianChatId ? guardianChatId.toString() : null,
          lastSync: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    res.send("History Updated");
  } catch (error) {
    res.status(500).send(error.message);
  }
});

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

// API-API Lainnya (Check User, Verify Guard) Tetap Sama...
app.get("/check-users", async (req, res) => {
  try {
    const threshold = moment().subtract(75, "minutes").toDate();
    const snapshot = await db
      .collection("users")
      .where("lastHeartbeat", "<", threshold)
      .where("isAlertSent", "==", false)
      .get();
    if (snapshot.empty) return res.send("Semua user terpantau aktif.");
    const batch = db.batch();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.guardianChatId) {
        await sendTelegramAlert(
          data.guardianChatId,
          data.userName,
          data.lastHeartbeat
        );
        batch.update(doc.ref, { isAlertSent: true });
      }
    }
    await batch.commit();
    res.send(`${snapshot.size} peringatan dikirim.`);
  } catch (error) {
    res.status(500).send("Error");
  }
});

app.get("/verify-guard/:chatId", async (req, res) => {
  try {
    const doc = await db
      .collection("registered_guards")
      .doc(req.params.chatId)
      .get();
    res.json(doc.exists ? { valid: true, data: doc.data() } : { valid: false });
  } catch (error) {
    res.status(500).json({ valid: false });
  }
});

async function sendTelegramAlert(chatId, userName, lastHeartbeat) {
  const lastSeen = lastHeartbeat
    ? moment(lastHeartbeat.toDate()).format("HH:mm [WIB]")
    : "Unknown";
  const message = `⚠️ *PERINGATAN* ⚠️\n\nUser: *${userName}*\nStatus: *OFFLINE*\nAktif: *${lastSeen}*`;
  try {
    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (e) {}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server JudiGuard berjalan pada port ${PORT}`)
);
