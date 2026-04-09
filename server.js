const path = require('path');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const pdfDir = path.join(__dirname, 'storage', 'pdfs');

if (!fs.existsSync(pdfDir)) {
  fs.mkdirSync(pdfDir, { recursive: true });
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

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseDateInput(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [_, dd, mm, yyyy] = match;
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

async function buildRegistrationPdf(data) {
  let qrBuffer = null;
  try {
    qrBuffer = await QRCode.toBuffer(buildRegistrationQrPayload(data), {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
    });
  } catch (error) {
    console.error('QR generation failed:', error);
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      doc.fontSize(20).text('Bukti Pendaftaran Klinik', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(12).text('Harap tunjukkan dokumen ini saat pendaftaran di klinik.', {
        align: 'center',
      });

      const contentTop = 190;
      const leftX = doc.page.margins.left;
      const rightX = doc.page.width - doc.page.margins.right;

      let textStartX = leftX;
      let textWidth = rightX - leftX;

      if (qrBuffer) {
        const qrSize = 180;
        const qrX = leftX;
        const qrY = contentTop;
        doc.image(qrBuffer, qrX, qrY, { width: qrSize });
        doc
          .fontSize(10)
          .text('QR Verifikasi', qrX, qrY + qrSize + 6, { width: qrSize, align: 'center' });

        textStartX = qrX + qrSize + 24;
        textWidth = rightX - textStartX;
      }

      let textY = contentTop;
      doc.fontSize(12).text(`Nama Pasien: ${data.fullName}`, textStartX, textY, {
        width: textWidth,
      });
      doc.text(`Nomor Antrean: ${data.queueNumber}`, { width: textWidth });
      doc.text(`Tanggal Kunjungan: ${formatDateId(data.queueDate)}`, { width: textWidth });
      doc.text(`Nomor HP: ${data.phone}`, { width: textWidth });
      doc.text(`Email: ${data.email}`, { width: textWidth });
      if (data.nik) doc.text(`NIK: ${data.nik}`, { width: textWidth });
      if (data.birthDate)
        doc.text(`Tanggal Lahir: ${formatDateId(data.birthDate)}`, { width: textWidth });
      if (data.gender) doc.text(`Jenis Kelamin: ${data.gender}`, { width: textWidth });
      if (data.address) doc.text(`Alamat: ${data.address}`, { width: textWidth });
      if (data.complaint) doc.text(`Keluhan: ${data.complaint}`, { width: textWidth });

      doc.moveDown(2);
      doc
        .fontSize(10)
        .text(`ID Registrasi: ${data.registrationId}`, { align: 'right' })
        .text(`Dibuat: ${formatDateId(new Date())}`, { align: 'right' });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
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

    const filePath = path.join(pdfDir, `bukti-pendaftaran-${registrationId}.pdf`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File tidak ditemukan.');
    }

    res.download(filePath, `bukti-pendaftaran-${result.rows[0].queue_number}.pdf`);
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
        error: 'Format tanggal kunjungan harus dd/mm/yyyy.',
      });
    }

    const parsedBirthDate = parseDateInput(birthDate);
    if (birthDate && !parsedBirthDate) {
      return res.status(400).json({
        error: 'Format tanggal lahir harus dd/mm/yyyy.',
      });
    }

    const queueDate = parsedVisitDate || getJakartaDate();

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

      let pdfAttachment = null;
      let pdfFilePath = null;
      try {
        const pdfBuffer = await buildRegistrationPdf({
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
        pdfFilePath = path.join(pdfDir, `bukti-pendaftaran-${registrationResult.rows[0].id}.pdf`);
        fs.writeFileSync(pdfFilePath, pdfBuffer);
        pdfAttachment = {
          filename: `bukti-pendaftaran-${queueNumber}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        };
      } catch (pdfError) {
        console.error('PDF generation failed:', pdfError);
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
              Download Form (PDF)
            </a>
          </p>
          <p>Atau gunakan lampiran PDF pada email ini.</p>
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
              attachments: pdfAttachment ? [pdfAttachment] : undefined,
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
