const express = require("express");
const admin = require("firebase-admin");
const moment = require("moment");
const TelegramBot = require("node-telegram-bot-api");
const PDFDocument = require("pdfkit");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(express.json());

// --- KONFIGURASI FIREBASE ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

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

// Endpoint untuk Webhook Telegram
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ---------------------------------------------------------
// LOGIKA BOT: MENANGANI PESAN MASUK
// ---------------------------------------------------------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").toString().toLowerCase().trim();
  const firstName = msg.from.first_name || "User";

  // LOGIKA: /START
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
      console.log(`User ${firstName} terdaftar: ${chatId}`);
    } catch (error) {
      console.error("Firestore Error:", error);
      bot.sendMessage(chatId, "Terjadi kesalahan pendaftaran.");
    }

    // LOGIKA: /DOWNLOAD (GENERATE PDF)
  } else if (text === "/download") {
    bot.sendMessage(
      chatId,
      "⏳ Sedang menyiapkan laporan PDF, mohon tunggu..."
    );

    try {
      const userSnapshot = await db
        .collection("users")
        .where("guardianChatId", "==", chatId.toString())
        .limit(1)
        .get();

      if (userSnapshot.empty) {
        return bot.sendMessage(
          chatId,
          "❌ Anda belum terhubung dengan user manapun."
        );
      }

      const userData = userSnapshot.docs[0].data();
      const history = userData.blockedHistory || [];

      if (history.length === 0) {
        return bot.sendMessage(
          chatId,
          "📭 Belum ada riwayat situs yang diblokir."
        );
      }

      const pdfPath = `./logs_${chatId}.pdf`;
      const doc = new PDFDocument();
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);

      // Header PDF
      doc
        .fontSize(20)
        .text("LAPORAN RIWAYAT BLOKIR SITUS", { align: "center" });
      doc.fontSize(12).text(`User: ${userData.userName}`, { align: "center" });
      doc.text(`Dicetak pada: ${moment().format("DD MMMM YYYY, HH:mm")}`, {
        align: "center",
      });
      doc.moveDown();
      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
      doc.moveDown();

      // Isi Riwayat
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
      console.error("PDF Error:", error);
      bot.sendMessage(chatId, "⚠️ Terjadi kesalahan saat membuat PDF.");
    }

    // LOGIKA: HELP ATAU LAINNYA
  } else if (text === "/help") {
    bot.sendMessage(
      chatId,
      "Gunakan /start untuk melihat ID atau /download untuk mengunduh laporan."
    );
  } else {
    bot.sendMessage(
      chatId,
      "⛔ Ketik /start untuk mendapatkan ID atau /download untuk mengunduh laporan. "
    );
  }
});

// ---------------------------------------------------------
// API ROUTES
// ---------------------------------------------------------

// Health Check
app.get("/", (req, res) => res.send("Server JudiGuard Aktif! 🚀"));

// 1. API: UPDATE HISTORY (Sinkronisasi dari Flutter)
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
    console.error("Gagal update history:", error);
    res.status(500).send(error.message);
  }
});

// 2. API: HEARTBEAT (Dipanggil dari Flutter)
app.post("/heartbeat", async (req, res) => {
  const { userId, guardianChatId, userName } = req.body;
  if (!userId) return res.status(400).send("User ID missing");

  try {
    console.log(`Menerima heartbeat dari: ${userName} (${userId})`);
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
    console.error("Gagal update heartbeat:", error);
    res.status(500).send(error.message);
  }
});

// 3. API: CHECKER (Dipanggil oleh Cron-job)
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
    const alertPromises = [];

    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.guardianChatId) {
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

// 4. API: VERIFY GUARD
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
  const lastSeen = lastHeartbeat
    ? moment(lastHeartbeat.toDate()).format("HH:mm [WIB]")
    : "Waktu tidak diketahui";

  const message =
    `⚠️ *PERINGATAN KEAMANAN* ⚠️\n\n` +
    `Penjamin User: *${userName}*\n` +
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
