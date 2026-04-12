const path = require('path');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const { Jimp, loadFont, HorizontalAlign } = require('jimp');
const { SANS_14_BLACK, SANS_16_BLACK, SANS_32_BLACK } = require('@jimp/plugin-print/fonts');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const attachmentDir = path.join(__dirname, 'storage', 'documents');

if (!fs.existsSync(attachmentDir)) {
  fs.mkdirSync(attachmentDir, { recursive: true });
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

// Ensure DB session uses WIB for date/time operations in this app.
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'Asia/Jakarta'").catch((error) => {
    console.error('Failed to set DB timezone:', error);
  });
});

const smtpEnabled = Boolean(
  process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.SMTP_FROM &&
    process.env.SMTP_HOST !== 'smtp.example.com'
);
const resendEnabled = Boolean(process.env.RESEND_API_KEY && process.env.SMTP_FROM);
const replyToTarget = (process.env.REPLY_TO_TARGET || 'admin').toLowerCase();
const replyToAdmin = process.env.REPLY_TO_ADMIN;

function getJakartaDate() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

function parseDateInput(value) {
  if (!value) return null;
  let yyyy;
  let mm;
  let dd;

  const ymd = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    yyyy = ymd[1];
    mm = ymd[2];
    dd = ymd[3];
  } else {
    const dmy = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!dmy) return null;
    dd = dmy[1];
    mm = dmy[2];
    yyyy = dmy[3];
  }

  const y = Number(yyyy);
  const m = Number(mm);
  const d = Number(dd);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const valid =
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() + 1 === m &&
    dt.getUTCDate() === d;

  if (!valid) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function formatDateId(dateValue) {
  if (!dateValue) return '-';
  if (typeof dateValue === 'string') {
    const ddmmyyyy = dateValue.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (ddmmyyyy) {
      dateValue = `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
    }
  }
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
  }).format(date);
}

function buildRegistrationQrPayload(data) {
  return JSON.stringify({
    v: 1,
    id: data.registrationId,
    queueDate: data.queueDate,
    queueNumber: data.queueNumber,
    fullName: data.fullName,
  });
}

function getReplyTo(patientEmail) {
  if (replyToTarget === 'patient') return patientEmail;
  if (replyToTarget === 'both') {
    return [replyToAdmin, patientEmail].filter(Boolean).join(', ');
  }
  if (replyToTarget === 'admin') {
    return replyToAdmin || patientEmail;
  }
  return replyToAdmin || patientEmail;
}

async function buildRegistrationImage(data) {
  const canvasWidth = 1240;
  const canvasHeight = 1754;
  const leftMargin = 72;

  const image = new Jimp({ width: canvasWidth, height: canvasHeight, color: 0xffffffff });
  const titleFont = await loadFont(SANS_32_BLACK);
  const subtitleFont = await loadFont(SANS_32_BLACK);
  const bodyFont = await loadFont(SANS_16_BLACK);
  const detailFont = await loadFont(SANS_32_BLACK);
  const smallFont = await loadFont(SANS_14_BLACK);

  image.print({
    font: titleFont,
    x: 0,
    y: 64,
    text: {
      text: 'Bukti Pendaftaran Klinik',
      alignmentX: HorizontalAlign.CENTER,
    },
    maxWidth: canvasWidth,
  });
  image.print({
    font: subtitleFont,
    x: 0,
    y: 170,
    text: {
      text: 'Harap tunjukkan dokumen ini saat pendaftaran di klinik.',
      alignmentX: HorizontalAlign.CENTER,
    },
    maxWidth: canvasWidth - 120,
  });

  const qrBuffer = await QRCode.toBuffer(buildRegistrationQrPayload(data), {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
  });
  const qrImage = await Jimp.read(qrBuffer);
  image.composite(qrImage, leftMargin, 350);
  image.print({
    font: smallFont,
    x: leftMargin,
    y: 680,
    text: {
      text: 'QR Verifikasi',
      alignmentX: HorizontalAlign.CENTER,
    },
    maxWidth: 320,
  });

  const detailLines = [
    `Nama Pasien: ${data.fullName}`,
    `Nomor Antrean: ${data.queueNumber}`,
    `Tanggal Kunjungan: ${formatDateId(data.queueDate)}`,
    `Nomor HP: ${data.phone}`,
    `Email: ${data.email}`,
  ];
  if (data.nik) detailLines.push(`NIK: ${data.nik}`);
  if (data.birthDate) detailLines.push(`Tanggal Lahir: ${formatDateId(data.birthDate)}`);
  if (data.gender) detailLines.push(`Jenis Kelamin: ${data.gender}`);
  if (data.address) detailLines.push(`Alamat: ${data.address}`);
  if (data.complaint) detailLines.push(`Keluhan: ${data.complaint}`);

  const detailText = detailLines.join('\n\n');
  image.print({
    font: detailFont,
    x: 430,
    y: 340,
    text: detailText,
    maxWidth: canvasWidth - 500,
  });

  image.print({
    font: bodyFont,
    x: 0,
    y: 1450,
    text: {
      text: `ID Registrasi: ${data.registrationId}\nDibuat: ${formatDateId(new Date())}`,
      alignmentX: HorizontalAlign.RIGHT,
    },
    maxWidth: canvasWidth - leftMargin,
  });

  return image.getBuffer('image/jpeg');
}

async function sendEmail({ to, subject, text, html, attachments, replyTo }) {
  if (resendEnabled) {
    const resendAttachments = (attachments || []).map((attachment) => ({
      filename: attachment.filename,
      content: Buffer.isBuffer(attachment.content)
        ? attachment.content.toString('base64')
        : attachment.content,
    }));

    const resendPayload = {
      from: process.env.SMTP_FROM,
      to: [to],
      subject,
      text,
      html,
      reply_to: replyTo ? [replyTo] : undefined,
      attachments: resendAttachments.length > 0 ? resendAttachments : undefined,
    };

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(resendPayload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Resend error ${response.status}: ${body}`);
    }

    return { skipped: false, provider: 'resend' };
  }

  if (!smtpEnabled) {
    return { skipped: true, provider: 'none' };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await Promise.race([
    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      text,
      html,
      attachments,
      replyTo,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('SMTP timeout after 15s')), 15000)
    ),
  ]);

  return { skipped: false, provider: 'smtp' };
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/download/:id', async (req, res) => {
  try {
    const registrationId = Number(req.params.id);
    if (!Number.isInteger(registrationId) || registrationId <= 0) {
      return res.status(400).send('ID tidak valid.');
    }

    const result = await pool.query(
      'SELECT id, queue_number FROM registrations WHERE id = $1',
      [registrationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).send('Data tidak ditemukan.');
    }

    const filePath = path.join(attachmentDir, `bukti-pendaftaran-${registrationId}.jpg`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File tidak ditemukan.');
    }

    res.download(filePath, `bukti-pendaftaran-${result.rows[0].queue_number}.jpg`);
  } catch (error) {
    console.error('Download error:', error);
    return res.status(500).send('Gagal mengunduh.');
  }
});

app.post('/api/registrations', async (req, res) => {
  try {
    const {
      fullName,
      nik,
      birthDate,
      gender,
      phone,
      email,
      address,
      complaint,
      visitDate,
    } = req.body;

    if (!fullName || !phone || !email) {
      return res.status(400).json({
        error: 'Nama lengkap, nomor HP, dan email wajib diisi.',
      });
    }

    const parsedVisitDate = parseDateInput(visitDate);
    if (visitDate && !parsedVisitDate) {
      return res.status(400).json({
        error: 'Tanggal kunjungan tidak valid. Gunakan format dd/mm/yyyy.',
      });
    }

    const jakartaToday = getJakartaDate();
    if (parsedVisitDate && parsedVisitDate < jakartaToday) {
      return res.status(400).json({
        error: 'Tanggal kunjungan tidak boleh tanggal kemarin atau sebelumnya.',
      });
    }

    const parsedBirthDate = parseDateInput(birthDate);
    if (birthDate && !parsedBirthDate) {
      return res.status(400).json({
        error: 'Tanggal lahir tidak valid. Gunakan format dd/mm/yyyy.',
      });
    }

    // Queue number resets per visit date at 24:00 WIB.
    const queueDate = parsedVisitDate || jakartaToday;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const counterResult = await client.query(
        `INSERT INTO queue_counters (queue_date, last_number)
         VALUES ($1, 1)
         ON CONFLICT (queue_date)
         DO UPDATE SET last_number = queue_counters.last_number + 1
         RETURNING last_number;`,
        [queueDate]
      );

      const queueNumber = counterResult.rows[0].last_number;

      const registrationResult = await client.query(
        `INSERT INTO registrations (
          full_name,
          nik,
          birth_date,
          gender,
          phone,
          email,
          address,
          complaint,
          visit_date,
          queue_number
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id;`,
        [
          fullName,
          nik || null,
          parsedBirthDate || null,
          gender || null,
          phone,
          email,
          address || null,
          complaint || null,
          queueDate,
          queueNumber,
        ]
      );

      await client.query('COMMIT');

      let imageAttachment = null;
      try {
        const imageBuffer = await buildRegistrationImage({
          registrationId: registrationResult.rows[0].id,
          fullName,
          nik,
          birthDate: parsedBirthDate,
          gender,
          phone,
          email,
          address,
          complaint,
          queueDate,
          queueNumber,
        });
        const imageFilePath = path.join(
          attachmentDir,
          `bukti-pendaftaran-${registrationResult.rows[0].id}.jpg`
        );
        fs.writeFileSync(imageFilePath, imageBuffer);
        imageAttachment = {
          filename: `bukti-pendaftaran-${queueNumber}.jpg`,
          content: imageBuffer,
          contentType: 'image/jpeg',
        };
      } catch (imageError) {
        console.error('JPG generation failed:', imageError);
      }

      const downloadUrl = `${baseUrl}/download/${registrationResult.rows[0].id}`;
      const displayVisitDate = formatDateId(queueDate);
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; color: #0f172a;">
          <h2>Bukti Pendaftaran Klinik</h2>
          <p>Halo ${fullName},</p>
          <p>Pendaftaran Anda berhasil.</p>
          <ul>
            <li>Tanggal kunjungan: <strong>${displayVisitDate}</strong></li>
            <li>Nomor antrean: <strong>${queueNumber}</strong></li>
          </ul>
          <p>Silakan unduh bukti pendaftaran:</p>
          <p>
            <a href="${downloadUrl}" style="display:inline-block;padding:10px 16px;background:#0f766e;color:#ffffff;text-decoration:none;border-radius:8px;">
              Download Form (JPG)
            </a>
          </p>
          <p style="margin-top:8px;">
            Jika tombol tidak tampil, gunakan link ini:
            <a href="${downloadUrl}">${downloadUrl}</a>
          </p>
          <p>Atau gunakan lampiran JPG pada email ini.</p>
        </div>
      `;

      const responsePayload = {
        registrationId: registrationResult.rows[0].id,
        queueDate,
        queueNumber,
        notification: smtpEnabled || resendEnabled ? 'QUEUED' : 'SKIPPED',
      };

      res.status(201).json(responsePayload);

      if (smtpEnabled || resendEnabled) {
        setImmediate(async () => {
          try {
            await sendEmail({
              to: email,
              subject: 'Konfirmasi Pendaftaran Klinik',
              text:
                `Halo ${fullName},\n\n` +
                `Pendaftaran Anda berhasil.\n` +
                `Tanggal kunjungan: ${displayVisitDate}\n` +
                `Nomor antrean: ${queueNumber}\n\n` +
                `Unduh bukti pendaftaran: ${downloadUrl}\n\n` +
                `Simpan email ini sebagai bukti pendaftaran.`,
              html: emailHtml,
              attachments: imageAttachment ? [imageAttachment] : undefined,
              replyTo: getReplyTo(email),
            });
          } catch (emailError) {
            console.error('Email send failed:', emailError);
          }
        });
      }

      return;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Registration transaction failed:', error);
      return res.status(500).json({
        error: 'Gagal menyimpan pendaftaran.',
        detail: process.env.NODE_ENV === 'production' ? undefined : String(error.message || error),
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Registration handler error:', error);
    return res.status(500).json({
      error: 'Terjadi kesalahan pada server.',
      detail: process.env.NODE_ENV === 'production' ? undefined : String(error.message || error),
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
