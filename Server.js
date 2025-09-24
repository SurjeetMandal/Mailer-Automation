import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { parse } from "csv-parse";
import nodemailer from "nodemailer";
import cors from "cors";
import pLimit from "p-limit";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

// Load environment variables
dotenv.config();

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ✅ Proper CORS setup
const corsOptions = {
  origin: [
    "http://localhost:5173",               // local frontend
    "https://certificate-frontend.vercel.app" , // deployed frontend
    "https://nielitmailautomation.netlify.app/"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));

app.use(express.json());

// Multer storage for temp uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "temp", Date.now().toString());
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage });

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // ⚠️ Gmail App Password
  },
});

// Main route
app.post(
  "/distribute-files",
  upload.fields([
    { name: "studentsCsv", maxCount: 1 },
    { name: "certificates", maxCount: 1000 },
    { name: "scorecards", maxCount: 1000 },
  ]),
  async (req, res) => {
    const { files } = req;

    if (!files || !files.studentsCsv || !files.certificates || !files.scorecards) {
      return res.status(400).send("Missing one or more required files.");
    }

    const csvFilePath = files.studentsCsv[0].path;
    const certificateFiles = files.certificates;
    const scorecardFiles = files.scorecards;

    const records = [];

    try {
      // Parse CSV file
      const parser = fs
        .createReadStream(csvFilePath)
        .pipe(parse({ columns: true, skip_empty_lines: true }));

      for await (const record of parser) {
        records.push(record);
      }

      // Build lookup maps
      const certMap = new Map(
        certificateFiles.map((file) => {
          const key = path.basename(file.originalname).split(" - ")[0];
          return [key.trim(), file.path];
        })
      );

      const scorecardMap = new Map(
        scorecardFiles.map((file) => {
          const key = path.basename(file.originalname).split(" - ")[0];
          return [key.trim(), file.path];
        })
      );

      // Concurrency limiter
      const limit = pLimit(5);

      // Track already sent emails
      const sentEmails = new Set();

      // Create email tasks
      const emailTasks = records.map((student) =>
        limit(async () => {
          const courseId = student["BATCH"]?.trim();
          const rollNo = parseInt(student["Roll No."]?.trim());
          const email = student["Email ID"]?.trim();

          if (!email) {
            console.log(`Skipping Roll No. ${rollNo} (missing email)`);
            return;
          }

          // ✅ Skip if already sent
          if (sentEmails.has(email)) {
            console.log(`⏭️ Already sent to ${email}, skipping...`);
            return;
          }

          const attachments = [];

          const certFileKey = `${rollNo}_${courseId}`;
          const scorecardFileKey = `${2 * rollNo - 1}_${courseId}`;

          if (certMap.has(certFileKey)) {
            attachments.push({
              filename: path.basename(certMap.get(certFileKey)),
              path: certMap.get(certFileKey),
            });
          } else {
            console.warn(`Certificate missing for Roll No. ${rollNo}`);
          }

          if (scorecardMap.has(scorecardFileKey)) {
            attachments.push({
              filename: path.basename(scorecardMap.get(scorecardFileKey)),
              path: scorecardMap.get(scorecardFileKey),
            });
          } else {
            console.warn(`Scorecard missing for Roll No. ${rollNo}`);
          }

          if (attachments.length > 0) {
            const mailOptions = {
              from: process.env.EMAIL_USER,
              to: email,
              subject: "Your Course Certificate and Scorecard",
              html: `
                <p>Dear ${student["Name"]},</p>
                <p><b>Congratulations!</b> You have successfully completed the course.</p>
                <p>I hope this course fulfilled your expectations. I look forward to helping you gain knowledge as per industry standards in upcoming training programmes as well.</p>
                <p>To get more details about any other course in IT/Electronics, visit 
                <a href="https://www.nielit.gov.in/delhi/index.php" target="_blank">NIELIT Delhi Centre</a> regularly.<br>
                Follow us on <a href="https://www.facebook.com" target="_blank">Facebook</a> and 
                <a href="https://x.com" target="_blank">X</a> for updates.</p>
                <p>Please find attached your Course Completion Certificate and Scorecard.</p>
                <p>Regards,<br>NIELIT Delhi Centre, Janakpuri</p>
              `,
              attachments,
            };

            await transporter.sendMail(mailOptions);
            sentEmails.add(email); // ✅ Mark as sent
            console.log(`✅ Email sent to ${email}`);
          } else {
            console.log(`⚠️ No files to send for Roll No. ${rollNo}`);
          }
        })
      );

      await Promise.allSettled(emailTasks);

      // Clean up temp files
      fs.rmSync(path.dirname(files.studentsCsv[0].path), {
        recursive: true,
        force: true,
      });

      res.status(200).send("Distribution process completed successfully! 🎉");
    } catch (error) {
      console.error("❌ Error during distribution:", error);

      if (files && files.studentsCsv && files.studentsCsv[0]) {
        fs.rmSync(path.dirname(files.studentsCsv[0].path), {
          recursive: true,
          force: true,
        });
      }

      res.status(500).send("An error occurred during the distribution process.");
    }
  }
);

export default app;

// if (process.env.NODE_ENV !== "production") {
//   const PORT = process.env.PORT || 5000;
//   app.listen(PORT, () => {
//     console.log(`Server running locally on http://localhost:${PORT}`);
//   });
// }

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
