const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const { Jimp, loadFont, HorizontalAlign } = require('jimp');
const { SANS_14_BLACK, SANS_16_BLACK, SANS_32_BLACK } = require('@jimp/plugin-print/fonts');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const attachmentDir = path.join(__dirname, 'storage', 'documents');
const adminSessionCookieName = 'klinik_admin_session';
const adminSessionTtlMs = 1000 * 60 * 60 * 8; // 8 jam
const adminSessions = new Map();
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'admin12345';

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
  options: '-c timezone=Asia/Jakarta',
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS queue_date DATE`);
    await client.query(`
      ALTER TABLE registrations
      ADD COLUMN IF NOT EXISTS registration_status VARCHAR(24) NOT NULL DEFAULT 'registered'
    `);
    await client.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ`);
    await client.query(`
      UPDATE registrations
      SET queue_date = (created_at AT TIME ZONE 'Asia/Jakarta')::date
      WHERE queue_date IS NULL
    `);
    await client.query(`DROP INDEX IF EXISTS registrations_queue_unique`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS registrations_queue_date_idx
      ON registrations (queue_date, queue_number)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS registrations_visit_date_status_idx
      ON registrations (visit_date, registration_status)
    `);
  } finally {
    client.release();
  }
}

const smtpEnabled = Boolean(
  process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.SMTP_FROM &&
    process.env.SMTP_HOST !== 'smtp.example.com'
);
const resendEnabled = Boolean(process.env.RESEND_API_KEY && process.env.SMTP_FROM);
const whatsappEnabled = Boolean(
  process.env.TWILIO_WHATSAPP_ENABLED === 'true' &&
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_FROM
);
const twilioClient = whatsappEnabled
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const replyToTarget = (process.env.REPLY_TO_TARGET || 'admin').toLowerCase();
const replyToAdmin = process.env.REPLY_TO_ADMIN;

function sanitizeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseCookies(header = '') {
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const eqIdx = item.indexOf('=');
      if (eqIdx <= 0) return acc;
      const key = item.slice(0, eqIdx).trim();
      const val = item.slice(eqIdx + 1).trim();
      acc[key] = decodeURIComponent(val);
      return acc;
    }, {});
}

function createAdminSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, {
    username,
    expiresAt: Date.now() + adminSessionTtlMs,
  });
  return token;
}

function setAdminSessionCookie(res, token) {
  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${adminSessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secureFlag}`
  );
}

function clearAdminSessionCookie(res) {
  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${adminSessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`
  );
}

function getAdminSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[adminSessionCookieName];
  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function requireAdminAuth(req, res, next) {
  const session = getAdminSession(req);
  if (!session) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/admin/login');
  }
  req.adminSession = session;
  return next();
}

function clearExpiredAdminSessions() {
  const now = Date.now();
  for (const [token, session] of adminSessions.entries()) {
    if (session.expiresAt < now) {
      adminSessions.delete(token);
    }
  }
}

setInterval(clearExpiredAdminSessions, 1000 * 60 * 10).unref();

function buildAdminLoginPage(errorCode = '') {
  const errorMap = {
    invalid: 'Username atau password salah.',
    missing: 'Username dan password wajib diisi.',
  };
  const message = errorMap[errorCode] || '';
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Admin Login - Klinik</title>
    <style>
      body { font-family: Arial, sans-serif; background:#0b1f5e; margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; }
      .card { width:100%; max-width:360px; background:#fff; border-radius:14px; padding:24px; box-shadow:0 10px 32px rgba(0,0,0,.25); }
      h1 { margin:0 0 16px; font-size:24px; color:#0f172a; }
      label { display:block; font-weight:700; margin:12px 0 6px; color:#334155; }
      input { width:100%; box-sizing:border-box; padding:10px 12px; border:1px solid #cbd5e1; border-radius:8px; font-size:15px; }
      button { width:100%; margin-top:16px; border:none; background:#0f766e; color:#fff; padding:12px; border-radius:9px; font-weight:700; cursor:pointer; }
      .error { margin-top:10px; background:#fef2f2; color:#991b1b; border:1px solid #fecaca; border-radius:8px; padding:10px; font-size:14px; }
      .hint { margin-top:12px; font-size:12px; color:#64748b; }
    </style>
  </head>
  <body>
    <form class="card" method="POST" action="/admin/login" autocomplete="off">
      <h1>Login Admin</h1>
      <label for="username">Username</label>
      <input id="username" name="username" required />
      <label for="password">Password</label>
      <input id="password" type="password" name="password" required />
      <button type="submit">Masuk</button>
      ${message ? `<div class="error">${sanitizeHtml(message)}</div>` : ''}
      <div class="hint">Akses admin khusus petugas klinik.</div>
    </form>
  </body>
</html>`;
}

function buildAdminDashboardPage() {
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Dashboard Admin Klinik</title>
    <style>
      body { font-family: Arial, sans-serif; margin:0; background:#f1f5f9; color:#0f172a; }
      .wrap { max-width:1100px; margin:24px auto; padding:0 16px; }
      .topbar { display:flex; justify-content:space-between; gap:12px; align-items:center; margin-bottom:16px; }
      .topbar h1 { margin:0; font-size:24px; }
      .controls { display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
      .card { background:#fff; border-radius:12px; box-shadow:0 3px 20px rgba(15,23,42,.08); padding:14px; }
      table { width:100%; border-collapse:collapse; font-size:14px; }
      th, td { border-bottom:1px solid #e2e8f0; text-align:left; padding:10px 8px; vertical-align:top; }
      th { background:#f8fafc; font-weight:700; color:#334155; }
      .status { display:inline-block; padding:4px 8px; border-radius:999px; font-size:12px; font-weight:700; }
      .registered { background:#e0f2fe; color:#075985; }
      .checked_in { background:#dcfce7; color:#166534; }
      button { border:none; border-radius:8px; padding:8px 10px; font-weight:700; cursor:pointer; }
      .btn-checkin { background:#0f766e; color:#fff; }
      .btn-refresh { background:#1d4ed8; color:#fff; }
      .muted { color:#64748b; }
      .msg { margin:8px 0 0; font-size:13px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="topbar">
        <h1>Dashboard Admin Klinik</h1>
        <form method="POST" action="/admin/logout">
          <button type="submit">Logout</button>
        </form>
      </div>
      <div class="card">
        <div class="controls">
          <label for="visitDate">Tanggal Kunjungan:</label>
          <input id="visitDate" type="date" />
          <button class="btn-refresh" id="btnRefresh" type="button">Muat Data</button>
          <span id="summary" class="muted"></span>
        </div>
        <div class="msg" id="message"></div>
        <div style="overflow:auto;">
          <table id="table">
            <thead>
              <tr>
                <th>No Antrean</th>
                <th>Nama</th>
                <th>No HP</th>
                <th>Email</th>
                <th>Keluhan</th>
                <th>Status</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>
    <script>
      const visitDateInput = document.getElementById('visitDate');
      const tbody = document.querySelector('#table tbody');
      const summary = document.getElementById('summary');
      const message = document.getElementById('message');
      const btnRefresh = document.getElementById('btnRefresh');

      function setMessage(text, isError = false) {
        message.textContent = text || '';
        message.style.color = isError ? '#b91c1c' : '#0f766e';
      }

      function getTodayYmd() {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
        const y = parts.find((p) => p.type === 'year').value;
        const m = parts.find((p) => p.type === 'month').value;
        const d = parts.find((p) => p.type === 'day').value;
        return y + '-' + m + '-' + d;
      }

      function escapeHtml(str) {
        return String(str || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      async function loadRegistrations() {
        const date = visitDateInput.value || getTodayYmd();
        setMessage('Memuat data...');
        const res = await fetch('/api/admin/registrations?date=' + encodeURIComponent(date));
        if (!res.ok) {
          if (res.status === 401) {
            window.location.href = '/admin/login';
            return;
          }
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Gagal memuat data');
        }
        const data = await res.json();
        tbody.innerHTML = '';

        for (const row of data.items) {
          const tr = document.createElement('tr');
          const statusClass = row.registrationStatus === 'checked_in' ? 'checked_in' : 'registered';
          tr.innerHTML = \`
            <td>\${row.queueNumber}</td>
            <td>\${escapeHtml(row.fullName)}</td>
            <td>\${escapeHtml(row.phone || '-')}</td>
            <td>\${escapeHtml(row.email || '-')}</td>
            <td>\${escapeHtml(row.complaint || '-')}</td>
            <td><span class="status \${statusClass}">\${row.registrationStatus === 'checked_in' ? 'Check-in' : 'Terdaftar'}</span></td>
            <td>\${row.registrationStatus === 'checked_in'
              ? '<span class="muted">Selesai</span>'
              : '<button class="btn-checkin" data-id="' + row.id + '">Check-in</button>'}</td>
          \`;
          tbody.appendChild(tr);
        }

        summary.textContent = 'Total: ' + data.items.length + ' pasien';
        setMessage('Data terbaru dimuat.');
      }

      tbody.addEventListener('click', async (event) => {
        const btn = event.target.closest('button[data-id]');
        if (!btn) return;
        const id = btn.getAttribute('data-id');
        btn.disabled = true;
        btn.textContent = 'Proses...';
        try {
          const res = await fetch('/api/admin/checkin/' + encodeURIComponent(id), { method: 'POST' });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || 'Gagal check-in');
          }
          setMessage('Pasien berhasil check-in.');
          await loadRegistrations();
        } catch (err) {
          setMessage(err.message || 'Gagal check-in', true);
        }
      });

      btnRefresh.addEventListener('click', () => {
        loadRegistrations().catch((err) => setMessage(err.message || 'Gagal memuat data', true));
      });

      visitDateInput.value = getTodayYmd();
      loadRegistrations().catch((err) => setMessage(err.message || 'Gagal memuat data', true));
    </script>
  </body>
</html>`;
}

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
    queueDate: data.queueDate || null,
    visitDate: data.visitDate || null,
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
    `Tanggal Kunjungan: ${formatDateId(data.visitDate)}`,
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

function normalizePhoneToWhatsapp(phone) {
  if (!phone) return null;
  const cleaned = String(phone).replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) {
    return cleaned.startsWith('+62') ? `whatsapp:${cleaned}` : null;
  }
  if (cleaned.startsWith('62')) return `whatsapp:+${cleaned}`;
  if (cleaned.startsWith('0')) return `whatsapp:+62${cleaned.slice(1)}`;
  return null;
}

async function sendWhatsAppMessage({ toPhone, message }) {
  if (!whatsappEnabled || !twilioClient) {
    return { skipped: true };
  }
  const to = normalizePhoneToWhatsapp(toPhone);
  if (!to) {
    throw new Error('Nomor WhatsApp tidak valid. Gunakan format Indonesia (+62 atau 08...).');
  }

  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to,
    body: message,
  });

  return { skipped: false };
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

app.get('/admin/login', (req, res) => {
  const session = getAdminSession(req);
  if (session) {
    return res.redirect('/admin');
  }
  const errorCode = String(req.query.error || '');
  return res.status(200).send(buildAdminLoginPage(errorCode));
});

app.post('/admin/login', (req, res) => {
  const usernameInput = String(req.body.username || '').trim();
  const passwordInput = String(req.body.password || '').trim();

  if (!usernameInput || !passwordInput) {
    return res.redirect('/admin/login?error=missing');
  }

  if (usernameInput !== adminUsername || passwordInput !== adminPassword) {
    return res.redirect('/admin/login?error=invalid');
  }

  const token = createAdminSession(usernameInput);
  setAdminSessionCookie(res, token);
  return res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => {
  const session = getAdminSession(req);
  if (session?.token) {
    adminSessions.delete(session.token);
  }
  clearAdminSessionCookie(res);
  return res.redirect('/admin/login');
});

app.get('/admin', requireAdminAuth, (req, res) => {
  return res.status(200).send(buildAdminDashboardPage());
});

app.get('/api/admin/registrations', requireAdminAuth, async (req, res) => {
  try {
    const selectedDate = String(req.query.date || getJakartaDate());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
      return res.status(400).json({ error: 'Format tanggal tidak valid (yyyy-mm-dd).' });
    }

    const result = await pool.query(
      `SELECT
        id,
        full_name,
        phone,
        email,
        complaint,
        queue_number,
        registration_status,
        visit_date,
        checked_in_at
      FROM registrations
      WHERE visit_date = $1
      ORDER BY queue_number ASC, created_at ASC`,
      [selectedDate]
    );

    return res.json({
      date: selectedDate,
      items: result.rows.map((row) => ({
        id: row.id,
        fullName: row.full_name,
        phone: row.phone,
        email: row.email,
        complaint: row.complaint,
        queueNumber: row.queue_number,
        registrationStatus: row.registration_status || 'registered',
        visitDate: row.visit_date,
        checkedInAt: row.checked_in_at,
      })),
    });
  } catch (error) {
    console.error('Admin list error:', error);
    return res.status(500).json({ error: 'Gagal memuat data pendaftaran.' });
  }
});

app.post('/api/admin/checkin/:id', requireAdminAuth, async (req, res) => {
  try {
    const registrationId = Number(req.params.id);
    if (!Number.isInteger(registrationId) || registrationId <= 0) {
      return res.status(400).json({ error: 'ID registrasi tidak valid.' });
    }

    const updateResult = await pool.query(
      `UPDATE registrations
       SET registration_status = 'checked_in',
           checked_in_at = NOW()
       WHERE id = $1
       RETURNING id, registration_status, checked_in_at`,
      [registrationId]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'Data pendaftaran tidak ditemukan.' });
    }

    return res.json({
      id: updateResult.rows[0].id,
      registrationStatus: updateResult.rows[0].registration_status,
      checkedInAt: updateResult.rows[0].checked_in_at,
    });
  } catch (error) {
    console.error('Admin check-in error:', error);
    return res.status(500).json({ error: 'Gagal melakukan check-in.' });
  }
});

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

    // Queue resets daily based on registration date (WIB, 24:00).
    const queueDate = jakartaToday;
    const targetVisitDate = parsedVisitDate || jakartaToday;

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
          queue_date,
          queue_number
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
          targetVisitDate,
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
          visitDate: targetVisitDate,
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
      const displayVisitDate = formatDateId(targetVisitDate);
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
        queueDate: targetVisitDate,
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

      if (whatsappEnabled) {
        setImmediate(async () => {
          try {
            await sendWhatsAppMessage({
              toPhone: phone,
              message:
                `Konfirmasi Pendaftaran Klinik\n\n` +
                `Nama: ${fullName}\n` +
                `Nomor antrean: ${queueNumber}\n` +
                `Tanggal kunjungan: ${displayVisitDate}\n` +
                `Unduh bukti: ${downloadUrl}`,
            });
          } catch (whatsappError) {
            console.error('WhatsApp send failed:', whatsappError);
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

ensureSchema()
  .then(() => {
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('ADMIN_PASSWORD belum di-set. Default password aktif, segera ganti di environment.');
    }
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize schema:', error);
    process.exit(1);
  });
